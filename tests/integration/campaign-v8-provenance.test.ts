import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createWorld } from '../../src/core/world/create-world';
import { allocateId } from '../../src/core/kernel/ids';
import { cloneJson } from '../../src/core/kernel/serialization';
import { migrateWorldV7ToV8 } from '../../src/core/kernel/migrate-v7';
import { validateWorldStateV8 } from '../../src/core/kernel/validation';
import { acknowledgeCampaignClaimV2, prepareCampaignClaimV2, validateCampaignStateV2 } from '../../src/core/campaign/v2';
import type { CampaignClaimRequestV2 } from '../../src/core/campaign/v2-types';
import { applyBuildAuthorityCommandV2, validateBuildFrameV2 } from '../../src/core/builds/v2';
import type { BuildAuthorityCommandV2, EquipmentOwner } from '../../src/core/builds/v2-types';
import { applyCultivationAuthorityCommandV3, applyCultivationCommandV3, validateCultivationFrameV3 } from '../../src/core/cultivation/v3';
import type { CultivationCommand } from '../../src/core/cultivation/v3';
import { copy } from '../../src/core/expeditions/shared';
import { validateWorldExpeditionV8 } from '../../src/core/expeditions/v8-world-validation';
import { getWorldBuildContentContext } from '../../src/core/world/content-access';
import { worldCampaignContext, projectWorldCampaign } from '../../src/core/world/campaign-queries';
import { validateWorldCampaign } from '../../src/core/world/validate-campaign';
import type { WorldStateV8 } from '../../src/core/world/v8-types';
import { RELEASE_V8_CANDIDATE } from '../../src/content/registry';

function migrated(filename = 'save-v7-ended-clear.json'): WorldStateV8 {
  return migrateWorldV7ToV8((JSON.parse(readFileSync(new URL(`./fixtures/${filename}`, import.meta.url), 'utf8')) as { payload: unknown }).payload);
}
type Body<T> = T extends T ? Omit<T, 'commandId' | 'expectedRevision'> : never;
function build(world: WorldStateV8, body: Body<BuildAuthorityCommandV2>): WorldStateV8 {
  const result = applyBuildAuthorityCommandV2({ builds: world.builds, sequences: world.sequences },
    { ...body, commandId: `proof/build/${world.builds.revision + 1}`, expectedRevision: world.builds.revision } as BuildAuthorityCommandV2,
    getWorldBuildContentContext(world)!);
  expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.code);
  return { ...world, builds: copy(result.frame.builds), sequences: copy(result.frame.sequences) };
}
function cultivate(world: WorldStateV8, body: Body<CultivationCommand>): WorldStateV8 {
  const result = applyCultivationCommandV3({ cultivation: world.cultivation, inventory: world.inventory, randomStreams: world.randomStreams, sequences: world.sequences },
    { ...body, commandId: `proof:culture:${world.cultivation.revision + 1}`, expectedRevision: world.cultivation.revision } as CultivationCommand);
  expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.code);
  return { ...world, ...result.frame };
}
/** A trusted domain death creates real lifecycle facts; the test then assembles
 * the proposed complete World estate boundary and probes its cross-domain proof. */
