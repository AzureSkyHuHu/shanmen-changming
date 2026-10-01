import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CampaignGrowthPanel, CampaignRecoveryConfirmation, canReviewCampaignRecovery, canSubmitCampaignGrowth, createCampaignGrowthController,
  type CampaignGrowthAction, type CampaignGrowthGuard, type CampaignGrowthPanelProps, type CampaignGrowthRequest, type CampaignGrowthResult,
} from '../../src/app/CampaignGrowthPanel';
import { createTranslator, validateLocales } from '../../src/i18n';
import type { MessageSpecifications } from '../../src/i18n/types';
import fixture from './campaign-growth-panel.locales.fixture.json';

const zh = Object.fromEntries(Object.entries(fixture.entries).map(([key, values]) => [key, values[0]!])) as Record<string, string>;
const en = Object.fromEntries(Object.entries(fixture.entries).map(([key, values]) => [key, values[1]!])) as Record<string, string>;
const parameters = fixture.parameters as Record<string, unknown>;
const specifications = Object.fromEntries(Object.keys(zh).map(key => [key, { parameters: parameters[key] ?? {} }])) as MessageSpecifications;
const definitions = {
  'test.robe': '行山衣', 'test.robe.description': '护住归山行客。', 'test.manual': '清心典籍', 'test.manual.description': '以丹道清心。',
  'test.route': '青峰初试', 'test.school': '丹道', 'test.recruit': '云舟', 'test.herbs': '灵草', 'test.meal': '行粮',
  'test.loss': '已陨落的四位弟子不会归来，个人修行不转移。', 'test.retained': '已取得的宗门典籍和行山衣保留。',
  'test.grant': '建立两位新弟子身份并取得本次规则规定的粮包。', 'test.condition': '当前符合单一幸存者补员条件。',
  'test.provenance': '行山衣由故人留存于宗门。', 'test.full': '完整弟子档案已满。',
};
const translator = createTranslator({ baseCatalog: { ...definitions, ...zh }, englishCatalog: { ...definitions, ...en },
  specifications: { ...Object.fromEntries(Object.keys(definitions).map(key => [key, { parameters: {} }])), ...specifications } });
const guard: CampaignGrowthGuard = { sessionEpoch: 4, basisStamp: 'authority-27' };
const disciple = { discipleId: 'disciple.alchemy', name: '清禾 <师姐>' };
const school = { school: 'alchemy' as const, schoolNameKey: 'test.school', nameKey: 'test.recruit', ageMonths: 229, lifespanMonths: 960, aptitude: 64 };
const herbs = [{ resourceId: 'herbs', nameKey: 'test.herbs', quantity: 2, available: 7 }];
const meals = [{ resourceId: 'meal', nameKey: 'test.meal', quantity: 4, available: 9 }];
function props(overrides: Partial<CampaignGrowthPanelProps> = {}): CampaignGrowthPanelProps {
  return { ...guard, readOnly: false, activeRun: false, managementActionsAvailable: true,
    equipment: [{ routeId: 'route.qingfeng-trial', nameKey: 'test.robe', descriptionKey: 'test.robe.description', eligibleDisciples: [disciple] }],
    manuals: [{ knowledgeId: 'knowledge.clearheart', nameKey: 'test.manual', descriptionKey: 'test.manual.description', costs: herbs, eligibleStudents: [disciple], learnedBy: [] }],
    invitations: [{ routeId: 'route.qingfeng-trial', routeNameKey: 'test.route', costs: meals, schools: [school] }],
    relief: { costs: [{ ...meals[0]!, quantity: 8 }], schools: [school], conditions: [{ key: 'test.condition' }] },
    recovery: { losses: [{ key: 'test.loss' }], retained: [{ key: 'test.retained' }], grants: [{ key: 'test.grant' }] },
    estate: [{ itemInstanceId: 'equipment.instance.7', nameKey: 'test.robe', descriptionKey: 'test.robe.description', eligibleDisciples: [disciple], provenance: [{ key: 'test.provenance' }] }],
    t: (key, values) => translator('zh-CN', key, values), onCommand: () => ({ ok: true }), ...overrides,
  };
}
const requests: CampaignGrowthAction[] = [
  { kind: 'campaign.equipment.claim', routeId: 'route.qingfeng-trial', discipleId: disciple.discipleId },
  { kind: 'campaign.lesson.learn', knowledgeId: 'knowledge.clearheart', discipleId: disciple.discipleId },
  { kind: 'campaign.recruit', routeId: 'route.qingfeng-trial', school: 'alchemy' },
  { kind: 'campaign.relief', school: 'alchemy' },
  { kind: 'estate.assign', itemInstanceId: 'equipment.instance.7', discipleId: disciple.discipleId },
];
const visible = (markup: string) => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const render = (value = props()) => renderToStaticMarkup(<CampaignGrowthPanel {...value} />);

