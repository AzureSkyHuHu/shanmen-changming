import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAMPAIGN_RECRUITS, RECOVERY_RESOURCES } from '../../src/core/campaign/catalog';
import { validateCampaignStateV2 } from '../../src/core/campaign/v2';
import { applyBuildAuthorityCommandV2, validateBuildFrameV2 } from '../../src/core/builds/v2';
import type { BuildAuthorityCommandV2 } from '../../src/core/builds/v2-types';
import { applyCultivationAuthorityCommandV3, applyCultivationCommandV3, stepCultivationMonthsV3, validateCultivationFrameV3 } from '../../src/core/cultivation/v3';
import { RESOURCE_IDS, type ResourceLine } from '../../src/core/economy/types';
import { copy } from '../../src/core/expeditions/shared';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { allocateId } from '../../src/core/kernel/ids';
import { migrateWorldV7ToV8 } from '../../src/core/kernel/migrate-v7';
import { cloneJson } from '../../src/core/kernel/serialization';
import { prepareWorldCampaignCommit } from '../../src/core/world/campaign-grants';
import { previewWorldCampaign } from '../../src/core/world/campaign-queries';
import type { CampaignPlayerRequest, PlayerCampaignCommand } from '../../src/core/world/campaign-types';
import type { WorldCampaignCommitCandidate } from '../../src/core/world/campaign-transaction-types';
import { getWorldBuildContentContext } from '../../src/core/world/content-access';
import { createWorld } from '../../src/core/world/create-world';
import type { WorldStateV8 } from '../../src/core/world/v8-types';

/** Component integration only. The clear fixture is a real settled v7 World run,
 * and lifecycle fixtures execute genuine domain commands. This module deliberately
 * never publishes a World campaign event/receipt or claims complete live admission. */
