import { combatCatalog } from '../../src/content/definitions';
import { applyExpeditionCommand, createExpedition, getNextTimeCheckpoint } from '../../src/core/expeditions';
import type { CreateExpeditionOptions, ExpeditionCatalog, ExpeditionCommand, ExpeditionMemberInput, ExpeditionState, ValidatedEncounterOutcome } from '../../src/core/expeditions';

export const catalog = combatCatalog;
export function options(overrides: Partial<CreateExpeditionOptions> = {}): CreateExpeditionOptions {
  const rows = [
    ['sword', 'liuhen-jian', 'guifeng', 'jianxin'],
    ['body', 'baoyue', 'budong-shan', 'xujin'],
    ['alchemy', 'qingwu', 'huichun', 'yaoli'],
    ['talisman', 'yinlei', 'fenzhang', 'fumai'],
  ] as const;
  const members: ExpeditionMemberInput[] = rows.map(([school, first, second, passive], index) => ({
    discipleId: `entity:${index + 1}`, available: true, alive: true, health: 100, spirit: 100, injury: 0, durability: 100,
    loadout: { basic: { school, coefficientBps: 10_000, cooldownTicks: 20, castTicks: 0, rangeUnits: 600 },
      activeSkillIds: [`skill.${first}`, `skill.${second}`], passiveSkillId: `skill.${passive}`, characterSourceIds: [],
      equipment: { weaponId: `item.weapon-${school}`, robeId: `item.robe-${school}`, artifactId: `item.artifact-${school}` },
      stats: { attack: 20, maxHealth: 100 }, maximumSpirit: 100 },
  }));
  return { runId: 'run:1', seed: 'test-expedition', calendarMonth: 240, members, supplies: [{ resourceId: 'meal', quantity: 100 }],
    route: { regionId: 'region.qingfeng', regularEncounterIds: ['encounter.bandits', 'encounter.wolves'], bossEncounterId: 'encounter.boss',
      encounterCount: 3, minimumTravelMonths: 0, maximumTravelMonths: 0, returnMonths: 2 }, contentMode: 'experimental', ...overrides };
}
type Body = ExpeditionCommand extends infer C ? C extends ExpeditionCommand ? Omit<C, 'commandId' | 'expectedRevision'> : never : never;
export function command(state: ExpeditionState, body: Body, id = `command:${state.revision + 1}`): ExpeditionCommand {
  return { ...body, commandId: id, expectedRevision: state.revision } as ExpeditionCommand;
}
export function transition(state: ExpeditionState, body: Body, content: ExpeditionCatalog = catalog, id?: string) {
  const next = applyExpeditionCommand(state, command(state, body, id), content);
  if (!next.ok) throw new Error(`Unexpected expedition rejection: ${next.code} for ${body.kind}`);
  return next;
}
export function runToNode(state: ExpeditionState, content: ExpeditionCatalog = catalog): ExpeditionState {
  let result = state.phase === 'Preparing' ? transition(state, { kind: 'depart' }, content).state : state;
  while (result.phase === 'Travelling') {
    const cp = getNextTimeCheckpoint(result)!;
    if (!result.admittedCheckpoint) result = transition(result, { kind: 'time.admit', checkpointId: cp.checkpointId, expectedCalendarMonth: cp.expectedCalendarMonth }, content).state;
    result = transition(result, { kind: 'time.commit', checkpointId: cp.checkpointId, expectedCalendarMonth: cp.expectedCalendarMonth, resultingCalendarMonth: cp.resultingCalendarMonth }, content).state;
  }
  return result;
}
export function outcome(state: ExpeditionState, overrides: Partial<ValidatedEncounterOutcome> = {}): ValidatedEncounterOutcome {
  const encounter = state.currentEncounter!;
  return { encounterId: encounter.encounterId, resultId: `result:${state.nodeIndex + 1}`,
    validation: { kind: 'validatedCombatOutcome', battleId: `battle:${state.nodeIndex + 1}`, battleSnapshotHash: '01234567' },
    outcome: 'victory', retreatConfirmed: false,
    members: encounter.squad.map(member => ({ discipleId: member.discipleId, alive: true, permanentDeathId: null, health: member.health, spirit: member.spirit, injury: member.injury, durability: member.durability })),
    consumedSupplies: [], securedLoot: [{ resourceId: 'stone', quantity: 2 }], unsecuredLoot: [{ resourceId: 'wood', quantity: 5 }], unlockIds: [], ...overrides };
}
export function winEncounter(state: ExpeditionState, content: ExpeditionCatalog = catalog): ExpeditionState {
  let result = runToNode(state, content);
  result = transition(result, { kind: 'encounter.begin' }, content).state;
  return transition(result, { kind: 'encounter.resolve', result: outcome(result) }, content).state;
}
export function atOffer(content: ExpeditionCatalog = catalog, changes: Partial<CreateExpeditionOptions> = {}): ExpeditionState {
  return winEncounter(createExpedition(options(changes), content), content);
}
export function fallback(state: ExpeditionState, content: ExpeditionCatalog = catalog): ExpeditionState {
  const offer = state.offers.find(entry => entry.offerId === state.currentOfferId)!;
  return transition(state, { kind: 'offer.supplies', offerId: offer.offerId, offerRevision: offer.revision }, content).state;
}
export function finishReturn(state: ExpeditionState, content: ExpeditionCatalog = catalog): ExpeditionState {
  let result = state;
  let cp = getNextTimeCheckpoint(result);
  while (cp) {
    if (!result.admittedCheckpoint) result = transition(result, { kind: 'time.admit', checkpointId: cp.checkpointId, expectedCalendarMonth: cp.expectedCalendarMonth }, content).state;
    result = transition(result, { kind: 'time.commit', checkpointId: cp.checkpointId, expectedCalendarMonth: cp.expectedCalendarMonth, resultingCalendarMonth: cp.resultingCalendarMonth }, content).state;
    cp = getNextTimeCheckpoint(result);
  }
  return transition(result, { kind: 'run.settle', settlementId: result.settlement!.settlementId }, content).state;
}
