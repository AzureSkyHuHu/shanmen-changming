import { beforeAll, describe, expect, it } from 'vitest';
import { SECT_V9_CANDIDATE_IDENTITY } from '../../src/content/sect-v9/catalog';
import { MANAGEMENT_V9_IDENTITY } from '../../src/content/sect-v9/world-content';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { CALENDAR_TICKS_PER_MONTH, setPauseReason } from '../../src/core/kernel/clock';
import type { PlayerCultivationCommand } from '../../src/core/kernel/contracts';
import type { SaveMetadata } from '../../src/core/kernel/save';
import { createSaveEnvelopeV9, parseSaveV9, type SaveEnvelopeV9 } from '../../src/core/kernel/save-v9';
import { parseSaveV10, serializeSaveV10 } from '../../src/core/kernel/save-v10';
import { canonicalStringify, cloneJson, stableHash } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV9 } from '../../src/core/kernel/simulation-v9';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget';
import type { WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';
import { assessTeachingManagementCapacityV9 } from '../../src/core/world/management-capacity-v9';
import { prepareV9ToV10Migration } from '../../src/core/world/migrate-v9-to-v10';
import { admitSaveWorldV10 } from '../../src/core/world/save-admission-v10';
import { inspectQuietV9ToV10Boundary } from '../../src/core/world/v10-migration-boundary';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureApply, fixtureCareStart, fixtureCommand, fixturePlace, fixtureSectCommand, fixtureStartConstruction,
  fixtureUntil, fundedRuntimeFixture, medicineRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

const metadata = { buildId: 'pure-v10-preparation', savedAt: '2026-10-02T20:00:00Z' };
const oldMetadata = { buildId: 'old-v9-source', savedAt: '2026-10-02T19:00:00Z' };

/** Deliberate malformed/pressure input helper, not an admission. Positive inputs
 * below always establish that the unchanged parser accepts these exact bytes. */
function rawEnvelope(world: WorldStateV9): SaveEnvelopeV9 {
  const body = { saveVersion: 9 as const, simulationVersion: '0.9.0' as const,
    contentVersion: world.contentVersion, seed: world.seed, ...oldMetadata, payload: world };
  return { ...body, checksum: stableHash(body) };
}
function rawText(world: WorldStateV9): string { return canonicalStringify(rawEnvelope(world)); }
function sourceText(world: WorldStateV9): string {
  const envelope = createSaveEnvelopeV9(world, oldMetadata);
  // Reverse envelope field order and retain whitespace/newlines. The controller
  // must receive this exact source string, never the reserialized old envelope.
  const text = `\r\n  ${JSON.stringify(Object.fromEntries(Object.entries(envelope).reverse()), null, 2)}\t\n`;
  expect(parseSaveV9(text).ok).toBe(true); return text;
}
function prepared(world: WorldStateV9) {
  const before = canonicalStringify(world); const text = sourceText(world);
  const result = prepareV9ToV10Migration(text, metadata);
  expect(result.ok, JSON.stringify(result.ok ? null : result.issues)).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  expect(canonicalStringify(world)).toBe(before); expect(result.sourceText).toBe(text);
  expect(result.sourceChecksum).toBe(rawEnvelope(world).checksum);
  expect(result.world).not.toBe(world); expect(result.world.builds).not.toBe(world.builds);
  expect(result.world.history).not.toBe(world.history);
  expect(admitSaveWorldV10(result.world).ok).toBe(true);
  return result;
}
/** No allowlist pruning of histories: compare every old root/sect field and all
 * nested values after removing only the frozen identity/schema differences. */
function exactLift(source: WorldStateV9, target: WorldStateV10): void {
  const { simulationVersion: _sv9, runtimeProtocol: _rp9, contentVersion: _cv9,
    contentIdentity: _ci9, sectExpansion: sect9, ...unchanged9 } = source;
  const { simulationVersion: _sv10, runtimeProtocol: _rp10, contentVersion: _cv10,
    contentIdentity: _ci10, sectExpansion: sect10, ...unchanged10 } = target;
  expect(canonicalStringify(unchanged10)).toBe(canonicalStringify(unchanged9));
  const { schemaVersion: _schema9, ...domains9 } = sect9;
  const { schemaVersion: _schema10, upgrade, ...domains10 } = sect10;
  expect(canonicalStringify(domains10)).toBe(canonicalStringify(domains9));
  expect(Object.keys(target).sort()).toEqual(Object.keys(source).sort());
  expect(Object.keys(sect10).sort()).toEqual([...Object.keys(sect9), 'upgrade'].sort());
  expect(target).toMatchObject({ simulationVersion: '0.10.0', runtimeProtocol: 'management-v10-alchemy-upgrade.1',
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: MANAGEMENT_V10_IDENTITY });
  expect(sect10.schemaVersion).toBe(2);
  expect(upgrade).toEqual({ schemaVersion: 1, protocol: 'alchemy-l1-l2.1', catalogIdentity: SECT_V9_CANDIDATE_IDENTITY,
    revision: 0, nextId: 1, jobs: [], receipts: [] });
  expect(target.builds).toEqual(source.builds); expect(target.builds.contentIdentity).toEqual(MANAGEMENT_V9_IDENTITY);
}
function cultivation(world: WorldStateV9, command: PlayerCultivationCommand): WorldStateV9 {
  return fixtureApply(world, fixtureCommand(world, { kind: 'cultivation.command', payload: { command } }, command.commandId));
}

describe('fixed pure migration preparation and exact source preservation', () => {
  it('admits both identities independently and changes only the frozen whitelist', () => {
    const source = createUnregisteredWorldV9('migration-山门'); const result = prepared(source);
    exactLift(source, result.world); expect(result.envelope.payload).toEqual(result.world);
    expect(Object.keys(result).sort()).toEqual(['envelope', 'ok', 'sourceChecksum', 'sourceText', 'world']);
    expect(Object.keys(result.envelope).sort()).toEqual(['buildId', 'checksum', 'contentVersion', 'payload', 'saveVersion', 'savedAt', 'seed', 'simulationVersion']);
    expect(result.envelope).toMatchObject({ saveVersion: 10, ...metadata });
    const { checksum, ...body } = result.envelope; expect(checksum).toBe(stableHash(body));
    expect(result.sourceText).not.toBe(canonicalStringify(rawEnvelope(source)));
    expect(parseSaveV9(result.sourceText).ok).toBe(true);
    const roundtrip = parseSaveV10(serializeSaveV10(result.envelope));
    expect(roundtrip.ok).toBe(true); if (!roundtrip.ok) throw new Error(roundtrip.error.message);
    expect(roundtrip.world).toEqual(result.world); expect(roundtrip.migration).toBeNull();
    expect(parseSaveV9(serializeSaveV10(result.envelope))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION' } });
    expect(parseSaveV10(result.sourceText)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION' } });
  });

  it('keeps training/rest, independent enabled plans, review state, pause order and speed exactly', () => {
    let source = createUnregisteredWorldV9('migration-settings');
    source = fixtureApply(source, fixtureCommand(source, { kind: 'sect-economy.command', payload: { command: { kind: 'plan.set',
      plan: { workerId: 'entity:3', enabled: true, priorities: [{ recipeId: 'gather.wood', targetStock: 999 }] } } } }, 'migration.plan'));
    source = cultivation(source, { kind: 'training.set', commandId: 'migration.training', expectedRevision: source.cultivation.revision,
      discipleId: 'entity:2', mode: 'training' });
    source = cultivation(source, { kind: 'training.set', commandId: 'migration.rest', expectedRevision: source.cultivation.revision,
      discipleId: 'entity:4', mode: 'rest' });
    // Explicit legal settings, not manufactured work or rewards.
    source.automaticProduction.activationReviewRequired = true; source.sectEconomy.nextDecisionTick = 20;
    source.clock = { ...setPauseReason(setPauseReason(source.clock, 'hidden', true), 'player', true), speed: 3 };
    exactLift(source, prepared(source).world);
  });

  it('keeps real cancelled legacy history and changed permanent equipment/loadout history', () => {
    let source = createUnregisteredWorldV9('migration-history');
    const disciple = source.builds.disciples[0]!; const loadout = cloneJson(disciple.loadout);
    loadout.activeSkillIds = [loadout.activeSkillIds[1], loadout.activeSkillIds[0]];
    source = fixtureApply(source, fixtureCommand(source, { kind: 'build.command', payload: { command: { kind: 'loadout.set',
      commandId: 'migration.loadout', expectedRevision: source.builds.revision, discipleId: disciple.discipleId, loadout } } }, 'migration.loadout'));
    source = fixtureApply(source, fixtureCommand(source, { kind: 'production.start', payload: {
      recipeId: 'craft.plank', workerId: 'entity:2' } }, 'migration.legacy.start'));
    source = fixtureApply(source, fixtureCommand(source, { kind: 'production.cancel', payload: {
      transactionId: source.activeProductionTransactionIds[0]! } }, 'migration.legacy.cancel'));
    expect(source.history.production.count).toBe(1); expect(source.builds.history).toHaveLength(1);
    exactLift(source, prepared(source).world);
  });

  it('captures each request independently and never reuses a stale quiet approval', () => {
    const initial = createUnregisteredWorldV9('migration-stale'); const earlier = prepared(initial);
    const started = fixtureApply(initial, fixtureCommand(initial, { kind: 'production.start', payload: {
      recipeId: 'craft.plank', workerId: 'entity:2' } }, 'migration.new-work'));
    const result = prepareV9ToV10Migration(sourceText(started), metadata);
    expect(result).toMatchObject({ ok: false, issues: expect.arrayContaining([
      { code: 'ACTIVE_WORK', path: 'activeProductionTransactionIds[0]' },
    ]) });
    exactLift(initial, earlier.world); expect(earlier.world.activeProductionTransactionIds).toEqual([]);
    // Selecting the latest source bytes/session remains the controller's job.
    expect(prepareV9ToV10Migration(earlier.sourceText, metadata).ok).toBe(true);
  });

  it('does not let metadata change the World and detaches all caller-owned inputs', () => {
    const source = createUnregisteredWorldV9('migration-detached'); const text = sourceText(source); const meta = { ...metadata };
    const result = prepareV9ToV10Migration(text, meta); if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const original = canonicalStringify(result.world); source.inventory.wood.owned++; meta.buildId = 'changed';
    expect(canonicalStringify(result.world)).toBe(original); expect(result.envelope.buildId).toBe(metadata.buildId);
    expect(Object.isFrozen(source)).toBe(false); expect(result.world.inventory).not.toBe(source.inventory);
    const second = prepareV9ToV10Migration(text, { ...metadata, buildId: 'different-build', savedAt: 'later-display-label' });
    expect(second.ok).toBe(true); if (!second.ok) throw new Error('Expected second preparation');
    expect(second.world).toEqual(result.world); expect(second.envelope.checksum).not.toBe(result.envelope.checksum);
    expect(second.world).not.toBe(result.world); expect(second.world.history).not.toBe(result.world.history);
  });
});

let medicine: WorldStateV9; let careActive: WorldStateV9; let treated: WorldStateV9;
describe('genuine paid sect history, care and expired maintenance', () => {
  beforeAll(() => { medicine = medicineRuntimeFixture(); }, 120000);
  beforeAll(() => {
    careActive = fixtureCareStart(medicine, 'migration.care');
    treated = fixtureUntil(careActive, world => !!world.sectExpansion.care.jobs.at(-1)!.terminal);
  }, 120000);
  it('retains actual construction, research, delivered medicine and all paired ledgers', () => {
    expect(medicine.sectExpansion.construction.buildings).toHaveLength(2);
    expect(medicine.sectExpansion.research.jobs[0]!.terminal?.kind).toBe('completed');
    expect(medicine.sectExpansion.stock['wound-powder'].owned).toBe(1);
    exactLift(medicine, prepared(medicine).world);
  });
  it('refuses active care and then keeps its actual dose consumption/effect/clock source unchanged', () => {
    expect(prepareV9ToV10Migration(sourceText(careActive), metadata)).toMatchObject({ ok: false, issues: expect.arrayContaining([
      { code: 'ACTIVE_WORK', path: 'sectExpansion.care.jobs[0]' },
    ]) });
    expect(treated.sectExpansion.care.jobs[0]!.terminal?.effect).toMatchObject({ beforeInjury: 25, afterInjury: 5 });
    expect(treated.cultivationClock.transitions.length).toBeGreaterThan(0);
    exactLift(treated, prepared(treated).world);
  });
  it('keeps an expired building without prepayment, healing, due resets or new events', () => {
    let source = fixtureApply(treated, fixtureCommand(treated, { kind: 'inventory.discard', payload: {
      resourceId: 'wood', quantity: treated.inventory.wood.owned } }, 'migration.expire.wood'));
    const alchemy = source.sectExpansion.construction.buildings.find(building => building.definitionId === 'alchemy.v9')!;
    const last = source.sectExpansion.maintenance.payments.filter(payment => payment.buildingId === alchemy.buildingId).at(-1);
    const due = last?.dueCalendarTick ?? alchemy.firstMaintenanceCalendarTick;
    source = fixtureUntil(source, world => world.clock.calendarTick >= due);
    expect(source.inventory.wood.owned).toBe(0); exactLift(source, prepared(source).world);
  }, 120000);
});

describe('unchanged source admission, quiet gate and target admission are all mandatory', () => {
  it.each([7, 8, 10, 11])('rejects save version %s rather than guessing or downgrading', saveVersion => {
    const envelope = rawEnvelope(createUnregisteredWorldV9());
    expect(prepareV9ToV10Migration(JSON.stringify({ ...envelope, saveVersion }), metadata))
      .toEqual({ ok: false, issues: [{ code: 'UNSUPPORTED_SOURCE', path: 'saveVersion' }] });
  });
  it.each(['fresh-management-v9-unregistered.1', 'fresh-management-v9-unregistered.2'])('rejects experimental source %s', runtimeProtocol => {
    const source = Object.assign(createUnregisteredWorldV9(), { runtimeProtocol }) as WorldStateV9;
    expect(parseSaveV9(rawText(source))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SCOPE' } });
    expect(prepareV9ToV10Migration(rawText(source), metadata)).toEqual({ ok: false, issues: [{ code: 'UNSUPPORTED_SOURCE', path: '$' }] });
  });
  it('refuses stale checksums, wrong identities, pending queues and dangling claims without cleaning them', () => {
    const source = createUnregisteredWorldV9(); const stale = { ...rawEnvelope(source), seed: 'stale' };
    expect(prepareV9ToV10Migration(JSON.stringify(stale), metadata)).toEqual({ ok: false, issues: [{ code: 'INVALID_SOURCE', path: '$' }] });
    for (const corrupt of [
      (world: WorldStateV9) => { world.pendingCommands.push({ kind: 'production.start', commandId: 'queued', issuedTick: 0, sequence: 0,
        payload: { recipeId: 'craft.plank', workerId: 'entity:2' } }); },
      (world: WorldStateV9) => { world.disciples[1]!.assignmentTransactionId = 'instance:999'; },
      (world: WorldStateV9) => { world.buildings[0]!.stationTransactionId = 'instance:999'; },
      (world: WorldStateV9) => { world.inventory.wood.reserved = 1; },
      (world: WorldStateV9) => { world.expedition.routeId = 'route.qingfeng-trial'; },
    ]) {
      const invalid = createUnregisteredWorldV9(); corrupt(invalid); const text = rawText(invalid);
      expect(parseSaveV9(text)).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
      expect(prepareV9ToV10Migration(text, metadata)).toEqual({ ok: false, issues: [{ code: 'INVALID_SOURCE', path: '$' }] });
      expect(rawText(invalid)).toBe(text);
    }
    source.contentIdentity.compositeFingerprint = '00000000';
    expect(prepareV9ToV10Migration(rawText(source), metadata)).toEqual({ ok: false, issues: [{ code: 'UNSUPPORTED_SOURCE', path: 'contentIdentity' }] });
  });
  it('rejects planned construction and enabled scheduling without cancelling or disabling either', () => {
    const planned = fixturePlace(fundedRuntimeFixture(), 'library.v9', 1);
    const active = fixtureStartConstruction(planned);
    expect(prepareV9ToV10Migration(sourceText(planned), metadata)).toMatchObject({ ok: false, issues: [
      { code: 'PLANNED_BLUEPRINT', path: 'sectExpansion.construction.blueprints[0]' },
    ] });
    expect(prepareV9ToV10Migration(sourceText(active), metadata)).toMatchObject({ ok: false, issues: expect.arrayContaining([
      { code: 'ACTIVE_WORK', path: 'sectExpansion.construction.jobs[0]' },
    ]) });
    const enabled = fixtureApply(createUnregisteredWorldV9(), fixtureCommand(createUnregisteredWorldV9(), {
      kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: true } },
    }, 'migration.enable'));
    expect(prepareV9ToV10Migration(sourceText(enabled), metadata)).toEqual({ ok: false, issues: [
      { code: 'AUTOMATIC_WORK_ENABLED', path: 'sectEconomy.enabled' },
    ] });
    expect(planned.sectExpansion.construction.blueprints[0]!.status).toBe('planned'); expect(enabled.sectEconomy.enabled).toBe(true);
  });
  it('rejects a record-valid recovery-only source before the quiet gate can cancel a blueprint', () => {
    let source = fixturePlace(fundedRuntimeFixture(), 'library.v9', 1);
    source = { ...source, sectExpansion: { ...source.sectExpansion, construction: {
      ...source.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 1,
    } } };
    recordChecked(source); const text = rawText(source);
    expect(parseSaveV9(text)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SCOPE' } });
    expect(prepareV9ToV10Migration(text, metadata)).toEqual({ ok: false, issues: [{ code: 'UNSUPPORTED_SOURCE', path: '$' }] });
    expect(rawText(source)).toBe(text);
  });
  it('requires new target headroom even when an exactly funded quiet old save fits', () => {
    const source = createUnregisteredWorldV9('migration-target-capacity');
    // Intentional size-pressure fixture; padding is not alleged gameplay history.
    source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: '' });
    const before = assessTeachingManagementCapacityV9(source); expect(before.supported).toBe(true);
    source.diagnostics[0]!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES - before.costs.wireBytes!);
    recordChecked(source); const capacity = assessTeachingManagementCapacityV9(source);
    expect(capacity.fits).toBe(true); expect(capacity.costs.wireBytes).toBe(SAVE_FILE_LIMIT_BYTES);
    const text = rawText(source); expect(parseSaveV9(text).ok).toBe(true);
    const result = prepareV9ToV10Migration(text, metadata);
    expect(result.ok).toBe(false); if (result.ok) throw new Error('Target needs its own capacity proof');
    expect(result.issues[0]!.path).toBe('target'); expect(rawText(source)).toBe(text);
  }, 120000);
  it('runs the old parser before touching metadata and rejects unsafe metadata without invoking accessors', () => {
    let reads = 0; const getter = (): never => { reads++; throw new Error('Do not execute'); };
    const meta = Object.defineProperty({ ...metadata }, 'buildId', { enumerable: true, get: getter });
    expect(prepareV9ToV10Migration('{broken', meta)).toEqual({ ok: false, issues: [{ code: 'INVALID_SOURCE', path: '$' }] });
    const text = sourceText(createUnregisteredWorldV9());
    expect(prepareV9ToV10Migration(text, meta)).toEqual({ ok: false, issues: [{ code: 'INVALID_SOURCE', path: 'metadata' }] });
    const hostileError = new Proxy({}, { get: getter, getPrototypeOf: getter });
    const hostile = new Proxy({}, { ownKeys() { throw hostileError; } }) as SaveMetadata;
    expect(prepareV9ToV10Migration(text, hostile)).toEqual({ ok: false, issues: [{ code: 'INVALID_SOURCE', path: 'metadata' }] });
    expect(prepareV9ToV10Migration(text, { ...metadata, buildId: '' })).toEqual({ ok: false, issues: [{ code: 'INVALID_SOURCE', path: 'metadata' }] });
    expect(reads).toBe(0);
  });
});

