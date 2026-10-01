import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  addWorkPlanPriority, createWorkPlanDraft, dispatchWorkPlanCommand, moveWorkPlanPriority,
  WorkPlansPanel, workPlanDraftCommand, workPlanRecipes, workPlanWorkerNotice,
  type WorkPlanDraft, type WorkPlansPanelProps,
} from '../../src/app/WorkPlansPanel';
import { matchesWorkPlanGuard, workPlanSignature, type WorkPlanEditGuard } from '../../src/application/work-plan-contract';
import { applySectEconomyCommand, createSectEconomyState } from '../../src/core/sect-economy/state';
import type { SectEconomyCommand, SectEconomyState, WorkPlanBlockedReason } from '../../src/core/sect-economy/types';
import { RESOURCE_IDS } from '../../src/core/economy/types';
import { canonicalStringify } from '../../src/core/kernel/serialization';
import { STARTER_RECIPES } from '../../src/core/economy/recipes';
import { createTranslator, messageSpecifications, translate, validateLocales, type Locale, type TextKey } from '../../src/i18n';
import type { MessageSpecifications } from '../../src/i18n/types';
import { zhCN } from '../../src/content/locales/zh-CN';
import { en } from '../../src/content/locales/en';
import localeFixture from './locales.fixture.json';

const keys = Object.keys(localeFixture.entries) as (keyof typeof localeFixture.entries)[];
const fixtureZhCN = Object.fromEntries(keys.map(key => [key, localeFixture.entries[key][0]!])) as Record<string, string>;
const fixtureEn = Object.fromEntries(keys.map(key => [key, localeFixture.entries[key][1]!])) as Record<string, string>;
const parameters = localeFixture.parameters as Record<string, unknown>;
const fixtureSpecifications = Object.fromEntries(keys.map(key => [key, { parameters: parameters[key] ?? {} }])) as MessageSpecifications;
const fixtureTranslate = createTranslator({ baseCatalog: { ...zhCN, ...fixtureZhCN }, englishCatalog: { ...en, ...fixtureEn }, specifications: { ...messageSpecifications, ...fixtureSpecifications } });
const t = (locale: Locale = 'zh-CN') => (key: TextKey, params?: Parameters<typeof translate>[2]) => fixtureTranslate(locale, key, params);
const state = (): SectEconomyState => ({ ...createSectEconomyState(), plans: [{ workerId: 'entity:2', enabled: true, priorities: [
  { recipeId: 'cook.meal', targetStock: 18 }, { recipeId: 'farm.grain', targetStock: 24 },
] }] });
const makeProps = (overrides: Partial<WorkPlansPanelProps> = {}): WorkPlansPanelProps => ({
  sessionEpoch: 3,
  worker: { workerId: 'entity:2', nameKey: 'disciple.starter.2', lifeState: 'alive', ageMonths: 240, away: false, available: true },
  state: state(), resources: RESOURCE_IDS.map(resourceId => ({ resourceId, owned: 12, reserved: 2, available: 10, capacity: 50, incoming: resourceId === 'meal' ? 3 : 0 })),
  status: 'DISABLED', blockers: [], executionReady: true, readOnly: false, t: t(), onCommand: () => ({ ok: true }), ...overrides,
});
const globalGuard = (props: WorkPlansPanelProps): WorkPlanEditGuard => ({ sessionEpoch: props.sessionEpoch, workerId: null, expectedPlan: null, expectedEnabled: props.state.enabled });
const changedDraft = (props = makeProps()): WorkPlanDraft => ({ ...createWorkPlanDraft(props)!, priorities: [{ recipeId: 'cook.meal', targetStock: '23' }] });
const visible = (markup: string) => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const render = (overrides: Partial<WorkPlansPanelProps> = {}) => renderToStaticMarkup(<WorkPlansPanel {...makeProps(overrides)} />);

