import { describe, expect, it } from 'vitest';
import { cloneJson } from '../../src/core/kernel/serialization';
import { dispatchUnregisteredCommandV9 } from '../../src/core/kernel/commands-v9';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { canonicalCultivationCommandsFromRecords, cultivationMonthTransitionFromRecords,
  inspectCultivationClockSourceRecords, inspectV9CultivationClockRecords,
  v9CanonicalCultivationCommands, v9CultivationMonthTransition } from '../../src/core/world/v9-cultivation-clock-records';

describe('unchanged cultivation clock structural record leaf', () => {
  it('preserves old command ownership and query results without mutating source', () => {
    const initial = createUnregisteredWorldV9('shared-clock-record-leaf');
    const result = dispatchUnregisteredCommandV9(initial, { kind: 'cultivation.command', commandId: 'shared.clock.rest',
      sequence: 0, issuedTick: 0, payload: { command: { kind: 'training.set', commandId: 'shared.clock.rest',
        expectedRevision: 0, discipleId: 'entity:1', mode: 'rest' } } });
    expect(result.result.status).toBe('accepted');
    const world = result.world; const before = cloneJson(world);
    expect(() => inspectV9CultivationClockRecords(world)).not.toThrow();
    expect(() => inspectCultivationClockSourceRecords(world)).not.toThrow();
    expect(canonicalCultivationCommandsFromRecords(world)).toEqual(v9CanonicalCultivationCommands(world));
    expect(cultivationMonthTransitionFromRecords(world, 1)).toEqual(v9CultivationMonthTransition(world, 1));
    expect(world).toEqual(before);
  });
  it('keeps exact old failure text for missing revision owners', () => {
    const forged = createUnregisteredWorldV9('shared-clock-invalid-revision'); forged.cultivation.revision = 1;
    const failure = (check: () => void): string => { try { check(); return 'accepted'; } catch (error) { return String(error); } };
    const old = failure(() => inspectV9CultivationClockRecords(forged));
    expect(old).toContain('revision gap or duplicate owner');
    expect(failure(() => inspectCultivationClockSourceRecords(forged))).toBe(old);
  });
  it('rejects accessor data before evaluating it in either entry', () => {
    const source = createUnregisteredWorldV9('shared-clock-accessor'); let reads = 0;
    Object.defineProperty(source, 'cultivationClock', { enumerable: true, get() { reads++; throw new Error('getter ran'); } });
    expect(() => inspectV9CultivationClockRecords(source)).toThrow();
    expect(() => inspectCultivationClockSourceRecords(source)).toThrow();
    expect(reads).toBe(0);
  });
});