function die(world: WorldStateV8, discipleId: string): WorldStateV8 {
  const allocated = allocateId(world.sequences, 'instance');
  let next = cultivate({ ...world, sequences: allocated.sequences }, { kind: 'death.finalize', discipleId, deathId: allocated.id, cause: 'combat', acknowledgeDeath: true });
  const death = next.cultivation.deaths.find(entry => entry.deathId === allocated.id)!;
  next = { ...next, disciples: next.disciples.map(member => member.id === discipleId ? { ...member, lifeState: 'dead' as const, canWork: false } : member),
    legacy: { ...next.legacy, estates: [...next.legacy.estates, { estateId: `estate/${death.deathId}`, deathId: death.deathId, discipleId, beneficiaryId: death.beneficiaryId,
      itemInstanceIds: next.builds.equipment.filter(item => item.owner.kind === 'disciple' && item.owner.discipleId === discipleId).map(item => item.instanceId),
      pendingRunId: null, transferCommandIds: [], recordedMonth: death.month, settledMonth: null, settledOwner: null }] } };
  return next;
}
function settle(world: WorldStateV8, discipleId: string, owner: EquipmentOwner, transfer = true): WorldStateV8 {
  let next = cloneJson(world); const estate = next.legacy.estates.find(entry => entry.discipleId === discipleId)!;
  const actor = next.disciples.find(entry => entry.id === discipleId)!;
  const profile = next.cultivation.disciples.find(entry => entry.discipleId === discipleId)!;
  const school = next.builds.disciples.find(entry => entry.discipleId === discipleId)!.school;
  next = build(next, { kind: 'disciple.retire', discipleId, deathId: estate.deathId });
  const commandIds: string[] = [];
  if (transfer) for (const itemInstanceId of estate.itemInstanceIds) {
    next = build(next, { kind: 'equipment.transfer', itemInstanceId, transferId: `death/${estate.deathId}/${itemInstanceId}`,
      fromOwner: { kind: 'disciple', discipleId }, toOwner: owner, reason: { kind: 'death', deathId: estate.deathId } });
    commandIds.push(next.builds.history.at(-1)!.command.commandId);
  }
  const archived = applyCultivationAuthorityCommandV3({ cultivation: next.cultivation, inventory: next.inventory, randomStreams: next.randomStreams, sequences: next.sequences },
    { kind: 'disciple.archive', commandId: `proof/archive/${estate.deathId}`, expectedRevision: next.cultivation.revision, discipleId, deathId: estate.deathId });
  expect(archived.ok, JSON.stringify(archived)).toBe(true); if (!archived.ok) throw new Error(archived.code);
  next = { ...next, ...archived.frame, disciples: next.disciples.filter(member => member.id !== discipleId), legacy: { ...next.legacy,
    archivedIdentities: [...next.legacy.archivedIdentities, { discipleId, nameKey: actor.nameKey, presentationId: actor.presentationId,
      birthCalendarTick: actor.birthCalendarTick, ageMonths: profile.ageMonths, aptitude: profile.aptitude, school, realm: profile.realm, deathId: estate.deathId,
      archivedMonth: next.cultivation.calendarMonth }],
    estates: next.legacy.estates.map(entry => entry.deathId !== estate.deathId ? entry : { ...entry, itemInstanceIds: transfer ? entry.itemInstanceIds : [],
      transferCommandIds: commandIds, pendingRunId: null, settledMonth: next.cultivation.calendarMonth, settledOwner: owner }) } };
  validateBuildFrameV2({ builds: next.builds, sequences: next.sequences }, getWorldBuildContentContext(next)!);
  expect(validateCultivationFrameV3({ cultivation: next.cultivation, inventory: next.inventory, randomStreams: next.randomStreams, sequences: next.sequences })).toEqual([]);
  return next;
}

