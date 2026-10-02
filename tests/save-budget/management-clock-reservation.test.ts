import { describe, expect, it } from 'vitest';
import { MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { cloneJson } from '../../src/core/kernel/serialization';
import { deriveWholeMonthManagementClockReservation, derivePhaseAwareManagementClockReservation } from '../../src/core/save-budget/management-clock-reservation';
import { deriveProgressionReservations } from '../../src/core/save-budget/progression-bounds';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { assessManagementCapacityV9, assessTeachingManagementCapacityV9 } from '../../src/core/world/management-capacity-v9';
import { deriveV9BuildObligationFacts } from '../../src/core/world/v9-record-headroom';
import { deriveV10BuildObligationFacts } from '../../src/core/world/v10-build-obligations';

describe('fixed structural clock arithmetic and pinned v10 build facts', () => {
  it('retains both old capacity wrapper results and does not change source', () => {
    const world = createUnregisteredWorldV9('shared-clock-capacity'); const before = cloneJson(world);
    const historical = assessManagementCapacityV9(world); const phase = assessTeachingManagementCapacityV9(world);
    expect(historical.progression).not.toBeNull(); expect(phase.progression).not.toBeNull();
    expect(deriveWholeMonthManagementClockReservation(world, historical.progression!)).toEqual(historical.clock);
    expect(derivePhaseAwareManagementClockReservation(world, phase.progression!)).toEqual(phase.clock);
    expect(world).toEqual(before);
  });
  it('keeps whole-month and finite phase-aware policies separate', () => {
    const world = createUnregisteredWorldV9('clock-arithmetic-only');
    const progression = deriveProgressionReservations({ world, buildFacts: deriveV9BuildObligationFacts(world) });
    // Synthetic sizing horizon only; no claimed accepted lesson or World transition.
    const partial = { ...progression, totals: { ...progression.totals, counterReserve: {
      ...progression.totals.counterReserve, calendarTicks: 1, calendarMonths: 0 } } };
    expect(deriveWholeMonthManagementClockReservation(world, partial).supported).toBe(false);
    expect(derivePhaseAwareManagementClockReservation(world, partial).supported).toBe(true);
    const invalid = { ...partial, supported: false };
    expect(derivePhaseAwareManagementClockReservation(world, invalid).supported).toBe(false);
  });
  it('uses unchanged permanent-build facts through a strict new identity binding', () => {
    const world = createUnregisteredWorldV9('v10-build-facts');
    const source = { contentIdentity: MANAGEMENT_V10_IDENTITY, builds: world.builds,
      cultivation: world.cultivation, legacy: world.legacy };
    const before = cloneJson(source);
    expect(deriveV10BuildObligationFacts(source)).toEqual(deriveV9BuildObligationFacts(world));
    expect(source).toEqual(before);
    expect(() => deriveV10BuildObligationFacts(world)).toThrow();
    expect(() => deriveV10BuildObligationFacts({ ...source, contentIdentity: {
      ...MANAGEMENT_V10_IDENTITY, compositeFingerprint: '00000000' } })).toThrow();
  });
});