// These are semantic HTML/pure command tests, not browser or Canvas interaction acceptance.
describe('read-only automatic-work presentation', () => {
  it('uses only actual registered recipes and shows real material/output/stock figures without changing state', () => {
    const props = makeProps(); const before = canonicalStringify({ state: props.state, resources: props.resources }); const onCommand = vi.fn(() => ({ ok: true }));
    const markup = renderToStaticMarkup(<WorkPlansPanel {...props} onCommand={onCommand} />); const text = visible(markup);
    expect(text).toContain('生产安排'); expect(text).toContain('目标'); expect(text).toContain('现有 12/50'); expect(text).toContain('可用 10'); expect(text).toContain('已预留 2'); expect(text).toContain('在产 3');
    expect(markup).toContain('value="18"'); expect(markup).toContain('value="24"');
    expect(markup.match(/class="work-plans-priority"/g)).toHaveLength(2);
    for (const recipe of Object.values(STARTER_RECIPES)) expect(workPlanRecipes()).toContain(recipe);
    expect(workPlanRecipes()).toHaveLength(6); expect(onCommand).not.toHaveBeenCalled();
    expect(canonicalStringify({ state: props.state, resources: props.resources })).toBe(before);
  });
  it('has labeled integer targets, keyboard-native reorder buttons and an ordered priority list', () => {
    const markup = render();
    expect(markup).toContain('<ol class="work-plans-priorities"'); expect(markup).toContain('min="0" max="999" step="1"'); expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-pressed="false"'); expect(markup).toContain('aria-describedby=');
    expect(markup).toMatch(/aria-label="将[^\"]+上移"/); expect(markup).toMatch(/aria-label="将[^\"]+下移"/);
    const moveUp = (markup.match(/<button\b[^>]*>/g) ?? []).filter(button => /上移/.test(button));
    const moveDown = (markup.match(/<button\b[^>]*>/g) ?? []).filter(button => /下移/.test(button));
    expect(moveUp[0]).toContain('disabled'); expect(moveUp[1]).not.toContain('disabled'); expect(moveDown[0]).not.toContain('disabled'); expect(moveDown[1]).toContain('disabled');
    for (const button of markup.match(/<button\b[^>]*>/g) ?? []) expect(button).toContain('type="button"');
    for (const input of markup.match(/<(?:input|select)\b[^>]*\bid="[^\"]+"[^>]*>/g) ?? []) {
      const id = /id="([^\"]+)"/.exec(input)?.[1]; expect(markup).toContain(`for="${id}"`);
    }
  });
  it('offers only unused recipes and does not silently add or enable one', () => {
    const markup = render();
    expect(markup).not.toContain('<option value="cook.meal"'); expect(markup).not.toContain('<option value="farm.grain"');
    expect(markup.match(/<option\b/g)).toHaveLength(4);
    expect(markup).toMatch(/class="work-plans-save"[^>]*disabled/);
    const empty = render({ state: createSectEconomyState() }); expect(visible(empty)).toContain('尚未添加配方');
    expect(empty).toMatch(/class="work-plans-plan-toggle"[^>]*\/>/); expect(empty).not.toMatch(/class="work-plans-plan-toggle"[^>]*checked/);
  });
  it('disables mutation controls under read-only and busy locks', () => {
    for (const flags of [{ readOnly: true }, { busy: true }]) {
      const markup = render(flags);
      expect(markup).toMatch(/class="work-plans-fields" disabled/);
      expect(markup).toMatch(/class="secondary work-plans-global-toggle"[^>]*disabled/);
      expect(markup).toMatch(/class="work-plans-save"[^>]*disabled/);
      expect(visible(markup)).toContain(flags.readOnly ? '只读' : '正在处理');
    }
  });
  it('keeps staged execution gated and permits disabling an already enabled global configuration', () => {
    const markup = render({ executionReady: false, status: 'HISTORY_LIMIT' });
    expect(visible(markup)).toContain('自动开工尚未开放'); expect(visible(markup)).not.toContain(fixtureZhCN['workPlans.status.HISTORY_LIMIT']);
    expect(markup).toMatch(/class="secondary work-plans-global-toggle"[^>]*disabled/);
    const enabled = render({ executionReady: false, state: { ...state(), enabled: true } });
    expect(enabled).toMatch(/class="secondary work-plans-global-toggle" aria-pressed="true">/);
  });
  it('shows supplied current worker and space blockers instead of deriving fake admission success', () => {
    const reasons: WorkPlanBlockedReason[] = ['PLAN_DISABLED', 'WORKER_UNAVAILABLE', 'NO_PRIORITIES', 'TARGET_MET', 'MATERIALS_MISSING', 'CAPACITY_FULL', 'WORKSTATION_UNAVAILABLE', 'STORAGE_UNAVAILABLE', 'START_LIMIT'];
    for (const reason of reasons) {
      const markup = render({ status: 'IDLE', blockers: [{ workerId: 'entity:2', reason, recipeId: 'cook.meal', resourceId: 'meal' }] });
      expect(visible(markup)).toContain(fixtureZhCN[`workPlans.blocker.${reason}`]);
    }
    const other = render({ blockers: [{ workerId: 'entity:99', reason: 'CAPACITY_FULL' }] }); expect(other).not.toContain('work-plans-blockers');
    expect(visible(render({ status: 'HISTORY_LIMIT' }))).toContain('存档空间预算不足');
    expect(visible(render({ status: 'SCHEDULED' }))).toContain('开工时将再次核验');
  });
  it('shows migration review and requires explicit acknowledgement before activation', () => {
    const markup = render({ activationReviewRequired: true }); expect(visible(markup)).toContain('升级后自动生产已关闭');
    expect(markup).toContain('type="checkbox"'); expect(markup).toMatch(/class="secondary work-plans-global-toggle"[^>]*disabled/);
    const onCommand = vi.fn(() => ({ ok: true })); const props = makeProps({ activationReviewRequired: true, onCommand }); const command: SectEconomyCommand = { kind: 'enabled.set', enabled: true };
    expect(dispatchWorkPlanCommand(props, command, globalGuard(props))).toEqual({ ok: false, code: 'REVIEW_REQUIRED' }); expect(onCommand).not.toHaveBeenCalled();
    expect(dispatchWorkPlanCommand(props, command, globalGuard(props), true)).toEqual({ ok: true }); expect(onCommand).toHaveBeenCalledTimes(1);
  });
  it('handles missing selections and known dead, young or away workers without inventing availability', () => {
    const empty = render({ worker: null }); expect(visible(empty)).toContain('请选择一位弟子'); expect(empty).not.toContain('work-plans-fields');
    const base = makeProps().worker!;
    for (const [patch, expected] of [
      [{ lifeState: 'dead' }, '陨落'], [{ lifeState: 'pendingDeath' }, '寿元事件'], [{ ageMonths: 191 }, '尚未满十六岁'], [{ away: true }, '正在外出'], [{ available: false }, '当前无法接新工作'],
    ] as const) expect(visible(render({ worker: { ...base, ...patch } }))).toContain(expected);
    expect(workPlanWorkerNotice({ ...base, ageMonths: 192 })).toBeNull();
  });
  it('explains independent plan disabling and current-job cancellation in both locales', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      const text = visible(render({ t: t(locale) })); expect(text).toContain(locale === 'zh-CN' ? '已开始的任务会继续' : 'admitted jobs continue');
      expect(text).toContain(locale === 'zh-CN' ? '取消当前任务不会停用安排' : 'Cancelling the current job does not disable its plan');
      expect(text).toContain(locale === 'zh-CN' ? '稍后仍可能再次开工' : 'another job may start later');
    }
  });
});

