import type { CombatTag, Condition, EffectPrimitive, Mechanics, TalentDefinition, TargetSelector, TriggerDefinition } from '../../core/combat/definitions/types';
import { all, always, base, consume, requiredCapabilities, self, status, trigger } from '../definitions/helpers';

export interface ReleaseTalentRow {
  readonly definition: TalentDefinition;
  readonly zhName: string;
  readonly enName: string;
  readonly zhDescription: string;
  readonly enDescription: string;
  /** Real skills, not invented source tags. Partners may carry the other skills. */
  readonly evidenceSkillIds: readonly string[];
  readonly evidenceTalentIds: readonly string[];
}
export const eventTag = (tag: CombatTag): Condition => ({ kind: 'hasTag', subject: 'eventSource', tag });
export const not = (condition: Condition): Condition => ({ kind: 'not', condition });
export const proc = (id: string, event: TriggerDefinition['event'], condition: Condition, effects: readonly EffectPrimitive[], cooldown: number, options: { scope?: TriggerDefinition['eventScope']; allow?: readonly string[]; cap?: number; perTarget?: boolean } = {}): TriggerDefinition => {
  const value = trigger(id, event, condition, effects, cooldown, options.cap ?? 24, options.scope ?? 'owner');
  return { ...value, proc: { ...value.proc, allowIndirectFamilies: options.allow ?? [], perTarget: options.perTarget ?? false } };
};
/** Recheck the payment before the benefit. Trigger conditions were frozen before earlier queued programs. */
export function spendStatus(statusId: string, count: number, benefit: EffectPrimitive, target: TargetSelector = self): readonly EffectPrimitive[] {
  const subject = target.kind === 'self' ? 'actor' : 'target';
  return [{ ...benefit, condition: all(benefit.condition, status(statusId, count, subject)) }, consume(statusId, count, 'releasePayment', target, count)];
}
export const forceFamilies = ['forceCounter', 'releaseOnBasic'] as const;
const generalCards = new Set(['dingfeng-shuanghen', 'yuying-hudeng', 'huomai-shujian', 'suijia-huixi', 'dingbu-ningshi', 'shouyu-liuzhen', 'pofu-shouyuan', 'tongjia-jiuyuan', 'dunjia-runsheng', 'huzhen-dianfeng', 'yifa-hudeng', 'sanyao-jingzhen']);
const routeCards = new Set(['pochen-duanliu', 'yaohua-jingmai', 'jinhuo-liuzhan', 'zhanwen-yuanshu']);
export function row(slug: string, build: string, role: TalentDefinition['offerRole'], required: readonly CombatTag[], m: Mechanics, names: readonly [string, string], descriptions: readonly [string, string], evidence: readonly string[], options: { team?: boolean; binding?: TalentDefinition['recipientBinding']; prerequisites?: readonly string[]; evidenceTalents?: readonly string[] } = {}): ReleaseTalentRow {
  const section = ['huichao-jianzhen', 'yaohuo-gonglu'].includes(build) ? 14 : 15;
  const capabilities = requiredCapabilities(m);
  const advanced = capabilities.some(value => ['zone', 'summon', 'move'].includes(value));
  const id = `talent.${slug}`;
  const maximum = Math.max(...m.triggers.map(value => value.proc.maximumActivations));
  const zhLimit = maximum === 120 ? '每场最多记录120次施法，每个收益触发最多24次。' : maximum === 1 ? '' : `每场每个收益触发最多${maximum}次。`;
  const enLimit = maximum === 120 ? ' At most 120 cast records and 24 activations per payoff per encounter.' : maximum === 1 ? '' : ` At most ${maximum} activations per payoff per encounter.`;
  return {
    definition: { ...base(id, section, capabilities), source: { designRef: 'docs/release-build-catalog.md', section },
      implementation: advanced ? 'blocked' : 'definition-only', blockedReasons: advanced ? ['Experimental executor supports this program; release verification and balance certification remain pending.'] : [],
      kind: 'talent', lifecycleScope: 'run', holderScope: options.team ? 'team' : 'personal', category: generalCards.has(slug) ? 'general' : routeCards.has(slug) ? 'route' : 'school',
      buildId: `build.${build}`, offerRole: role, maximumRank: 1, prerequisites: options.prerequisites ?? [], excludes: [], requiredSourceTags: required,
      providesSourceTags: [], tags: required, teamStackPolicy: options.team ? 'highestValueSharedBudget' : 'notApplicable',
      recipientBinding: options.binding ?? (options.team ? 'team' : 'holder'), mechanics: m },
    zhName: names[0], enName: names[1], zhDescription: `${descriptions[0]}仅本次远征有效。${zhLimit}`, enDescription: `${descriptions[1]} This expedition only.${enLimit}`,
    evidenceSkillIds: evidence.map(value => `skill.${value}`), evidenceTalentIds: options.evidenceTalents ?? [],
  };
}
export const noCondition = always;