describe('campaign growth display projection', () => {
  it('renders supplied rewards, costs, learned owners and estate provenance without issuing commands', () => {
    const onCommand = vi.fn(() => ({ ok: true })); const value = props({ onCommand }); const before = JSON.stringify(value);
    const markup = render(value); const text = visible(markup);
    for (const title of ['山门承续', '首通馈赠', '宗门藏经', '山门招贤', '标准补员', '宗门遗产库', '行山衣', '清心典籍']) expect(text).toContain(title);
    expect(text).toContain('灵草 × 2 · 可用 7'); expect(text).toContain('行粮 × 8 · 可用 9'); expect(text).toContain('行山衣由故人留存于宗门');
    expect(markup).toContain('清禾 &lt;师姐&gt;'); expect(markup).not.toContain('equipment.instance.7'); expect(markup).not.toContain('campaign.growth.');
    expect(markup).not.toContain('确认承受损失'); expect(onCommand).not.toHaveBeenCalled(); expect(JSON.stringify(value)).toBe(before);
  });
  it('starts with an explicit empty choice and labels all controls with keyboard-safe button types', () => {
    const markup = render();
    expect(markup.match(/<option value="" selected="">/g)?.length).toBe(5);
    for (const field of markup.match(/<select\b[^>]*\bid="[^"]+"[^>]*>/g) ?? []) {
      const id = /id="([^"]+)"/.exec(field)?.[1]; expect(markup).toContain(`for="${id}"`);
    }
    for (const button of markup.match(/<button\b[^>]*>/g) ?? []) expect(button).toContain('type="button"');
    expect(markup).toContain('aria-live="polite"'); expect(markup).toContain('aria-label="领取装备：行山衣"');
  });
  it('does not synthesize unlocked items, students, invitations or recovery from empty projections', () => {
    const value = props({ equipment: [], manuals: [], invitations: [], relief: null, recovery: null, estate: [] }); const markup = render(value);
    expect(visible(markup)).toContain('暂没有待领取的装备'); expect(markup).not.toContain('<select'); expect(markup).not.toContain('山门复兴');
    expect(markup).not.toContain('行山衣'); expect(markup).not.toContain('清心典籍');
    for (const request of requests) expect(canSubmitCampaignGrowth(value, request, guard)).toBe(false);
  });
  it('explains missing eligible recipients and blocked actions without defaulting to another disciple or school', () => {
    const base = props(); const value = props({ equipment: base.equipment.map(entry => ({ ...entry, eligibleDisciples: [] })),
      manuals: base.manuals.map(entry => ({ ...entry, eligibleStudents: [] })),
      invitations: base.invitations.map(entry => ({ ...entry, schools: [], blockedReason: { key: 'test.full' } })), relief: null, estate: [] });
    const markup = render(value); expect(markup).not.toContain('<select');
    for (const text of ['暂无符合条件的接收弟子', '暂无可学习此典籍的弟子', '当前没有可选的招募学派', '完整弟子档案已满']) expect(visible(markup)).toContain(text);
  });
  it.each(['readOnly', 'busy'] as const)('renders and enforces the %s guard', flag => {
    const onCommand = vi.fn(() => ({ ok: true })); const value = props({ [flag]: true, onCommand }); const controller = createCampaignGrowthController();
    for (const request of requests) expect(controller.submit(value, request, guard).ok).toBe(false);
    expect(controller.reviewRecovery(value, guard)).toBeNull(); expect(onCommand).not.toHaveBeenCalled();
    const markup = render(value); for (const select of markup.match(/<select[^>]*>/g) ?? []) expect(select).toContain('disabled');
  });
  it('keeps supplied ordinary management choices available during runs, but blocks relief and recovery', () => {
    const onCommand = vi.fn(() => ({ ok: true })); const value = props({ activeRun: true, onCommand });
    for (const request of requests.filter(request => request.kind !== 'campaign.relief')) expect(canSubmitCampaignGrowth(value, request, guard)).toBe(true);
    expect(canSubmitCampaignGrowth(value, requests[3]!, guard)).toBe(false); expect(canReviewCampaignRecovery(value, guard)).toBe(false);
    const restricted = { ...value, managementActionsAvailable: false };
    for (const request of requests) expect(canSubmitCampaignGrowth(restricted, request, guard)).toBe(false);
    expect(onCommand).not.toHaveBeenCalled();
  });
  it('remounts all local choices and confirmation state when the session epoch changes', () => {
    expect(CampaignGrowthPanel(props()).key).not.toBe(CampaignGrowthPanel(props({ sessionEpoch: 5 })).key);
  });
});