describe('bounded, detached plan drafts', () => {
  it('copies existing priorities and starts new plans disabled without mutating the projection', () => {
    const props = makeProps(); const before = canonicalStringify(props.state); const draft = createWorkPlanDraft(props)!;
    expect(draft.priorities).toEqual([{ recipeId: 'cook.meal', targetStock: '18' }, { recipeId: 'farm.grain', targetStock: '24' }]);
    expect(draft.priorities).not.toBe(props.state.plans[0]!.priorities); expect(draft.guard.expectedPlan).toBe(workPlanSignature(props.state.plans[0]));
    expect(createWorkPlanDraft({ ...props, state: createSectEconomyState() })).toMatchObject({ enabled: false, priorities: [], guard: { expectedPlan: null } });
    expect(createWorkPlanDraft({ ...props, worker: null })).toBeNull(); expect(canonicalStringify(props.state)).toBe(before);
  });
  it('keeps inputs raw and rejects empty, decimal, signed, exponent, unsafe and out-of-range targets', () => {
    for (const targetStock of ['', ' ', '-1', '+1', '1.5', '1e2', '1000', 'Infinity', 'NaN', '9007199254740992']) {
      const draft = { ...changedDraft(), priorities: [{ recipeId: 'cook.meal', targetStock }] };
      expect(workPlanDraftCommand(draft), targetStock).toBeNull(); expect(draft.priorities[0]!.targetStock).toBe(targetStock);
    }
    for (const targetStock of ['0', '999', '023']) {
      expect(workPlanDraftCommand({ ...changedDraft(), priorities: [{ recipeId: 'cook.meal', targetStock }] })?.plan.priorities[0]?.targetStock).toBe(Number(targetStock));
    }
  });
  it('enforces unique registered recipes, max six, and explicit zero default targets', () => {
    let draft = createWorkPlanDraft(makeProps({ state: createSectEconomyState() }))!;
    for (const recipe of workPlanRecipes()) draft = addWorkPlanPriority(draft, recipe.recipeId);
    expect(draft.priorities).toHaveLength(6); expect(draft.priorities.every(row => row.targetStock === '0')).toBe(true);
    expect(addWorkPlanPriority(draft, 'unknown')).toBe(draft); expect(addWorkPlanPriority(draft, 'cook.meal')).toBe(draft);
    expect(workPlanDraftCommand({ ...draft, priorities: [...draft.priorities, { recipeId: 'cook.meal', targetStock: '1' }] })).toBeNull();
    expect(workPlanDraftCommand({ ...draft, priorities: [{ recipeId: 'not.registered', targetStock: '1' }] })).toBeNull();
    expect(workPlanDraftCommand({ ...draft, priorities: [{ recipeId: 'cook.meal', targetStock: '1' }, { recipeId: 'cook.meal', targetStock: '2' }] })).toBeNull();
  });
  it('reorders by keyboard actions without separating a target from its recipe or mutating authority', () => {
    const props = makeProps(); const before = canonicalStringify(props.state); const draft = createWorkPlanDraft(props)!;
    const next = moveWorkPlanPriority(draft, 1, -1); expect(next.priorities).toEqual([draft.priorities[1], draft.priorities[0]]);
    expect(next).not.toBe(draft); expect(draft.priorities[0]!.recipeId).toBe('cook.meal');
    expect(moveWorkPlanPriority(draft, 0, -1)).toBe(draft); expect(moveWorkPlanPriority(draft, 1, 1)).toBe(draft); expect(moveWorkPlanPriority(draft, -1, 1)).toBe(draft); expect(moveWorkPlanPriority(draft, 0.5, 1)).toBe(draft);
    expect(canonicalStringify(props.state)).toBe(before);
  });
});

