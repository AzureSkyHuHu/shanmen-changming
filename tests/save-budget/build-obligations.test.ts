import { describe, expect, test } from 'vitest';
import { assessBuildHistoryObligations, type BuildHistoryObligationFacts } from '../../src/core/save-budget/build-obligations';

type Member = BuildHistoryObligationFacts['disciples'][number];
const member = (discipleId: string, heirId: string | null = null, lifeState: Member['lifeState'] = 'alive'): Member => ({ discipleId, heirId, lifeState });
const item = (itemInstanceId: string, ownerDiscipleId: string | null) => ({ itemInstanceId, ownerDiscipleId });
function facts(overrides: Partial<BuildHistoryObligationFacts> = {}): BuildHistoryObligationFacts {
  return { historyCount: 0, maximumCommands: 1024, disciples: [], retiredDiscipleIds: [], equipment: [], pendingEstates: [],
    teachingIds: [], realmMilestoneIds: [], activeRun: null, ...overrides };
}
function starter(overrides: Partial<BuildHistoryObligationFacts> = {}): BuildHistoryObligationFacts {
  const disciples = Array.from({ length: 4 }, (_, index) => member(`entity:${index + 1}`));
  return facts({ disciples, equipment: disciples.flatMap((owner, index) => Array.from({ length: 3 }, (_, slot) => item(`instance:${index * 3 + slot + 1}`, owner.discipleId))), ...overrides });
}
function assessUnknown(value: unknown) { return assessBuildHistoryObligations(value as BuildHistoryObligationFacts); }
/** Model only the agreed atomic retire/transfer effects, without calling World reducers. */
function retire(source: BuildHistoryObligationFacts, discipleId: string): BuildHistoryObligationFacts {
  const deceased = source.disciples.find(entry => entry.discipleId === discipleId)!;
  const promised = source.pendingEstates.find(entry => entry.discipleId === discipleId);
  const beneficiaryId = promised ? promised.beneficiaryId : deceased.heirId;
  const recipient = source.disciples.find(entry => entry.discipleId === beneficiaryId && entry.lifeState === 'alive');
  const transferred = source.equipment.filter(entry => entry.ownerDiscipleId === discipleId).length;
  return { ...source, historyCount: source.historyCount + 1 + transferred,
    disciples: source.disciples.filter(entry => entry.discipleId !== discipleId).map(entry => entry.heirId === discipleId ? { ...entry, heirId: null } : entry),
    retiredDiscipleIds: [...source.retiredDiscipleIds, discipleId],
    equipment: source.equipment.map(entry => entry.ownerDiscipleId === discipleId ? { ...entry, ownerDiscipleId: recipient?.discipleId ?? null } : entry),
    pendingEstates: source.pendingEstates.filter(entry => entry.discipleId !== discipleId) };
}
function permutations<T>(values: readonly T[]): T[][] {
  return values.length === 0 ? [[]] : values.flatMap((value, index) => permutations(values.filter((_, other) => other !== index)).map(tail => [value, ...tail]));
}