describe('v8 cross-domain proof rejection at the additive migration boundary', () => {
  it.each<CampaignClaimRequestV2>([
    { kind: 'equipment', routeId: 'route.qingfeng-trial', discipleId: 'entity:1' },
    { kind: 'lesson', knowledgeId: 'knowledge.clear-heart', discipleId: 'entity:3' },
    { kind: 'lesson', knowledgeId: 'knowledge.sun-piercing', discipleId: 'entity:1' },
    { kind: 'recruit', routeId: 'route.qingfeng-trial', school: 'body', discipleId: 'entity:1000' },
  ])('rejects domain-only claim acknowledgement without World payment and effects: $kind', request => {
    const world = migrated(); const before = cloneJson(world); const context = worldCampaignContext(world);
    const prepared = prepareCampaignClaimV2(world.campaign.progress, request, context);
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true); if (!prepared.ok) throw new Error(prepared.code);
    const plan = prepared.plan;
    const acknowledged = acknowledgeCampaignClaimV2(world.campaign.progress, plan, context, { kind: 'campaignEffectsCommitted', claimId: plan.claimId,
      planHash: plan.planHash, transactionId: `transaction/${plan.claimId}`, acquisitionIds: plan.grants.map(grant => grant.acquisitionId) });
    expect(acknowledged.ok).toBe(true); if (!acknowledged.ok) throw new Error(acknowledged.code);
    expect(validateCampaignStateV2(acknowledged.state)).toEqual([]);
    const forged = { ...world, campaign: { ...world.campaign, progress: copy(acknowledged.state) } };
    expect(validateWorldStateV8(forged)).toContain('Campaign claim lacks a defined World transaction proof');
    expect(forged.builds).toEqual(world.builds); expect(forged.inventory).toEqual(world.inventory); expect(forged.commandReceipts).toEqual(world.commandReceipts);
    expect(world).toEqual(before);
  });

  it('reads equipment presentation from the exact selected registry definition', () => {
    const claims = projectWorldCampaign(migrated()).equipmentClaims;
    expect(claims).toHaveLength(1);
    const definition = RELEASE_V8_CANDIDATE.buildRules.equipment.find(item => item.id === claims[0]!.definitionId)!;
    expect(claims[0]).toMatchObject({ definitionId: definition.id, nameKey: Reflect.get(definition, 'nameKey'), descriptionKey: Reflect.get(definition, 'descriptionKey') });
  });

  it('validates historical rows and paired content/protocol even without a current run', () => {
    const world = migrated('save-v7-active-automatic.json'); expect(world.expedition.run).toBeNull();
    const fake = { ...world, expedition: { ...world.expedition, history: [{ runId: 'run:fake', reason: 'victory', survivingDiscipleIds: ['entity:1'] }] } };
    expect(validateWorldStateV8(fake).length).toBeGreaterThan(0);
    const genuineHistory = migrated().expedition.history[0]!;
    const mismatched = { ...world, expedition: { ...world.expedition, history: [{ ...genuineHistory, endedCalendarTick: 0, protocol: 'release-v3' as const }] } };
    expect(validateWorldExpeditionV8(mismatched)).toContain('Invalid expedition history');
  });

  it('cannot mint first-victory points from an invented summary or a bare authority command', () => {
    let world = migrated('save-v7-active-automatic.json');
    world = build(world, { kind: 'milestone.award', discipleId: 'entity:1', ruleId: 'expedition.first-victory', milestoneId: 'milestone.first-expedition.entity-1' });
    expect(validateWorldCampaign(world)).toContain('First-victory award lacks a defined World settlement proof');
    const forged = { ...world, expedition: { ...world.expedition, history: [{ runId: 'run:fake', reason: 'victory', survivingDiscipleIds: ['entity:1'] }] } };
    expect(validateWorldStateV8(forged).length).toBeGreaterThan(0);
  });

  it.each(['missing', 'foreign', 'duplicate'] as const)('rejects %s runtime permanent source IDs', mode => {
    const world = migrated('save-v7-active-battle.json'); const before = cloneJson(world);
    expect(validateWorldStateV8(world)).toEqual([]);
    const battle = world.expedition.battle!; const index = battle.characterSourceBindings.findIndex(entry => entry.kind === 'installed');
    const original = battle.characterSourceBindings[index]!;
    const foreign = battle.characterSourceBindings.find(entry => entry.kind === 'installed' && entry.battleEntityId !== original.battleEntityId)!;
    battle.characterSourceBindings[index] = { ...original, battleSourceInstanceId: mode === 'missing' ? 'instance:999999' : foreign.battleSourceInstanceId };
    if (mode === 'duplicate') battle.characterSourceBindings.push({ ...battle.characterSourceBindings[index]! });
    expect(validateWorldStateV8(world)).toContain('Permanent source binding differs from admission proof');
    expect(world.expedition.battle!.controller).toEqual(before.expedition.battle!.controller);
  });

  it('rejects phantom run-source binding cardinality independently of the current controller', () => {
    const world = migrated('save-v7-active-battle.json'); const battle = world.expedition.battle!;
    expect(battle.sourceBindings).toEqual([]);
    battle.sourceBindings.push({ runTalentInstanceId: 'instance:123', battleSourceInstanceId: Object.keys(battle.controller.battle.sources)[0]! });
    expect(validateWorldStateV8(world)).toContain('Run source binding differs from admission proof');
  });

  it('rejects empty fake settlement that leaves acquired equipment owned by a retired disciple', () => {
    const world = settle(die(migrateWorldV7ToV8(createWorld('estate-empty-proof')), 'entity:1'), 'entity:1', { kind: 'sect-estate' }, false);
    expect(validateWorldCampaign(world)).toContain('Equipment remains owned by a retired identity');
  });

  it('rejects transfers to an unrelated living disciple despite internally valid build history', () => {
    let world = migrateWorldV7ToV8(createWorld('estate-wrong-heir'));
    world = cultivate(world, { kind: 'legacy.setHeir', discipleId: 'entity:1', heirId: 'entity:2' });
    world = settle(die(world, 'entity:1'), 'entity:1', { kind: 'disciple', discipleId: 'entity:3' });
    expect(validateWorldCampaign(world)).toContain('Estate recipient differs from committed eligible heir');
  });

  it('keeps a genuine historical inheritance valid after that heir dies and transfers the same items onward', () => {
    let world = migrateWorldV7ToV8(createWorld('estate-chain'));
    world = cultivate(world, { kind: 'legacy.setHeir', discipleId: 'entity:1', heirId: 'entity:2' });
    world = cultivate(world, { kind: 'legacy.setHeir', discipleId: 'entity:2', heirId: 'entity:3' });
    world = settle(die(world, 'entity:1'), 'entity:1', { kind: 'disciple', discipleId: 'entity:2' });
    expect(validateWorldCampaign(world)).toEqual([]);
    const inherited = world.legacy.estates[0]!.itemInstanceIds;
    world = settle(die(world, 'entity:2'), 'entity:2', { kind: 'disciple', discipleId: 'entity:3' });
    expect(validateWorldCampaign(world)).toEqual([]);
    expect(world.legacy.estates[0]!.settledOwner).toEqual({ kind: 'disciple', discipleId: 'entity:2' });
    expect(world.builds.equipment.filter(item => inherited.includes(item.instanceId)).every(item => item.owner.kind === 'disciple' && item.owner.discipleId === 'entity:3')).toBe(true);
    const omitted = cloneJson(world); omitted.legacy.estates[0]!.itemInstanceIds.pop(); omitted.legacy.estates[0]!.transferCommandIds.pop();
    expect(validateWorldCampaign(omitted).length).toBeGreaterThan(0);
  });
});