describe('guarded campaign command boundary', () => {
  it.each(requests.map(request => [request.kind, request] as const))('sends the exact %s intent without authority fields or a command ID', (_name, request) => {
    const onCommand = vi.fn(() => ({ ok: true })); const value = props({ onCommand }); const before = JSON.stringify(value);
    expect(createCampaignGrowthController().submit(value, request, guard)).toEqual({ ok: true });
    expect(onCommand).toHaveBeenCalledWith(request, guard); expect(onCommand.mock.calls).toHaveLength(1); expect(JSON.stringify(value)).toBe(before);
    expect(request).not.toHaveProperty('commandId'); expect(request).not.toHaveProperty('costs');
  });
  it('rejects old epochs and basis stamps even when a previously rendered choice still exists', () => {
    const onCommand = vi.fn(() => ({ ok: true })); const value = props({ onCommand }); const controller = createCampaignGrowthController();
    for (const request of requests) for (const old of [{ ...guard, sessionEpoch: 3 }, { ...guard, basisStamp: 'old-basis' }]) {
      expect(controller.submit(value, request, old).ok).toBe(false);
    }
    expect(onCommand).not.toHaveBeenCalled();
  });
  it('rejects injected command IDs, costs, forged choices and learned students', () => {
    const value = props();
    for (const request of requests) {
      expect(canSubmitCampaignGrowth(value, { ...request, commandId: 'forged' } as unknown as CampaignGrowthAction, guard)).toBe(false);
      expect(canSubmitCampaignGrowth(value, { ...request, costs: [] } as unknown as CampaignGrowthAction, guard)).toBe(false);
    }
    expect(canSubmitCampaignGrowth(value, { ...requests[0]!, discipleId: 'missing' } as CampaignGrowthAction, guard)).toBe(false);
    expect(canSubmitCampaignGrowth(value, { kind: 'campaign.recruit', routeId: 'route.miasma-seal', school: 'alchemy' }, guard)).toBe(false);
    expect(canSubmitCampaignGrowth(value, { kind: 'campaign.relief', school: 'sword' }, guard)).toBe(false);
    expect(canSubmitCampaignGrowth(props({ manuals: value.manuals.map(view => ({ ...view, learnedBy: [disciple] })) }), requests[1]!, guard)).toBe(false);
  });
  it('checks actual projected available stock and does not spend reserved, invalid or duplicated resource lines', () => {
    const base = props();
    for (const costs of [[{ ...herbs[0]!, available: 1 }], [{ ...herbs[0]!, quantity: NaN }], [{ ...herbs[0]!, quantity: -2 }], [...herbs, ...herbs]]) {
      const value = props({ manuals: base.manuals.map(view => ({ ...view, costs })) });
      expect(canSubmitCampaignGrowth(value, requests[1]!, guard)).toBe(false);
    }
    expect(canSubmitCampaignGrowth(props({ equipment: base.equipment.map(view => ({ ...view, blockedReason: { key: 'test.full' } })) }), requests[0]!, guard)).toBe(false);
  });
  it('blocks repeat and cross-card clicks until a changed authority projection arrives', () => {
    const onCommand = vi.fn(() => ({ ok: true })); const value = props({ onCommand }); const controller = createCampaignGrowthController();
    expect(controller.submit(value, requests[0]!, guard).ok).toBe(true);
    expect(controller.submit(value, { ...requests[0]! }, guard).ok).toBe(false);
    expect(controller.submit(value, requests[1]!, guard).ok).toBe(false); expect(controller.pending(value)).toBe(true);
    const next = { ...value, basisStamp: 'authority-28' }; controller.observe(next);
    expect(controller.pending(next)).toBe(false); expect(controller.submit(next, requests[1]!, next).ok).toBe(true); expect(onCommand).toHaveBeenCalledTimes(2);
  });
  it('consumes rejected repeated requests but allows a different eligible choice on the same basis', () => {
    const onCommand = vi.fn(() => ({ ok: false, code: 'INVENTORY_FULL' })); const value = props({ onCommand }); const controller = createCampaignGrowthController();
    expect(controller.submit(value, requests[0]!, guard).code).toBe('INVENTORY_FULL');
    expect(controller.submit(value, requests[0]!, guard).code).toBe('DUPLICATE_REQUEST');
    expect(controller.submit(value, requests[1]!, guard).code).toBe('INVENTORY_FULL'); expect(onCommand).toHaveBeenCalledTimes(2);
  });
  it('fails closed after a throwing callback and prevents re-entrant callbacks', () => {
    const controller = createCampaignGrowthController(); let value: CampaignGrowthPanelProps;
    const onCommand = vi.fn((): CampaignGrowthResult => {
      expect(controller.submit(value, requests[1]!, guard).ok).toBe(false); throw new Error('Lost response');
    });
    value = props({ onCommand }); expect(controller.submit(value, requests[0]!, guard).code).toBe('CALLBACK_FAILED');
    expect(controller.submit(value, requests[1]!, guard).ok).toBe(false); expect(onCommand).toHaveBeenCalledTimes(1);
  });
  it('detaches outgoing request and guard objects so callback mutation cannot rewrite the reviewed basis', () => {
    const request = requests[0]!; const onCommand = vi.fn((sent: CampaignGrowthRequest, sentGuard: CampaignGrowthGuard) => {
      expect(sent).not.toBe(request); expect(sentGuard).not.toBe(guard); return { ok: true };
    });
    expect(createCampaignGrowthController().submit(props({ onCommand }), request, guard).ok).toBe(true);
  });
});