describe('build history commitments', () => {
  test('empty and original four-person worlds remain admissible without counting the coarse bound twice', () => {
    expect(assessBuildHistoryObligations(facts())).toMatchObject({ remainingCommands: 1024, reservedCommands: 0, availableCommands: 1024, fits: true });
    const result = assessBuildHistoryObligations(starter());
    expect(result).toEqual({ historyCount: 0, maximumCommands: 1024, remainingCommands: 1024, reservedCommands: 16, availableCommands: 1008, fits: true,
      breakdown: { retirements: 4, transfers: 12, teachingGrants: 0, realmAwards: 0, runUnlocks: 0, firstVictoryAwards: 0 } });
    expect(result.reservedCommands).toBeLessThan(4 + 12 * 4);
  });

  test('all commitments fit at equality, and a new ledger row cannot spend the last reserved slot', () => {
    const before = starter({ historyCount: 1008 });
    expect(assessBuildHistoryObligations(before)).toMatchObject({ remainingCommands: 16, reservedCommands: 16, availableCommands: 0, fits: true });
    expect(assessBuildHistoryObligations({ ...before, historyCount: 1009 })).toMatchObject({ availableCommands: -1, fits: false });
    const released = retire(before, 'entity:1');
    expect(assessBuildHistoryObligations(released)).toMatchObject({ historyCount: 1012, reservedCommands: 12, availableCommands: 0, fits: true });
  });

  test('an heir edit needs readmission and a real heir transfer still preserves its later death obligation', () => {
    const before = starter({ historyCount: 1008 });
    const withHeir = { ...before, disciples: before.disciples.map(entry => entry.discipleId === 'entity:1' ? { ...entry, heirId: 'entity:2' } : entry) };
    expect(assessBuildHistoryObligations(withHeir)).toMatchObject({ reservedCommands: 19, availableCommands: -3, fits: false });
    const funded = { ...withHeir, historyCount: 1005 };
    expect(assessBuildHistoryObligations(funded).fits).toBe(true);
    const after = retire(funded, 'entity:1');
    expect(after.equipment.filter(entry => entry.ownerDiscipleId === 'entity:2')).toHaveLength(6);
    expect(assessBuildHistoryObligations(after)).toMatchObject({ historyCount: 1009, reservedCommands: 15, availableCommands: 0, fits: true });
  });

  test('the longest 36-owner chain and 512 items attain D + E*D rather than silently relaxing 1024', () => {
    const disciples = Array.from({ length: 36 }, (_, index) => member(`entity:${index + 1}`, index < 35 ? `entity:${index + 2}` : null));
    const equipment = Array.from({ length: 512 }, (_, index) => item(`instance:${index + 1}`, 'entity:1'));
    const result = assessBuildHistoryObligations(facts({ disciples, equipment }));
    expect(result.breakdown).toMatchObject({ retirements: 36, transfers: 512 * 36 });
    expect(result).toMatchObject({ reservedCommands: 18468, availableCommands: 1024 - 18468, fits: false });
    const noHeirs = assessBuildHistoryObligations(facts({ disciples: disciples.map(entry => ({ ...entry, heirId: null })), equipment }));
    expect(noHeirs).toMatchObject({ reservedCommands: 548, availableCommands: 476, fits: true });
  });

  test('cycles charge each possible owner once, without an infinite traversal', () => {
    const source = facts({ disciples: [member('entity:1', 'entity:2'), member('entity:2', 'entity:1')], equipment: [item('instance:1', 'entity:1')] });
    expect(assessBuildHistoryObligations(source).reservedCommands).toBe(4);
    const first = retire(source, 'entity:1');
    expect(assessBuildHistoryObligations(first)).toMatchObject({ historyCount: 2, reservedCommands: 2 });
    expect(assessBuildHistoryObligations(retire(first, 'entity:2'))).toMatchObject({ historyCount: 4, reservedCommands: 0 });
  });

  test.each(['pendingDeath', 'dead', 'retired'] as const)('known %s recipients terminate at the estate, without relaying through their heirs', (state) => {
    const disciples = [member('entity:1', 'entity:2'), member('entity:3')];
    if (state !== 'retired') disciples.push(member('entity:2', 'entity:3', state));
    const source = facts({ disciples, retiredDiscipleIds: state === 'retired' ? ['entity:2'] : [],
      equipment: [item('instance:1', 'entity:1')], pendingEstates: state === 'dead' ? [{ discipleId: 'entity:2', beneficiaryId: 'entity:3' }] : [] });
    expect(assessBuildHistoryObligations(source).breakdown.transfers).toBe(1);
  });

  test('pending estates preserve their committed beneficiary instead of using a changed or cleared heir field', () => {
    const source = facts({ disciples: [member('entity:1', null, 'dead'), member('entity:2', 'entity:3'), member('entity:3')],
      pendingEstates: [{ discipleId: 'entity:1', beneficiaryId: 'entity:2' }], equipment: [item('instance:1', 'entity:1')] });
    expect(assessBuildHistoryObligations(source).breakdown.transfers).toBe(3);
    expect(assessBuildHistoryObligations(retire(source, 'entity:1'))).toMatchObject({ historyCount: 2, reservedCommands: 4 });
    expect(assessBuildHistoryObligations({ ...source, pendingEstates: [{ discipleId: 'entity:1', beneficiaryId: null }] }).breakdown.transfers).toBe(1);
  });

  test('a promised beneficiary that died before unlock sends pending items to the estate', () => {
    const source = facts({ disciples: [member('entity:1', null, 'dead'), member('entity:2', 'entity:3', 'dead'), member('entity:3')],
      pendingEstates: [{ discipleId: 'entity:1', beneficiaryId: 'entity:2' }, { discipleId: 'entity:2', beneficiaryId: 'entity:3' }],
      equipment: [item('instance:1', 'entity:1')] });
    expect(assessBuildHistoryObligations(source).breakdown.transfers).toBe(1);
    expect(retire(source, 'entity:1').equipment[0]!.ownerDiscipleId).toBeNull();
  });

  test('already retired identities and sect-estate items create no duplicate death reservation', () => {
    const source = facts({ historyCount: 4, retiredDiscipleIds: ['entity:1'], equipment: [item('instance:1', null), item('instance:2', null), item('instance:3', null)] });
    expect(assessBuildHistoryObligations(source)).toMatchObject({ reservedCommands: 0, availableCommands: 1020, fits: true });
    expect(assessBuildHistoryObligations({ ...source, disciples: [member('entity:2')], equipment: [item('instance:1', 'entity:2'), item('instance:2', null), item('instance:3', null)] }).reservedCommands).toBe(2);
  });

  test('teaching, realm, single multi-member unlock, and first-victory awards are added once', () => {
    const source = starter({ teachingIds: ['instance:31', 'instance:32'], realmMilestoneIds: ['realm/entity:1/qi', 'realm/entity:2/qi'],
      activeRun: { runId: 'run:1', firstVictoryDiscipleIds: ['entity:1', 'entity:2', 'entity:3'] } });
    expect(assessBuildHistoryObligations(source)).toMatchObject({ reservedCommands: 24, breakdown: { retirements: 4, transfers: 12, teachingGrants: 2, realmAwards: 2, runUnlocks: 1, firstVictoryAwards: 3 } });
    const allDead = facts({ disciples: [member('entity:1', null, 'dead')], pendingEstates: [{ discipleId: 'entity:1', beneficiaryId: null }],
      activeRun: { runId: 'run:1', firstVictoryDiscipleIds: [] } });
    expect(assessBuildHistoryObligations(allDead)).toMatchObject({ reservedCommands: 2, breakdown: { runUnlocks: 1, firstVictoryAwards: 0 } });
  });

  test('an atomic teaching grant consumes its own slot while leaving all death slots intact', () => {
    const before = starter({ historyCount: 1007, teachingIds: ['instance:31'] });
    const after = { ...before, historyCount: 1008, teachingIds: [] };
    expect(assessBuildHistoryObligations(before)).toMatchObject({ reservedCommands: 17, availableCommands: 0 });
    expect(assessBuildHistoryObligations(after)).toMatchObject({ reservedCommands: 16, availableCommands: 0 });
  });

  test('every death order in branched and cyclic four-person fixtures conserves or releases funded rows', () => {
    for (const heirs of [['entity:2', 'entity:3', 'entity:4', null], ['entity:2', 'entity:3', 'entity:1', 'entity:2']] as const) {
      const source = starter({ disciples: heirs.map((heir, index) => member(`entity:${index + 1}`, heir)) });
      const ids = source.disciples.map(entry => entry.discipleId);
      for (const order of permutations(ids)) {
        let current = source;
        for (const discipleId of order) {
          const before = assessBuildHistoryObligations(current);
          current = retire(current, discipleId);
          const after = assessBuildHistoryObligations(current);
          expect(after.historyCount + after.reservedCommands).toBeLessThanOrEqual(before.historyCount + before.reservedCommands);
        }
        expect(assessBuildHistoryObligations(current).reservedCommands).toBe(0);
        expect(current.equipment.every(entry => entry.ownerDiscipleId === null)).toBe(true);
      }
    }
  });

  test('frozen facts are unchanged, output is owned/frozen, and input order does not change the result', () => {
    const source = starter(); const serialized = JSON.stringify(source);
    Object.freeze(source.disciples); Object.freeze(source.equipment); Object.freeze(source);
    const result = assessBuildHistoryObligations(source);
    expect(JSON.stringify(source)).toBe(serialized);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.breakdown)).toBe(true);
    expect(assessBuildHistoryObligations({ ...source, disciples: [...source.disciples].reverse(), equipment: [...source.equipment].reverse() })).toEqual(result);
  });
});

