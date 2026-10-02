import { beforeAll, describe, expect, it } from 'vitest';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { createWorkPathBudget } from '../../src/core/agents/work-navigation';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { dispatchUnregisteredCommandV9 } from '../../src/core/kernel/commands-v9';
import { cloneJson } from '../../src/core/kernel/serialization';
import { advanceUnregisteredTicksV9 } from '../../src/core/kernel/simulation-v9';
import { captureSectHistoricalIdentitiesV10 } from '../../src/core/sect-expansion/history-identity';
import { applySectUpgradeCommandV10, applyValidatedSectUpgradeCommandV10, tickSectUpgradeV10, tickValidatedSectUpgradeV10 } from '../../src/core/sect-expansion/upgrade-runtime';
import { createSectUpgradeStateV10, validateSectUpgradeRecordsV10 } from '../../src/core/sect-expansion/upgrade-validation';
import { MANAGEMENT_V10_PROTOCOL, type WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { inspectV10LifecycleRecords } from '../../src/core/world/v10-lifecycle-records';
import { projectV10SectFrame, v10SectContext } from '../../src/core/world/v10-sect-frame';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixturePlace, fixtureStartConstruction, fixtureUntil, fundedRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

let source: WorldStateV9;
beforeAll(() => {
  source = fundedRuntimeFixture();
  // Explicit bounded birthday/material setup, as in the established lifecycle fixtures.
  // Construction, expiry, finalization, estate and retirement below all use real reducers.
  const actor = source.disciples.find(value => value.id === 'entity:2')!;
  const profile = source.cultivation.disciples.find(value => value.discipleId === actor.id)!;
  actor.birthCalendarTick = 600 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
  actor.ageMonths = Math.floor(-actor.birthCalendarTick / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
  source = fixtureStartConstruction(fixturePlace(recordChecked(source), 'library.v9', 1));
});
beforeAll(() => { source = fixtureUntil(source, world => world.sectExpansion.construction.jobs[0]!.terminal !== null); });
beforeAll(() => {
  source = advanceUnregisteredTicksV9(source, 600 - source.clock.simulationTick).world;
  const death = source.cultivation.pendingDeaths.find(value => value.discipleId === 'entity:2');
  expect(death).toBeDefined();
  const commandId = 'upgrade.retire.history-worker';
  const result = dispatchUnregisteredCommandV9(source, { kind: 'cultivation.command', commandId, sequence: 0, issuedTick: source.clock.simulationTick,
    payload: { command: { kind: 'death.finalize', commandId, expectedRevision: source.cultivation.revision,
      discipleId: 'entity:2', deathId: death!.deathId, cause: 'lifespan', acknowledgeDeath: true } } });
  expect(result.result.status).toBe('accepted'); source = recordChecked(result.world);
});

/** Only a new-version record fixture for these leaves, not a migration/admission routine. */
function v10Records(): WorldStateV10 {
  expect(source.sectExpansion.production.jobs).toEqual([]);
  expect(source.sectExpansion.construction.buildings.every(building => building.level === 1)).toBe(true);
  return { ...cloneJson(source), simulationVersion: '0.10.0', runtimeProtocol: MANAGEMENT_V10_PROTOCOL.runtimeProtocol,
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...cloneJson(source.sectExpansion), schemaVersion: 2,
      construction: { ...cloneJson(source.sectExpansion.construction), buildings: source.sectExpansion.construction.buildings.map(building => ({ ...cloneJson(building), level: 1 })) },
      production: { ...cloneJson(source.sectExpansion.production), jobs: [] }, upgrade: createSectUpgradeStateV10() } };
}

describe('root-authenticated upgrade stages preserve genuinely retired construction history', () => {
  it('accepts actual retired history with a genuine v10 historical source, but never accepts an arbitrary source', () => {
    const world = v10Records(); const frame = cloneJson(projectV10SectFrame(world)); const ctx = v10SectContext(world);
    expect(world.disciples.some(person => person.id === 'entity:2')).toBe(false);
    expect(frame.construction.jobs[0]).toMatchObject({ workerId: 'entity:2', terminal: { kind: 'completed' } });
    expect(validateSectUpgradeRecordsV10(frame).length).toBeGreaterThan(0);
    const identities = captureSectHistoricalIdentitiesV10(inspectV10LifecycleRecords(world), world);
    expect(validateSectUpgradeRecordsV10(frame, identities)).toEqual([]);
    expect(tickSectUpgradeV10(frame, ctx, createWorkPathBudget(ctx.simulationTick), identities)).toMatchObject({ ok: true });
    expect(tickSectUpgradeV10(frame, ctx, createWorkPathBudget(ctx.simulationTick))).toMatchObject({ ok: false, code: 'INVALID_FRAME' });
    expect(tickSectUpgradeV10(frame, ctx, createWorkPathBudget(ctx.simulationTick), {} as typeof identities)).toMatchObject({ ok: false, code: 'INVALID_FRAME' });
    // The root has authenticated source records above. Frozen stages do not run an incorrect
    // second historical check without that source; they still cannot upgrade a library.
    expect(tickValidatedSectUpgradeV10(frame, ctx, createWorkPathBudget(ctx.simulationTick))).toMatchObject({ ok: true });
    const command = { kind: 'upgrade.start' as const, commandId: 'upgrade.retired-history-target', expectedRevision: 0,
      buildingId: frame.construction.buildings[0]!.buildingId, workerId: 'entity:3' };
    expect(applyValidatedSectUpgradeCommandV10(frame, { ...ctx, paused: false }, command)).toMatchObject({ ok: false, code: 'UNSUPPORTED_UPGRADE' });
    expect(applySectUpgradeCommandV10(frame, { ...ctx, paused: false }, command, identities)).toMatchObject({ ok: false, code: 'UNSUPPORTED_UPGRADE' });
  });
});
