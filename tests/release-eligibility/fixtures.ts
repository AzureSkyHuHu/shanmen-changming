import { releaseCombatCatalog } from '../../src/content/release';
import { createExpedition } from '../../src/core/expeditions';
import type { ExpeditionCatalog, ExpeditionMemberInput, ExpeditionState, RunTalent } from '../../src/core/expeditions/types';
import { catalogFingerprint, prepareCombatCatalog } from '../../src/core/combat/runtime/catalog';
import { evaluateReleaseEligibility, RELEASE_ELIGIBILITY_RULES_ID, releaseEligibilityInputHash } from '../../src/core/expeditions/release-eligibility';
import type { ReleaseEligibilityContext } from '../../src/core/expeditions/release-eligibility';
import { options } from '../expeditions/fixtures';

export const catalog = releaseCombatCatalog;
/** Exact old candidate Medicine timing, retained only as a regression fixture after candidate.2. */
export const previousMedicineCatalog: ExpeditionCatalog = prepareCombatCatalog({ ...catalog, contentVersion: '0.2.0-release-candidate.1',
  talents: catalog.talents.map(entry => entry.id !== 'talent.jingdan-shenghua' ? entry : { ...entry, mechanics: { ...entry.mechanics,
    triggers: entry.mechanics.triggers.map(trigger => ({ ...trigger, effects: trigger.effects.map(effect => effect.kind === 'applyStatus' && effect.statusId === 'status.medicine'
      ? { ...effect, duration: { kind: 'ticks' as const, ticks: 200 } } : effect) })) } }) });
export function party(): ExpeditionState {
  const input = options();
  input.members[1]!.loadout.activeSkillIds = ['skill.baoyue', 'skill.zhenbu'];
  const protector: ExpeditionMemberInput = { ...input.members[1]!, discipleId: 'entity:5', loadout: { ...input.members[1]!.loadout,
    activeSkillIds: ['skill.yuanhu', 'skill.budong-shan'] } };
  const cleanser: ExpeditionMemberInput = { ...input.members[2]!, discipleId: 'entity:6', loadout: { ...input.members[2]!.loadout,
    activeSkillIds: ['skill.qingxin', 'skill.huichun'], passiveSkillId: 'skill.yuxi' } };
  input.members.push(protector, cleanser);
  return createExpedition(input, catalog);
}
export function only(state: ExpeditionState, ...ids: string[]): ExpeditionState {
  return { ...state, members: state.members.filter(member => ids.includes(member.discipleId)) };
}
export function loadout(state: ExpeditionState, id: string, activeSkillIds: readonly [string, string], passiveSkillId?: string): ExpeditionState {
  return { ...state, members: state.members.map(member => member.discipleId !== id ? member : { ...member, loadout: { ...member.loadout,
    activeSkillIds: [...activeSkillIds], passiveSkillId: passiveSkillId ?? member.loadout.passiveSkillId } }) };
}
export function own(state: ExpeditionState, slug: string, holderId: string | null, boundHolderId: string | null = null): ExpeditionState {
  const definitionId = `talent.${slug}`, definition = catalog.talents.find(entry => entry.id === definitionId)!;
  const talent: RunTalent = { instanceId: `test/${slug}/${holderId ?? 'team'}`, definitionId, holderScope: definition.holderScope,
    holderId, boundHolderId, rank: 1, acquiredRewardOrdinal: 1 };
  return { ...state, talentInstances: [...state.talentInstances, talent] };
}
export function progressed(): ExpeditionState {
  return own(own(own(party(), 'fanzhen', 'entity:2'), 'wenyao-yuxing', 'entity:3'), 'jingdan-shenghua', 'entity:6');
}
export function context(state: ExpeditionState, selected: ExpeditionCatalog = catalog): ReleaseEligibilityContext {
  const ids = [...state.members.map(member => member.discipleId), 'enemy:1'];
  const anchor = state.members.find(member => member.alive && member.permanentDeathId === null)?.discipleId;
  return {
    identity: { rulesId: RELEASE_ELIGIBILITY_RULES_ID, catalogHash: catalogFingerprint(selected), inputHash: releaseEligibilityInputHash(state),
      encounterId: 'encounter:release-fixture', encounterRulesId: 'fixture-opportunities.1', arenaId: 'arena:connected-fixture' },
    horizonTicks: 3000, enemies: [{ id: 'enemy:1', controlResistanceBps: 0 }], focusEnemyIds: ['enemy:1'],
    members: state.members.map(member => ({ discipleId: member.discipleId, guardAllowed: true, defeatRule: 'downed',
      directDamageEnemyIds: ['enemy:1'], controlEnemyIds: ['enemy:1'], decoyPlacementPossible: true })),
    reachablePairs: ids.flatMap((firstId, index) => ids.slice(index + 1).map(secondId => ({ firstId, secondId, distanceUnits: 50 }))),
    teamSourceHolders: anchor ? selected.talents.filter(entry => entry.holderScope === 'team').map(entry => ({ definitionId: entry.id, discipleId: anchor })) : [],
  };
}
export const evaluate = (state: ExpeditionState, selected: ExpeditionCatalog = catalog, facts = context(state, selected)) => evaluateReleaseEligibility(state, selected, facts);
export const holders = (state: ExpeditionState, slug: string, selected: ExpeditionCatalog = catalog, facts = context(state, selected)): readonly string[] | undefined =>
  evaluate(state, selected, facts).candidates.find(candidate => candidate.definitionId === `talent.${slug}`)?.holderIds;
export function replaceSkill(selected: ExpeditionCatalog, id: string, change: (skill: ExpeditionCatalog['skills'][number]) => ExpeditionCatalog['skills'][number]): ExpeditionCatalog {
  return { ...selected, skills: selected.skills.map(skill => skill.id === id ? change(skill) : skill) };
}