describe('strict derived-fact validation', () => {
  test.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', 1025])('rejects invalid history count %s', value => {
    expect(() => assessUnknown({ ...facts(), historyCount: value })).toThrow(/build obligation facts/);
  });
  test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1024', 1025])('rejects invalid limit %s', value => {
    expect(() => assessUnknown({ ...facts(), maximumCommands: value })).toThrow(/build obligation facts/);
  });
  test('honors a smaller registered command limit', () => {
    expect(assessBuildHistoryObligations(starter({ maximumCommands: 16 }))).toMatchObject({ remainingCommands: 16, availableCommands: 0, fits: true });
    expect(() => assessBuildHistoryObligations(facts({ historyCount: 17, maximumCommands: 16 }))).toThrow();
  });
  test('rejects duplicate current/historical identities, item identities and obligations', () => {
    const source = starter();
    const invalidCases: unknown[] = [
      { ...source, disciples: [source.disciples[0], source.disciples[0]] },
      { ...source, retiredDiscipleIds: ['entity:1'] },
      { ...source, retiredDiscipleIds: ['entity:9', 'entity:9'] },
      { ...source, equipment: [source.equipment[0], source.equipment[0]] },
      { ...source, teachingIds: ['instance:30', 'instance:30'] },
      { ...source, realmMilestoneIds: ['realm/entity:1/qi', 'realm/entity:1/qi'] },
      { ...source, activeRun: { runId: 'run:1', firstVictoryDiscipleIds: ['entity:1', 'entity:1'] } },
      facts({ disciples: [member('entity:1', null, 'dead')], pendingEstates: [{ discipleId: 'entity:1', beneficiaryId: null }, { discipleId: 'entity:1', beneficiaryId: null }] }),
    ];
    for (const value of invalidCases) expect(() => assessUnknown(value)).toThrow();
  });
  test('rejects dangling references and unfinished ownership by a retired disciple', () => {
    const source = starter();
    for (const value of [
      { ...source, disciples: [member('entity:1', 'entity:99')] },
      { ...source, equipment: [item('instance:1', 'entity:99')] },
      facts({ retiredDiscipleIds: ['entity:1'], equipment: [item('instance:1', 'entity:1')] }),
      { ...source, activeRun: { runId: 'run:1', firstVictoryDiscipleIds: ['entity:99'] } },
      facts({ disciples: [member('entity:1', null, 'dead')], pendingEstates: [{ discipleId: 'entity:1', beneficiaryId: 'entity:99' }] }),
    ]) expect(() => assessUnknown(value)).toThrow();
  });
  test('rejects missing/invalid estate owners, self inheritance and impossible first-victory recipients', () => {
    for (const value of [
      facts({ disciples: [member('entity:1', null, 'dead')] }),
      facts({ disciples: [member('entity:1')], pendingEstates: [{ discipleId: 'entity:1', beneficiaryId: null }] }),
      facts({ disciples: [member('entity:1', 'entity:1')] }),
      facts({ disciples: [member('entity:1', null, 'dead')], pendingEstates: [{ discipleId: 'entity:1', beneficiaryId: 'entity:1' }] }),
      facts({ activeRun: { runId: 'run:1', firstVictoryDiscipleIds: [] } }),
      facts({ disciples: [member('entity:1', null, 'dead')], pendingEstates: [{ discipleId: 'entity:1', beneficiaryId: null }], activeRun: { runId: 'run:1', firstVictoryDiscipleIds: ['entity:1'] } }),
    ]) expect(() => assessUnknown(value)).toThrow();
  });
  test('rejects over-limit collections and overlong or forbidden identities', () => {
    for (const value of [
      facts({ disciples: Array.from({ length: 37 }, (_, index) => member(`entity:${index + 1}`)) }),
      facts({ equipment: Array.from({ length: 513 }, (_, index) => item(`instance:${index + 1}`, null)) }),
      facts({ disciples: Array.from({ length: 7 }, (_, index) => member(`entity:${index + 1}`)), activeRun: { runId: 'run:1', firstVictoryDiscipleIds: Array.from({ length: 7 }, (_, index) => `entity:${index + 1}`) } }),
      facts({ disciples: [member('a'.repeat(121))] }),
      facts({ retiredDiscipleIds: ['constructor'] }),
      facts({ teachingIds: [''] }),
    ]) expect(() => assessUnknown(value)).toThrow();
  });
  test('rejects non-data/unknown fields and sparse arrays without invoking accessors or string coercion', () => {
    let invoked = false;
    const accessor = { ...facts() };
    Object.defineProperty(accessor, 'historyCount', { get: () => { invoked = true; return 0; }, enumerable: true });
    expect(() => assessUnknown(accessor)).toThrow();
    const nested = { discipleId: 'entity:1', lifeState: 'alive', heirId: null };
    Object.defineProperty(nested, 'heirId', { get: () => { invoked = true; return null; }, enumerable: true });
    expect(() => assessUnknown({ ...facts(), disciples: [nested] })).toThrow();
    expect(() => assessUnknown({ ...facts(), disciples: [{ discipleId: 'entity:1', heirId: null, lifeState: { toString() { invoked = true; return 'alive'; } } }] })).toThrow();
    const sparse = new Array(1);
    expect(() => assessUnknown({ ...facts(), teachingIds: sparse })).toThrow();
    expect(() => assessUnknown({ ...facts(), savedReservedCommands: 0 })).toThrow();
    expect(() => assessUnknown(Object.assign(Object.create(null), facts()))).toThrow();
    expect(() => assessUnknown(null)).toThrow();
    expect(invoked).toBe(false);
  });
});