describe('exact guarded domain command boundary', () => {
  it('emits only the typed plan.set payload and a separate edit guard, never IDs or resource changes', () => {
    const onCommand = vi.fn(() => ({ ok: true })); const props = makeProps({ onCommand }); const draft = changedDraft(props); const command = workPlanDraftCommand(draft)!;
    const before = canonicalStringify(props.state);
    expect(dispatchWorkPlanCommand(props, command, draft.guard)).toEqual({ ok: true });
    expect(onCommand).toHaveBeenCalledWith(command, draft.guard); expect(onCommand.mock.calls).toHaveLength(1);
    expect(command).not.toHaveProperty('commandId'); expect(command).not.toHaveProperty('expectedRevision'); expect(command).not.toHaveProperty('resources');
    expect(canonicalStringify(props.state)).toBe(before);
  });
  it('does not mutate the draft even if a callback changes its owned command payload', () => {
    const props = makeProps({ onCommand: command => { if (command.kind === 'plan.set') command.plan.priorities[0]!.targetStock = 0; return { ok: true }; } });
    const draft = changedDraft(props); const command = workPlanDraftCommand(draft)!; const before = canonicalStringify(draft);
    dispatchWorkPlanCommand(props, command, draft.guard); expect(command.plan.priorities[0]!.targetStock).toBe(23); expect(canonicalStringify(draft)).toBe(before);
  });
  it('rejects exact plan replacement, plan order changes, missing-plan replacement and campaign changes', () => {
    const onCommand = vi.fn(() => ({ ok: true })); const props = makeProps({ onCommand }); const draft = changedDraft(props); const command = workPlanDraftCommand(draft)!;
    const replaced = { ...state(), plans: [{ ...state().plans[0]!, priorities: [{ recipeId: 'cook.meal', targetStock: 19 }] }] };
    for (const update of [{ sessionEpoch: 4 }, { state: replaced }, { state: { ...state(), plans: [] } }, { state: { ...state(), plans: [{ ...state().plans[0]!, priorities: [...state().plans[0]!.priorities].reverse() }] } }]) {
      expect(dispatchWorkPlanCommand({ ...props, ...update }, command, draft.guard)).toEqual({ ok: false, code: 'STALE_PLAN' });
    }
    const empty = makeProps({ state: createSectEconomyState(), onCommand }); const emptyDraft = changedDraft(empty);
    expect(dispatchWorkPlanCommand(props, workPlanDraftCommand(emptyDraft)!, emptyDraft.guard)).toEqual({ ok: false, code: 'STALE_PLAN' }); expect(onCommand).not.toHaveBeenCalled();
  });
  it('ignores normal planner ticks, another worker plan and independent global toggles when guarding a plan', () => {
    const onCommand = vi.fn(() => ({ ok: true })); const props = makeProps({ onCommand }); const draft = changedDraft(props); const command = workPlanDraftCommand(draft)!;
    const changed = { ...state(), enabled: true, nextDecisionTick: 20, plans: [...state().plans, { workerId: 'entity:3', enabled: false, priorities: [] }] };
    expect(dispatchWorkPlanCommand({ ...props, state: changed }, command, draft.guard)).toEqual({ ok: true }); expect(onCommand).toHaveBeenCalledTimes(1);
  });
  it('guards global changes with the exact enable value and null worker/plan fields', () => {
    const onCommand = vi.fn(() => ({ ok: true })); const props = makeProps({ onCommand }); const command: SectEconomyCommand = { kind: 'enabled.set', enabled: true };
    expect(dispatchWorkPlanCommand(props, command, createWorkPlanDraft(props)!.guard)).toEqual({ ok: false, code: 'STALE_PLAN' });
    expect(dispatchWorkPlanCommand({ ...props, state: { ...state(), enabled: true } }, { kind: 'enabled.set', enabled: false }, globalGuard(props))).toEqual({ ok: false, code: 'STALE_PLAN' });
    expect(dispatchWorkPlanCommand(props, command, globalGuard(props))).toEqual({ ok: true }); expect(onCommand).toHaveBeenCalledTimes(1);
  });
  it('fails closed for read-only, busy, foreign-worker, gated and malformed actions', () => {
    const onCommand = vi.fn(() => ({ ok: true })); const props = makeProps({ onCommand }); const draft = changedDraft(props); const command = workPlanDraftCommand(draft)!;
    for (const flags of [{ readOnly: true }, { busy: true }]) expect(dispatchWorkPlanCommand({ ...props, ...flags }, command, draft.guard).ok).toBe(false);
    expect(dispatchWorkPlanCommand({ ...props, worker: null }, command, draft.guard).ok).toBe(false);
    expect(dispatchWorkPlanCommand({ ...props, worker: { ...props.worker!, workerId: 'entity:3' } }, command, draft.guard).ok).toBe(false);
    expect(dispatchWorkPlanCommand({ ...props, executionReady: false }, { kind: 'enabled.set', enabled: true }, globalGuard(props))).toEqual({ ok: false, code: 'EXECUTION_GATED' });
    for (const forged of [{ ...command, commandId: 'forged:1' }, { kind: 'production.cancel', payload: { transactionId: 'auto-job/1' } }, { kind: 'enabled.set', enabled: true, resources: { grain: 100 } }]) {
      expect(dispatchWorkPlanCommand(props, forged as unknown as SectEconomyCommand, draft.guard).ok).toBe(false);
    }
    expect(onCommand).not.toHaveBeenCalled();
  });
  it('allows configuring young/away workers, prevents newly enabling dead/pending workers and always allows disabling', () => {
    for (const lifeState of ['dead', 'pendingDeath'] as const) {
      const existing = makeProps({ worker: { ...makeProps().worker!, lifeState }, executionReady: false });
      const disable = { ...changedDraft(existing), enabled: false }; expect(dispatchWorkPlanCommand(existing, workPlanDraftCommand(disable)!, disable.guard).ok).toBe(true);
      const fresh = makeProps({ worker: { ...makeProps().worker!, lifeState }, state: createSectEconomyState() }); const enable = { ...changedDraft(fresh), enabled: true };
      expect(dispatchWorkPlanCommand(fresh, workPlanDraftCommand(enable)!, enable.guard)).toEqual({ ok: false, code: 'WORKER_UNAVAILABLE' });
    }
    for (const patch of [{ ageMonths: 120 }, { away: true }, { available: false }]) {
      const props = makeProps({ worker: { ...makeProps().worker!, ...patch }, state: createSectEconomyState() }); const draft = { ...changedDraft(props), enabled: true };
      expect(dispatchWorkPlanCommand(props, workPlanDraftCommand(draft)!, draft.guard).ok).toBe(true);
    }
  });
  it('retains drafts on rejection and does not run combined global/plan or production transactions', () => {
    const onCommand = vi.fn(() => ({ ok: false, code: 'TEST_REJECTED' })); const props = makeProps({ onCommand }); const draft = changedDraft(props); const before = canonicalStringify(draft);
    expect(dispatchWorkPlanCommand(props, workPlanDraftCommand(draft)!, draft.guard)).toEqual({ ok: false, code: 'TEST_REJECTED' });
    expect(canonicalStringify(draft)).toBe(before); expect(onCommand).toHaveBeenCalledTimes(1);
    const source = readFileSync(resolve('src/app/WorkPlansPanel.tsx'), 'utf8'); expect(source).not.toMatch(/\b(?:dispatchCommand|planAutomaticWork|startAutomaticProduction|finishAutomaticProduction|applySectEconomyCommand|advanceTicks)\s*\(/);
    expect(source).not.toContain("kind: 'production.cancel'"); expect(source).not.toContain('setInterval('); expect(source).not.toContain('Math.random(');
  });
  it('works with the real configuration reducer and leaves independent settings untouched', () => {
    let current = state(); const props = makeProps({ onCommand: (command, guard) => {
      if (!matchesWorkPlanGuard(current, 3, command, guard)) return { ok: false, code: 'STALE_PLAN' };
      const result = applySectEconomyCommand(current, command, ['entity:2']); if (result.ok) current = result.state; return result;
    } });
    const draft = changedDraft(props); expect(dispatchWorkPlanCommand(props, workPlanDraftCommand(draft)!, draft.guard).ok).toBe(true);
    expect(current.enabled).toBe(false); expect(current.plans[0]!.priorities).toEqual([{ recipeId: 'cook.meal', targetStock: 23 }]);
    expect(dispatchWorkPlanCommand(props, workPlanDraftCommand(draft)!, draft.guard)).toEqual({ ok: false, code: 'STALE_PLAN' });
  });
  it('mounts editor state behind campaign and disciple identity keys', () => {
    const first = WorkPlansPanel(makeProps()); const second = WorkPlansPanel(makeProps({ sessionEpoch: 4 }));
    const other = WorkPlansPanel(makeProps({ worker: { ...makeProps().worker!, workerId: 'entity:3' } }));
    expect(first.key).not.toBe(second.key); expect(first.key).not.toBe(other.key);
  });
});

describe('bilingual registration contract', () => {
  it('has matching complete Chinese/English messages and precise parameter specifications', () => {
    expect(validateLocales(fixtureZhCN, fixtureEn, fixtureSpecifications)).toMatchObject({ valid: true, errors: [], missingEnglishKeys: [] });
    for (const key of keys) expect(fixtureZhCN[key]).toBeTruthy();
  });
  it('requires every panel fixture key to be registered in the application catalogs', () => {
    for (const key of keys) {
      expect(Object.hasOwn(messageSpecifications, key)).toBe(true); expect(Object.hasOwn(zhCN, key)).toBe(true); expect(Object.hasOwn(en, key)).toBe(true);
    }
  });
});