describe('explicit loss and recovery confirmation', () => {
  it('never executes from rendering, preparing a review, or the general action submission route', () => {
    const onCommand = vi.fn(() => ({ ok: true })); const value = props({ onCommand }); const controller = createCampaignGrowthController();
    render(value); const review = controller.reviewRecovery(value, guard)!;
    expect(review).not.toBeNull(); expect(Object.isFrozen(review)).toBe(true); expect(Object.isFrozen(review.consequences.losses)).toBe(true);
    expect(controller.submit(value, { kind: 'campaign.recover', acknowledgeLoss: true } as unknown as CampaignGrowthAction, guard).ok).toBe(false);
    expect(onCommand).not.toHaveBeenCalled();
    expect(controller.confirmRecovery(value, review)).toEqual({ ok: true });
    expect(onCommand).toHaveBeenCalledWith({ kind: 'campaign.recover', acknowledgeLoss: true }, guard);
    expect(controller.confirmRecovery(value, review).ok).toBe(false); expect(onCommand).toHaveBeenCalledTimes(1);
  });
  it('cancellation invalidates the reviewed token and makes no authority change', () => {
    const onCommand = vi.fn(() => ({ ok: true })); const value = props({ onCommand }); const controller = createCampaignGrowthController();
    const review = controller.reviewRecovery(value, guard)!; controller.cancelRecovery(review);
    expect(controller.confirmRecovery(value, review).ok).toBe(false); expect(onCommand).not.toHaveBeenCalled();
    const nextReview = controller.reviewRecovery(value, guard)!; expect(nextReview).not.toBe(review);
    expect(controller.confirmRecovery(value, nextReview).ok).toBe(true);
  });
  it.each(['readOnly', 'busy', 'activeRun', 'epoch', 'basis', 'absent'] as const)('invalidates an open review after %s changes and never revives it', change => {
    const onCommand = vi.fn(() => ({ ok: true })); const value = props({ onCommand }); const controller = createCampaignGrowthController();
    const review = controller.reviewRecovery(value, guard)!;
    const next = change === 'epoch' ? { ...value, sessionEpoch: 5 } : change === 'basis' ? { ...value, basisStamp: 'changed' }
      : change === 'absent' ? { ...value, recovery: null } : { ...value, [change]: true };
    controller.observe(next); expect(controller.confirmRecovery(next, review).ok).toBe(false);
    expect(controller.confirmRecovery(value, review).ok).toBe(false); expect(onCommand).not.toHaveBeenCalled();
  });
  it('rejects fabricated review objects and incomplete consequence projections', () => {
    const value = props(); const controller = createCampaignGrowthController(); const review = controller.reviewRecovery(value, guard)!;
    expect(controller.confirmRecovery(value, { ...review }).ok).toBe(false);
    for (const section of ['losses', 'retained', 'grants'] as const) expect(canReviewCampaignRecovery(props({ recovery: { ...value.recovery!, [section]: [] } }), guard)).toBe(false);
    expect(canReviewCampaignRecovery(props({ recovery: null }), guard)).toBe(false);
  });
  it('shows exact supplied consequences in both languages and has a non-modal cancel path', () => {
    const value = props(); const review = createCampaignGrowthController().reviewRecovery(value, guard)!;
    for (const locale of ['zh-CN', 'en'] as const) {
      const markup = renderToStaticMarkup(<CampaignRecoveryConfirmation review={review} stale={false} blocked={false} t={(key, values) => translator(locale, key, values)} onCancel={() => {}} onConfirm={() => {}} />);
      const text = visible(markup); expect(text).toContain(definitions['test.loss']); expect(text).toContain(definitions['test.retained']); expect(text).toContain(definitions['test.grant']);
      expect(text).toContain(locale === 'zh-CN' ? '本次操作不会复活亡者' : 'does not revive the fallen');
      expect(markup).toContain('role="group"'); expect(markup).not.toContain('role="dialog"'); expect(text).not.toContain('文本暂不可用');
    }
    const stale = renderToStaticMarkup(<CampaignRecoveryConfirmation review={review} stale blocked={false} t={value.t} onCancel={() => {}} onConfirm={() => {}} />);
    expect(stale).toMatch(/class="campaign-growth-confirm" disabled/); expect(stale).toContain('role="alert"');
  });
});

describe('campaign growth locale proposal', () => {
  it('has complete Chinese and English entries with matching parameter specifications', () => {
    expect(validateLocales(zh, en, specifications)).toMatchObject({ valid: true, errors: [], missingEnglishKeys: [] });
    const english = visible(render(props({ t: (key, values) => translator('en', key, values) })));
    expect(english).toContain('The Sect Endures'); expect(english).toContain('Sect Estate'); expect(english).not.toContain('文本暂不可用');
  });
});