describe('settled old lifecycle history and incompatible old journals', () => {
  let settled: WorldStateV9; let pending: WorldStateV9;
  beforeAll(() => {
    let source = fundedRuntimeFixture(); const actor = source.disciples[1]!; const profile = source.cultivation.disciples[1]!;
    // Explicit zero-history age boundary. Real old tick/commands create every
    // death cancellation, estate, archive and permanent-build retirement below.
    actor.birthCalendarTick = 1 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
    actor.ageMonths = Math.floor(-actor.birthCalendarTick / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    source = fixtureStartConstruction(fixturePlace(recordChecked(source), 'library.v9', 1));
    pending = recordChecked(prepareNormalTickCandidateV9(source)); const death = pending.cultivation.pendingDeaths[0]!;
    settled = cultivation(pending, { kind: 'death.finalize', commandId: 'migration.finalize', expectedRevision: pending.cultivation.revision,
      discipleId: death.discipleId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true });
  });
  it('rejects pending lifecycle then preserves real finalization, archives and system/v9 cancellation IDs', () => {
    const blocked = prepareV9ToV10Migration(sourceText(pending), metadata);
    expect(blocked).toMatchObject({ ok: false, issues: expect.arrayContaining([{ code: 'PENDING_LIFECYCLE', path: 'cultivation.pendingDeaths[0]' }]) });
    expect(settled.builds.retiredDisciples).toHaveLength(1); expect(settled.legacy.archivedIdentities).toHaveLength(1);
    expect(settled.sectExpansion.construction.receipts.at(-1)!.command.commandId).toMatch(/^system\/v9\/death\//);
    exactLift(settled, prepared(settled).world);
  });
  it.each(['system/v10/death/forged/job', 'system/unknown/death/job'])('rejects old-parser-accepted incompatible log %s without laundering it', commandId => {
    const source = { ...settled, sectExpansion: { ...settled.sectExpansion, construction: { ...settled.sectExpansion.construction,
      receipts: settled.sectExpansion.construction.receipts.map((receipt, index, receipts) => index === receipts.length - 1
        ? { ...receipt, command: { ...receipt.command, commandId } } : receipt),
    } } };
    const text = sourceText(source); expect(inspectQuietV9ToV10Boundary(source)).toEqual([]);
    expect(prepareV9ToV10Migration(text, metadata)).toEqual({ ok: false, issues: [{ code: 'UNSUPPORTED_SOURCE', path: 'target' }] });
    expect(source.sectExpansion.construction.receipts.at(-1)!.command.commandId).toBe(commandId);
    expect(parseSaveV9(text).ok).toBe(true);
  });
});

describe('fresh-only internal v10 bootstrap', () => {
  it.each(['fresh-v10-seed', 17])('is deterministic and fully admitted with seed %s', seed => {
    const source = createUnregisteredWorldV9(seed); const a = createUnregisteredWorldV10(seed); const b = createUnregisteredWorldV10(seed);
    exactLift(source, a); expect(a).toEqual(b); expect(a).not.toBe(b); expect(a.history).not.toBe(b.history);
    expect(admitSaveWorldV10(a).ok).toBe(true); expect(a.clock.simulationTick).toBe(0);
    expect(a.cultivation.disciples.find(profile => profile.discipleId === 'entity:4')!.injury).toBe(25);
  });
  it('uses the existing default seed and rejects an arbitrary World or hostile coercion argument', () => {
    exactLift(createUnregisteredWorldV9(), createUnregisteredWorldV10());
    expect(() => createUnregisteredWorldV10(createUnregisteredWorldV9() as unknown as string)).toThrow('string or number seed');
    let calls = 0; const hostile = { toString() { calls++; throw new Error('Must not coerce'); } };
    expect(() => createUnregisteredWorldV10(hostile as unknown as string)).toThrow('string or number seed'); expect(calls).toBe(0);
  });
});