function fresh(): WorldStateV8 { return migrateWorldV7ToV8(createWorld('campaign-grant-components')); }
function earned(): WorldStateV8 {
  const source: { payload: unknown } = JSON.parse(readFileSync(new URL('./fixtures/save-v7-ended-clear.json', import.meta.url), 'utf8'));
  return migrateWorldV7ToV8(source.payload);
}
function command(world: WorldStateV8, request: CampaignPlayerRequest, commandId = 'player:campaign'): PlayerCampaignCommand {
  return { ...request, commandId, expectedBasisStamp: previewWorldCampaign(world, request).basisStamp };
}
function success(result: WorldCampaignCommitCandidate): Extract<WorldCampaignCommitCandidate, { ok: true }> {
  expect(result.ok, JSON.stringify(result.ok ? result.result : result)).toBe(true);
  if (!result.ok) throw new Error(result.code); return result;
}
function commit(world: WorldStateV8, request: CampaignPlayerRequest) { return success(prepareWorldCampaignCommit(world, command(world, request))); }
type Body<T> = T extends T ? Omit<T, 'commandId' | 'expectedRevision'> : never;
function build(world: WorldStateV8, body: Body<BuildAuthorityCommandV2>): WorldStateV8 {
  const transition = applyBuildAuthorityCommandV2({ builds: world.builds, sequences: world.sequences },
    { ...body, commandId: `fixture/build/${world.builds.revision + 1}`, expectedRevision: world.builds.revision } as BuildAuthorityCommandV2,
    getWorldBuildContentContext(world)!);
  expect(transition.ok).toBe(true); if (!transition.ok) throw new Error(transition.code);
  return { ...world, builds: copy(transition.frame.builds), sequences: copy(transition.frame.sequences) };
}
function die(world: WorldStateV8, discipleId: string): WorldStateV8 {
  const death = allocateId(world.sequences, 'instance');
  const transition = applyCultivationCommandV3({ cultivation: world.cultivation, inventory: world.inventory,
    randomStreams: world.randomStreams, sequences: death.sequences }, { kind: 'death.finalize', discipleId,
    commandId: `fixture:death:${world.cultivation.revision + 1}`, expectedRevision: world.cultivation.revision,
    deathId: death.id, cause: 'combat', acknowledgeDeath: true });
  expect(transition.ok).toBe(true); if (!transition.ok) throw new Error(transition.code);
  return { ...world, ...transition.frame, disciples: world.disciples.map(member => member.id !== discipleId ? member
    : { ...member, lifeState: 'dead', canWork: false }) };
}
function lost(): WorldStateV8 {
  let world = fresh(); for (const member of [...world.disciples]) world = die(world, member.id); return world;
}
function estateWorld(): WorldStateV8 {
  let world = die(fresh(), 'entity:1'); const actor = world.disciples[0]!;
  const profile = world.cultivation.disciples.find(member => member.discipleId === actor.id)!;
  const items = world.builds.equipment.filter(item => item.owner.kind === 'disciple' && item.owner.discipleId === actor.id).map(item => item.instanceId);
  const death = world.cultivation.deaths.find(entry => entry.discipleId === actor.id)!;
  world = build(world, { kind: 'disciple.retire', discipleId: actor.id, deathId: death.deathId });
  const transferCommandIds: string[] = [];
  for (const itemInstanceId of items) {
    world = build(world, { kind: 'equipment.transfer', transferId: `death/${death.deathId}/${itemInstanceId}`, itemInstanceId,
      fromOwner: { kind: 'disciple', discipleId: actor.id }, toOwner: { kind: 'sect-estate' }, reason: { kind: 'death', deathId: death.deathId } });
    transferCommandIds.push(world.builds.history.at(-1)!.command.commandId);
  }
  const archived = applyCultivationAuthorityCommandV3({ cultivation: world.cultivation, inventory: world.inventory,
    randomStreams: world.randomStreams, sequences: world.sequences }, { kind: 'disciple.archive', commandId: 'fixture/archive/1',
    expectedRevision: world.cultivation.revision, discipleId: actor.id, deathId: death.deathId });
  expect(archived.ok).toBe(true); if (!archived.ok) throw new Error(archived.code);
  return { ...world, ...archived.frame, disciples: world.disciples.filter(member => member.id !== actor.id), legacy: {
    ...world.legacy, archivedIdentities: [{ discipleId: actor.id, nameKey: actor.nameKey, presentationId: actor.presentationId,
      birthCalendarTick: actor.birthCalendarTick, ageMonths: profile.ageMonths, aptitude: profile.aptitude, school: 'sword', realm: profile.realm,
      deathId: death.deathId, archivedMonth: world.cultivation.calendarMonth }],
    estates: [{ estateId: `estate/${death.deathId}`, deathId: death.deathId, discipleId: actor.id, beneficiaryId: null,
      itemInstanceIds: items, transferCommandIds, pendingRunId: null, recordedMonth: world.cultivation.calendarMonth,
      settledMonth: world.cultivation.calendarMonth, settledOwner: { kind: 'sect-estate' } }],
  } };
}
function assertConservation(before: WorldStateV8, prepared: Extract<WorldCampaignCommitCandidate, { ok: true }>) {
  const quantity = (lines: ResourceLine[], id: ResourceLine['resourceId']) => lines.filter(line => line.resourceId === id).reduce((sum, line) => sum + line.quantity, 0);
  for (const id of RESOURCE_IDS) {
    expect(prepared.candidate.inventory[id]).toEqual({ ...before.inventory[id],
      owned: before.inventory[id].owned - quantity(prepared.proof.payment.lines, id) + quantity(prepared.proof.creditedResources, id) });
  }
  expect(prepared.proof.payment).toMatchObject({ state: 'committed', ownerTransactionId: prepared.rootActionId,
    reservationId: `instance:${before.sequences.nextInstance}` });
  expect(prepared.rootActionId).toBe(`action:${before.sequences.nextAction}`);
  expect(prepared.proof.calendarTick).toBe(before.clock.calendarTick);
  expect(prepared.candidate.clock).toEqual(before.clock);
  expect(prepared.candidate.sequences.nextAction).toBe(before.sequences.nextAction + 1);
  expect(prepared.candidate.sequences.nextEvent).toBe(before.sequences.nextEvent);
  for (const key of ['reservations', 'transactions', 'commandReceipts', 'events', 'history', 'randomStreams'] as const) expect(prepared.candidate[key]).toEqual(before[key]);
  expect(validateCampaignStateV2(prepared.candidate.campaign.progress)).toEqual([]);
  validateBuildFrameV2({ builds: prepared.candidate.builds, sequences: prepared.candidate.sequences }, getWorldBuildContentContext(prepared.candidate)!);
  expect(validateCultivationFrameV3({ cultivation: prepared.candidate.cultivation, inventory: prepared.candidate.inventory,
    sequences: prepared.candidate.sequences, randomStreams: prepared.candidate.randomStreams })).toEqual([]);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** Exercise real global monthly cultivation aging; no campaign World publication
 * is fabricated just to run the separate candidate component through chronology. */
function assertNextMonthChronology(prepared: Extract<WorldCampaignCommitCandidate, { ok: true }>) {
  const world = prepared.candidate; const before = cloneJson(world);
  expect(prepared.proof.calendarTick).toBe(world.clock.calendarTick);
  expect(prepared.proof.calendarTick % CALENDAR_TICKS_PER_MONTH).toBe(30);
  const nextMonth = world.cultivation.calendarMonth + 1;
  const boundaryTick = nextMonth * CALENDAR_TICKS_PER_MONTH;
  const stepped = stepCultivationMonthsV3({ cultivation: world.cultivation, inventory: world.inventory,
    sequences: world.sequences, randomStreams: world.randomStreams }, 1);
  expect(stepped.processedMonths).toBe(1); expect(stepped.stopped).toBe('complete');
  expect(stepped.frame.cultivation.calendarMonth).toBe(nextMonth);
  for (const discipleId of prepared.result.discipleIds) {
    const actor = world.disciples.find(member => member.id === discipleId)!;
    const profile = stepped.frame.cultivation.disciples.find(member => member.discipleId === discipleId)!;
    expect(Math.abs(actor.birthCalendarTick % CALENDAR_TICKS_PER_MONTH)).toBe(0);
    expect(Math.floor((world.clock.calendarTick - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH)).toBe(actor.ageMonths);
    expect(Math.floor((boundaryTick - 1 - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH)).toBe(actor.ageMonths);
    expect(profile.ageMonths).toBe(actor.ageMonths + 1);
    expect(Math.floor((boundaryTick - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH)).toBe(profile.ageMonths);
    expect(Math.floor((boundaryTick + 30 - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH)).toBe(profile.ageMonths);
  }
  expect(validateCultivationFrameV3(stepped.frame)).toEqual([]); expect(world).toEqual(before);
}

describe('atomic isolated campaign grant preparation, before World admission', () => {
  it('uses a real route-earned equipment claim and an empty committed payment without equipping or publishing', () => {
    const world = freeze(earned()); const before = cloneJson(world);
    const prepared = commit(world, { kind: 'campaign.equipment.claim', routeId: 'route.qingfeng-trial', discipleId: 'entity:1' });
    expect(prepared.proof).toMatchObject({ commandId: 'player:campaign', claimId: 'campaign/equipment/route.qingfeng-trial',
      acquisitionIds: ['campaign/equipment/route.qingfeng-trial'], buildCommandIds: [`${prepared.rootActionId}/build/0`], cultivationCommandIds: [],
      payment: { lines: [] }, creditedResources: [] });
    expect(prepared.result).toEqual({ kind: 'campaign.equipment.claim', claimId: prepared.proof.claimId, discipleIds: ['entity:1'],
      itemInstanceIds: [`instance:${world.sequences.nextInstance + 1}`] });
    expect(prepared.candidate.builds.equipment.at(-1)).toMatchObject({ definitionId: 'equipment.trail-robe', owner: { kind: 'disciple', discipleId: 'entity:1' }, acquisitionId: prepared.proof.claimId });
    expect(prepared.candidate.builds.disciples).toEqual(world.builds.disciples);
    expect(prepared.candidate.campaign.progress.claims.at(-1)!.acknowledgement.transactionId).toBe(prepared.rootActionId);
    assertConservation(before, prepared); expect(world).toEqual(before);
  });

  it.each([
    ['knowledge.clear-heart', 'entity:3', 'skill.qingxin', 'herbs'],
    ['knowledge.sun-piercing', 'entity:1', 'skill.guanri-jianjue', 'stone'],
  ] as const)('learns route-earned %s in build and cultivation with one real payment', (knowledgeId, discipleId, skillId, resourceId) => {
    const world = earned(); const prepared = commit(world, { kind: 'campaign.lesson.learn', knowledgeId, discipleId });
    expect(prepared.proof.payment.lines).toEqual([{ resourceId, quantity: 2 }]);
    expect(prepared.proof.buildCommandIds).toEqual([`${prepared.rootActionId}/build/0`]);
    expect(prepared.proof.cultivationCommandIds).toEqual([`${prepared.rootActionId}/cultivation/0`]);
    expect(prepared.candidate.builds.disciples.find(member => member.discipleId === discipleId)!.learnedSkills.at(-1)).toEqual({
      skillId, origin: 'archive', creditCost: 0, acquisitionId: prepared.proof.claimId, provenance: { kind: 'archive', knowledgeId },
    });
    expect(prepared.candidate.cultivation.disciples.find(member => member.discipleId === discipleId)!.knowledge).toContainEqual({ knowledgeId, teacherId: null, teachingId: null });
    expect(prepared.candidate.builds.disciples.map(member => member.sources)).toEqual(world.builds.disciples.map(member => member.sources));
    assertConservation(world, prepared);
  });

  it.each(['sword', 'body', 'alchemy', 'talisman'] as const)('recruits fixed %s profile with only registered starter skills and globally owned sources', school => {
    const world = earned(); world.clock.calendarTick += 30; world.clock.simulationTick += 30;
    const request = { kind: 'campaign.recruit' as const, routeId: 'route.qingfeng-trial' as const, school };
    const before = cloneJson(world); const one = previewWorldCampaign(world, request); const two = previewWorldCampaign(world, request);
    expect(one).toEqual(two); expect(world).toEqual(before);
    const prepared = commit(world, request); const id = `entity:${world.sequences.nextEntity}`;
    const profile = CAMPAIGN_RECRUITS.find(entry => entry.school === school)!;
    const { school: _school, nameKey: _nameKey, ...cultivationProfile } = profile;
    const actor = prepared.candidate.disciples.find(member => member.id === id)!;
    const member = prepared.candidate.builds.disciples.find(entry => entry.discipleId === id)!;
    expect(prepared.candidate.cultivation.disciples.find(entry => entry.discipleId === id)).toMatchObject({ ...cultivationProfile,
      lifeState: 'alive', knowledge: [], talents: [], activityOwner: null, teaching: null, activeAttemptId: null });
    expect(actor).toMatchObject({ nameKey: profile.nameKey, aptitude: profile.aptitude, ageMonths: profile.ageMonths,
      birthCalendarTick: (world.cultivation.calendarMonth - profile.ageMonths) * CALENDAR_TICKS_PER_MONTH,
      presentationId: `disciple-${['sword', 'body', 'alchemy', 'talisman'].indexOf(school)}`, canWork: true, lifeState: 'alive' });
    expect(prepared.candidate.map.tiles.some(tile => tile.walkable && tile.x === actor.position.x && tile.y === actor.position.y)).toBe(true);
    expect(member.learnedSkills.map(skill => skill.skillId)).toEqual(getWorldBuildContentContext(world)!.rules.starterSkills[school]);
    expect(member.allocatedNodeIds).toEqual([]); expect(member.sources).toHaveLength(6); expect(prepared.result.itemInstanceIds).toHaveLength(3);
    expect(member.sources.every(source => source.sourceEntityId === id && source.lifecycleScope === 'character')).toBe(true);
    const instances = [...prepared.result.itemInstanceIds, ...member.sources.map(source => source.sourceInstanceId), prepared.proof.payment.reservationId];
    expect(new Set(instances).size).toBe(10);
    expect(instances.every(instanceId => Number(instanceId.split(':')[1]) >= world.sequences.nextInstance && Number(instanceId.split(':')[1]) < prepared.candidate.sequences.nextInstance)).toBe(true);
    expect(prepared.candidate.sequences.nextEntity).toBe(world.sequences.nextEntity + 1);
    expect(prepared.proof.payment.lines).toEqual([{ resourceId: 'meal', quantity: 4 }]);
    expect(prepared.proof.acquisitionIds).toEqual(['campaign/recruit/route.qingfeng-trial']);
    expect(commit(world, request)).toEqual(prepared); assertConservation(world, prepared); assertNextMonthChronology(prepared); expect(world).toEqual(before);
  });

  it('standard relief uses exactly eight meals after genuine finalized deaths leave one living member', () => {
    let world = fresh(); for (const id of ['entity:2', 'entity:3', 'entity:4']) world = die(world, id);
    const prepared = commit(world, { kind: 'campaign.relief', school: 'talisman' });
    expect(prepared.proof.payment.lines).toEqual([{ resourceId: 'meal', quantity: 8 }]);
    expect(prepared.proof.claimId).toBe('campaign/relief/1'); expect(prepared.result.discipleIds).toEqual([`entity:${world.sequences.nextEntity}`]);
    expect(prepared.candidate.campaign.progress.claims.at(-1)!.plan.relief).toMatchObject({ survivorId: 'entity:1', ordinal: 1 });
    assertConservation(world, prepared);
  });

  it('recovery enrolls two fresh identities in order and credits supplies without retiring or archiving the deceased', () => {
    const world = lost(); world.clock.calendarTick += 30; world.clock.simulationTick += 30;
    const prepared = commit(world, { kind: 'campaign.recover', acknowledgeLoss: true });
    expect(prepared.result.discipleIds).toEqual([`entity:${world.sequences.nextEntity}`, `entity:${world.sequences.nextEntity + 1}`]);
    expect(prepared.result.itemInstanceIds).toHaveLength(6); expect(prepared.proof.payment.lines).toEqual([]);
    expect(prepared.proof.creditedResources).toEqual(RECOVERY_RESOURCES);
    expect(prepared.proof.acquisitionIds).toEqual(['campaign/recovery/1/disciple/1', 'campaign/recovery/1/disciple/2', 'campaign/recovery/1/supplies']);
    expect(prepared.proof.buildCommandIds).toEqual([`${prepared.rootActionId}/build/0`, `${prepared.rootActionId}/build/1`]);
    expect(prepared.proof.cultivationCommandIds).toEqual([`${prepared.rootActionId}/cultivation/0`, `${prepared.rootActionId}/cultivation/1`]);
    expect(prepared.candidate.disciples.slice(0, world.disciples.length)).toEqual(world.disciples);
    expect(prepared.candidate.cultivation.deaths).toEqual(world.cultivation.deaths);
    expect(prepared.candidate.cultivation.archivedDisciples).toEqual(world.cultivation.archivedDisciples);
    expect(prepared.candidate.builds.retiredDisciples).toEqual(world.builds.retiredDisciples);
    expect(prepared.candidate.legacy).toEqual(world.legacy); assertConservation(world, prepared); assertNextMonthChronology(prepared);
  });

  it('assigns exactly one settled estate item to an alive locked recipient without touching loadout, sources, or lock', () => {
    let world = estateWorld(); world = build(world, { kind: 'expedition.lock', runId: 'fixture:away', locks: [{ discipleId: 'entity:2', lockId: 'fixture:lock' }] });
    world.cultivation.disciples.find(member => member.discipleId === 'entity:2')!.activityOwner = { kind: 'expedition', runId: 'fixture:away', lockId: 'fixture:lock' };
    const itemInstanceId = world.legacy.estates[0]!.itemInstanceIds[0]!;
    const prepared = commit(world, { kind: 'estate.assign', itemInstanceId, discipleId: 'entity:2' });
    expect(prepared.proof).toMatchObject({ claimId: null, acquisitionIds: [], cultivationCommandIds: [], payment: { lines: [] } });
    expect(prepared.candidate.builds.history.at(-1)!.command).toMatchObject({ kind: 'equipment.transfer',
      reason: { kind: 'estate-assignment', assignmentId: prepared.rootActionId } });
    expect(prepared.candidate.builds.equipment.find(item => item.instanceId === itemInstanceId)!.owner).toEqual({ kind: 'disciple', discipleId: 'entity:2' });
    expect(prepared.candidate.builds.equipment.filter(item => item.instanceId !== itemInstanceId)).toEqual(world.builds.equipment.filter(item => item.instanceId !== itemInstanceId));
    expect(prepared.candidate.builds.disciples).toEqual(world.builds.disciples);
    expect(prepared.candidate.legacy).toEqual(world.legacy); expect(prepared.candidate.campaign).toEqual(world.campaign);
    assertConservation(world, prepared);
    expect(prepareWorldCampaignCommit(prepared.candidate, command(prepared.candidate, { kind: 'estate.assign', itemInstanceId, discipleId: 'entity:3' }))).toEqual({ ok: false, code: 'ITEM_UNAVAILABLE' });
  });

  it.each(['campaign.equipment.claim', 'campaign.lesson.learn'] as const)('rejects locked recipients for personal %s', kind => {
    const world = build(earned(), { kind: 'expedition.lock', runId: 'fixture:away', locks: [{ discipleId: 'entity:1', lockId: 'fixture:lock' }] });
    const request: CampaignPlayerRequest = kind === 'campaign.equipment.claim' ? { kind, routeId: 'route.qingfeng-trial', discipleId: 'entity:1' }
      : { kind, knowledgeId: 'knowledge.sun-piercing', discipleId: 'entity:1' };
    const before = cloneJson(world); expect(prepareWorldCampaignCommit(world, command(world, request))).toEqual({ ok: false, code: 'DISCIPLE_UNAVAILABLE' }); expect(world).toEqual(before);
  });

  it('rejects mismatched request-specific stamps and stale resources without consuming IDs', () => {
    const world = earned(); const request = { kind: 'campaign.equipment.claim' as const, routeId: 'route.qingfeng-trial' as const, discipleId: 'entity:1' };
    const old = command(world, request); const before = cloneJson(world);
    expect(prepareWorldCampaignCommit(world, { ...old, discipleId: 'entity:2' } as unknown as PlayerCampaignCommand)).toEqual({ ok: false, code: 'PREVIEW_STALE' });
    world.inventory.meal.owned--;
    expect(prepareWorldCampaignCommit(world, old)).toEqual({ ok: false, code: 'PREVIEW_STALE' });
    expect(world.sequences).toEqual(before.sequences); expect(world.campaign).toEqual(before.campaign);
  });

  it('does not spend existing reservations and rejects genuine insufficient available resources', () => {
    const world = earned(); world.inventory.meal.reserved = world.inventory.meal.owned;
    const before = cloneJson(world); const request = { kind: 'campaign.recruit' as const, routeId: 'route.qingfeng-trial' as const, school: 'body' as const };
    expect(prepareWorldCampaignCommit(world, command(world, request))).toEqual({ ok: false, code: 'INSUFFICIENT_RESOURCES' }); expect(world).toEqual(before);
    world.inventory.meal.owned = 12; world.inventory.meal.reserved = 3;
    const prepared = commit(world, request); expect(prepared.candidate.inventory.meal).toMatchObject({ owned: 8, reserved: 3 }); assertConservation(world, prepared);
  });

  it('rolls back every recruit and ID when the late recovery resource credit exceeds physical capacity', () => {
    const world = lost(); world.inventory.grain.capacity = world.inventory.grain.owned;
    const before = cloneJson(world); const request = { kind: 'campaign.recover' as const, acknowledgeLoss: true as const };
    expect(prepareWorldCampaignCommit(world, command(world, request))).toEqual({ ok: false, code: 'INVENTORY_FULL' }); expect(world).toEqual(before);
    world.inventory.grain.capacity += 8;
    const prepared = commit(world, request); expect(prepared.rootActionId).toBe(`action:${before.sequences.nextAction}`);
    expect(prepared.result.discipleIds[0]).toBe(`entity:${before.sequences.nextEntity}`); assertConservation(world, prepared);
  });

  it('rolls back a first successful recruit when later source allocation overflows', () => {
    const world = lost(); world.sequences.nextInstance = Number.MAX_SAFE_INTEGER - 12;
    const before = cloneJson(world); const request = { kind: 'campaign.recover' as const, acknowledgeLoss: true as const };
    expect(prepareWorldCampaignCommit(world, command(world, request))).toEqual({ ok: false, code: 'OVERFLOW' }); expect(world).toEqual(before);
  });

  it('rolls back payment and learned build skill when later cultivation authority rejects an already-owned manual', () => {
    let world = earned(); const acquisitionId = 'campaign/lesson/knowledge.clear-heart/entity:3';
    // Valid cultivation-only component fact, deliberately lacking its build side.
    const grant = applyCultivationAuthorityCommandV3({ cultivation: world.cultivation, inventory: world.inventory,
      randomStreams: world.randomStreams, sequences: world.sequences }, { kind: 'knowledge.grant', commandId: 'fixture/manual',
      expectedRevision: world.cultivation.revision, discipleId: 'entity:3', knowledgeId: 'knowledge.clear-heart', claimId: acquisitionId, acquisitionId });
    expect(grant.ok).toBe(true); if (!grant.ok) throw new Error(grant.code); world = { ...world, ...grant.frame };
    const before = cloneJson(world); const request = { kind: 'campaign.lesson.learn' as const, knowledgeId: 'knowledge.clear-heart', discipleId: 'entity:3' };
    expect(prepareWorldCampaignCommit(world, command(world, request))).toEqual({ ok: false, code: 'CULTIVATION_REJECTED' }); expect(world).toEqual(before);
  });

  it('rejects malformed input and accessor payloads without invoking them or changing authority', () => {
    const world = earned(); const before = cloneJson(world); let reads = 0;
    const request = command(world, { kind: 'campaign.recruit', routeId: 'route.qingfeng-trial', school: 'sword' });
    const accessor = { ...request }; Object.defineProperty(accessor, 'school', { enumerable: true, get: () => { reads++; return 'sword'; } });
    for (const invalid of [null, {}, { ...request, extra: true }, { ...request, expectedBasisStamp: 'stale' }, { ...request, commandId: '__proto__' }, accessor,
      { ...request, profile: CAMPAIGN_RECRUITS[0] }, { ...request, kind: 'campaign.recover', acknowledgeLoss: false }]) {
      expect(prepareWorldCampaignCommit(world, invalid as PlayerCampaignCommand)).toEqual({ ok: false, code: 'INVALID_COMMAND' });
    }
    expect(reads).toBe(0); expect(world).toEqual(before);
    const badWorld = { ...world }; Object.defineProperty(badWorld, 'inventory', { enumerable: true, get: () => { reads++; return world.inventory; } });
    expect(prepareWorldCampaignCommit(badWorld, request)).toEqual({ ok: false, code: 'INVALID_STATE' }); expect(reads).toBe(0);
  });

  it('rejects blocked decisions and missing walkable recruitment spawns without partial candidates', () => {
    const world = earned(); const request = { kind: 'campaign.recruit' as const, routeId: 'route.qingfeng-trial' as const, school: 'sword' as const };
    world.clock.mode = 'combat'; const before = cloneJson(world);
    expect(prepareWorldCampaignCommit(world, command(world, request))).toEqual({ ok: false, code: 'BLOCKED_BY_DECISION' }); expect(world).toEqual(before);
    world.clock.mode = 'management'; world.map.tiles.forEach(tile => { tile.walkable = false; });
    const blocked = cloneJson(world); expect(prepareWorldCampaignCommit(world, command(world, request))).toEqual({ ok: false, code: 'INVALID_STATE' }); expect(world).toEqual(blocked);
  });

  it('preserves authenticated immutable history sharing while detaching every mutable candidate branch', () => {
    const world = earned(); const before = cloneJson(world);
    const prepared = commit(world, { kind: 'campaign.lesson.learn', knowledgeId: 'knowledge.clear-heart', discipleId: 'entity:3' });
    expect(prepared.candidate.history).toBe(world.history); expect(Object.isFrozen(prepared.candidate.history)).toBe(true);
    expect(prepared.candidate.inventory).not.toBe(world.inventory); expect(prepared.candidate.map).not.toBe(world.map);
    expect(prepared.candidate.campaign.clearEvidence).not.toBe(world.campaign.clearEvidence);
    prepared.candidate.inventory.herbs.owned = 0; prepared.candidate.map.tiles[0]!.walkable = false;
    prepared.proof.payment.lines[0]!.quantity = 100;
    expect(world).toEqual(before);
  });

  it('accepts a World-sized legal map above the expedition JSON array limit and spawns deterministically', () => {
    const world = earned(); world.map.width = 128; world.map.height = 80;
    world.map.tiles = Array.from({ length: world.map.width * world.map.height }, (_, index) => ({
      x: index % world.map.width, y: Math.floor(index / world.map.width), terrain: 'grass', walkable: true,
    }));
    expect(world.map.tiles.length).toBeGreaterThan(8192);
    const request = { kind: 'campaign.recruit' as const, routeId: 'route.qingfeng-trial' as const, school: 'sword' as const };
    const prepared = commit(world, request); const reordered = cloneJson(world); reordered.map.tiles.reverse();
    const again = commit(reordered, request);
    expect(prepared.candidate.disciples.at(-1)!.position).toEqual(again.candidate.disciples.at(-1)!.position);
    expect(prepared.candidate.map.tiles).toEqual(world.map.tiles); assertConservation(world, prepared);
  });
});
