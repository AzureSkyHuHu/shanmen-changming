import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { combatCatalog } from '../../src/content/definitions';
import { prepareCombatCatalog } from '../../src/core/combat/runtime';
import { applyBuildAuthorityCommand, applyBuildCommand, createBuildFrame, MILESTONE_RULE_IDS } from '../../src/core/builds';
import type { BuildAuthorityCommand, BuildCommand, BuildStateFrame } from '../../src/core/builds';
import { cloneJson, canonicalStringify } from '../../src/core/kernel/serialization';
import { BuildPanel, buildDefinitionDescription, buildDefinitionName, buildPanelProgress, buildSkillTiming, buildSupportExplanation, buildText, dispatchBuildPanelRequest, toggleBuildTreeDraft } from '../../src/app/BuildPanel';
import type { BuildPanelProps, BuildPanelRequest } from '../../src/app/BuildPanel';
import { createTranslator, validateLocales } from '../../src/i18n';
import type { MessageSpecifications } from '../../src/i18n/types';
import localeFixture from './locales.fixture.json';

const catalog = prepareCombatCatalog(combatCatalog);
const make = () => createBuildFrame({ disciples: [
  { discipleId: 'entity:1', school: 'sword' }, { discipleId: 'entity:2', school: 'body' },
  { discipleId: 'entity:3', school: 'alchemy' }, { discipleId: 'entity:4', school: 'talisman' },
], contentMode: 'experimental' }, catalog);
function award(frame: BuildStateFrame, count = 5): BuildStateFrame {
  for (const ruleId of MILESTONE_RULE_IDS.slice(0, count)) {
    const next = applyBuildAuthorityCommand(frame, { kind: 'milestone.award', commandId: `award:${frame.builds.revision}`, expectedRevision: frame.builds.revision, discipleId: 'entity:1', ruleId, milestoneId: `fact/${ruleId}` }, catalog);
    if (!next.ok) throw new Error(next.code); frame = next.frame;
  }
  return frame;
}
function props(frame: BuildStateFrame = make(), overrides: Partial<BuildPanelProps> = {}): BuildPanelProps {
  return { frame, catalog, discipleId: 'entity:1', locale: 'zh-CN', onCommand: () => ({ ok: true }), ...overrides };
}
function visible(markup: string): string { return markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '); }
const root = 'node.sword.liuhen'; const middle = 'node.sword.yangfeng'; const terminal = 'node.sword.guichao';

describe('readonly permanent build presentation', () => {
  it('renders four-school navigation, a real three-by-three native tree, source names and actual zero points', () => {
    const frame = make(); const before = canonicalStringify(frame);
    const markup = renderToStaticMarkup(<BuildPanel {...props(frame)} />); const text = visible(markup);
    expect(text).toContain('经脉与配装'); expect(text).toContain('剑修'); expect(text).toContain('体修'); expect(text).toContain('丹修'); expect(text).toContain('符修');
    expect(markup.match(/class="build-branch"/g)).toHaveLength(3); expect(markup.match(/class="build-node"/g)).toHaveLength(9);
    expect(text).toContain('已获 0 点'); expect(text).toContain('已用 0 点'); expect(text).toContain('可用 0 点');
    expect(text).toContain('留痕'); expect(text).toContain('养锋'); expect(text).toContain('归潮'); expect(text).toContain('前置：留痕');
    expect(text).not.toMatch(/(?:node|skill|tree|equipment)\.[a-z]/); expect(text).not.toMatch(/(?:entity|instance):\d/);
    expect(canonicalStringify(frame)).toBe(before);
  });
  it('renders all four real native-school trees without changing the disciple school', () => {
    const frame = make();
    for (const disciple of frame.builds.disciples) {
      const markup = renderToStaticMarkup(<BuildPanel {...props(frame, { discipleId: disciple.discipleId })} />);
      const text = visible(markup);
      expect(markup.match(/class="build-node"/g)).toHaveLength(9);
      for (const node of catalog.treeNodes.filter(node => node.school === disciple.school)) expect(text).toContain(buildDefinitionName('zh-CN', node.id, catalog));
      expect(buildPanelProgress(frame, disciple.discipleId)?.earnedPoints).toBe(0);
    }
  });
  it('uses exact awards and permanent study records instead of invented visual progress', () => {
    const frame = award(make());
    expect(buildPanelProgress(frame, 'entity:1')).toEqual({ earnedPoints: 5, allocatedPoints: 0, availablePoints: 5, earnedLearningCredits: 10, spentLearningCredits: 0, availableLearningCredits: 10 });
    const learned = applyBuildCommand(frame, { kind: 'skill.learn', commandId: 'study:1', expectedRevision: frame.builds.revision, discipleId: 'entity:1', skillId: 'skill.cangfeng' }, catalog);
    if (!learned.ok) throw new Error(learned.code);
    const markup = renderToStaticMarkup(<BuildPanel {...props(learned.frame)} />);
    expect(visible(markup)).toContain('研习额度 8 / 已获 10'); expect(visible(markup)).toContain('已习得 4 项技艺');
    expect(learned.frame.builds.disciples[0]!.loadout.passiveSkillId).toBe('skill.jianxin');
    expect(buildPanelProgress(frame, 'entity:unknown')).toBeNull();
  });
  it('shows valid complete slots and named, exclusively owned equipment', () => {
    const frame = make(); const markup = renderToStaticMarkup(<BuildPanel {...props(frame)} />); const text = visible(markup);
    expect(text).toContain('主动一'); expect(text).toContain('主动二'); expect(text).toContain('被动'); expect(text).toContain('留痕剑'); expect(text).toContain('归锋');
    expect(text).toContain('练功木剑'); expect(text).toContain('素纹法衣'); expect(text).toContain('聚气佩');
    expect(text).toContain('攻击 +3'); expect(text).toContain('气血上限 +20'); expect(text).toContain('灵力上限 +20');
    expect(markup.match(/<select\b/g)).toHaveLength(6);
    for (const foreign of frame.builds.equipment.filter(item => item.ownerDiscipleId !== 'entity:1')) expect(markup).not.toContain(`value="${foreign.instanceId}"`);
    expect(text).not.toContain('milestone.award'); expect(text).not.toContain('equipment.grant');
  });
  it('provides field labels, non-submit buttons, selection states and live feedback', () => {
    const markup = renderToStaticMarkup(<BuildPanel {...props()} />);
    expect(markup).toContain('aria-labelledby='); expect(markup).toContain('aria-describedby='); expect(markup).toContain('aria-pressed='); expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain('<form');
    for (const button of markup.match(/<button\b[^>]*>/g) ?? []) expect(button).toContain('type="button"');
    for (const select of markup.match(/<select\b[^>]*>/g) ?? []) {
      const id = /id="([^"]+)"/.exec(select)?.[1]; expect(id).toBeTruthy(); expect(markup).toContain(`for="${id}"`);
    }
  });
  it('disables every mutation control in read-only or expedition-locked views', () => {
    for (const flags of [{ readOnly: true }, { locked: true }]) {
      const markup = renderToStaticMarkup(<BuildPanel {...props(make(), flags)} />);
      for (const node of markup.match(/<button\b[^>]*class="build-node-toggle"[^>]*>/g) ?? []) expect(node).toContain('disabled');
      for (const select of markup.match(/<select\b[^>]*>/g) ?? []) expect(select).toContain('disabled');
      expect(visible(markup)).toContain(flags.readOnly ? '只读模式' : '出征配装已锁定');
    }
    const frame = make();
    const locked = applyBuildAuthorityCommand(frame, { kind: 'expedition.lock', commandId: 'lock:1', expectedRevision: 0, runId: 'run:1', locks: [{ discipleId: 'entity:1', lockId: 'lock:1' }] }, catalog);
    if (!locked.ok) throw new Error(locked.code);
    expect(visible(renderToStaticMarkup(<BuildPanel {...props(locked.frame)} />))).toContain('出征配装已锁定');
  });
  it('shows an empty-selection notice rather than creating a disciple or data', () => {
    const frame = createBuildFrame({ disciples: [], contentMode: 'experimental' }, catalog);
    const text = visible(renderToStaticMarkup(<BuildPanel {...props(frame)} />));
    expect(text).toContain('请选择一位弟子'); expect(frame.builds.disciples).toEqual([]); expect(frame.builds.equipment).toEqual([]);
  });
});

describe('staged tree changes and guarded command submission', () => {
  it('drafts prerequisite chains, enforces the earned budget, and removes descendants together', () => {
    const empty = make(); expect(toggleBuildTreeDraft(empty, catalog, 'entity:1', [], root)).toEqual({ ok: false, code: 'INSUFFICIENT_POINTS' });
    const frame = award(empty); const before = canonicalStringify(frame);
    expect(toggleBuildTreeDraft(frame, catalog, 'entity:1', [], terminal)).toEqual({ ok: false, code: 'MISSING_PREREQUISITE' });
    const first = toggleBuildTreeDraft(frame, catalog, 'entity:1', [], root); expect(first).toEqual({ ok: true, nodeIds: [root] });
    const second = toggleBuildTreeDraft(frame, catalog, 'entity:1', [root], middle); expect(second).toEqual({ ok: true, nodeIds: [root, middle] });
    expect(toggleBuildTreeDraft(frame, catalog, 'entity:1', [root, middle], terminal)).toEqual({ ok: true, nodeIds: [root, middle, terminal] });
    expect(toggleBuildTreeDraft(frame, catalog, 'entity:1', [root, middle, terminal], root)).toEqual({ ok: true, nodeIds: [] });
    expect(toggleBuildTreeDraft(frame, catalog, 'entity:1', [root, middle, terminal], middle)).toEqual({ ok: true, nodeIds: [root] });
    expect(toggleBuildTreeDraft(frame, catalog, 'entity:1', [], 'node.body.houtu')).toMatchObject({ ok: false });
    expect(canonicalStringify(frame)).toBe(before);
  });
  it('never submits a stale draft at a newer revision and never allocates command IDs in the panel', () => {
    const frame = award(make()); const onCommand = vi.fn((_request: BuildPanelRequest) => ({ ok: true }));
    const request: BuildPanelRequest = { kind: 'tree.respec', expectedRevision: frame.builds.revision - 1, discipleId: 'entity:1', nodeIds: [root] };
    expect(dispatchBuildPanelRequest(props(frame, { onCommand }), request)).toEqual({ ok: false, code: 'REVISION_CONFLICT' }); expect(onCommand).not.toHaveBeenCalled();
    const fresh = { ...request, expectedRevision: frame.builds.revision };
    expect(dispatchBuildPanelRequest(props(frame, { onCommand }), fresh)).toEqual({ ok: true });
    expect(onCommand).toHaveBeenCalledWith(fresh); expect(onCommand.mock.calls[0]![0]).not.toHaveProperty('commandId');
  });
  it('guards against programmatic read-only, locked, foreign-disciple and authority requests', () => {
    const frame = award(make()); const onCommand = vi.fn((_request: BuildPanelRequest) => ({ ok: true }));
    const request: BuildPanelRequest = { kind: 'tree.respec', expectedRevision: frame.builds.revision, discipleId: 'entity:1', nodeIds: [root] };
    expect(dispatchBuildPanelRequest(props(frame, { readOnly: true, onCommand }), request).ok).toBe(false);
    expect(dispatchBuildPanelRequest(props(frame, { locked: true, onCommand }), request).ok).toBe(false);
    expect(dispatchBuildPanelRequest(props(frame, { onCommand }), { ...request, discipleId: 'entity:2' }).ok).toBe(false);
    const authority: BuildAuthorityCommand = { kind: 'milestone.award', commandId: 'forged:1', expectedRevision: frame.builds.revision, discipleId: 'entity:1', milestoneId: 'fact:forged', ruleId: 'realm.qi' };
    expect(dispatchBuildPanelRequest(props(frame, { onCommand }), authority as unknown as BuildPanelRequest).ok).toBe(false);
    expect(dispatchBuildPanelRequest(props(frame, { onCommand }), { ...request, commandId: 'forged:2' } as unknown as BuildPanelRequest).ok).toBe(false);
    expect(onCommand).not.toHaveBeenCalled();
  });
  it('lets the actual reducer reject missing prerequisites without optimistic state changes', () => {
    const frame = award(make()); const before = canonicalStringify(frame);
    const request: BuildPanelRequest = { kind: 'tree.respec', discipleId: 'entity:1', nodeIds: [terminal], expectedRevision: frame.builds.revision };
    const onCommand = (body: BuildPanelRequest) => { const result = applyBuildCommand(frame, { ...body, commandId: 'player:real' } as BuildCommand, catalog); return result.ok ? { ok: true } : { ok: false, code: result.code }; };
    expect(dispatchBuildPanelRequest(props(frame, { onCommand }), request)).toEqual({ ok: false, code: 'MISSING_PREREQUISITE' });
    expect(canonicalStringify(frame)).toBe(before);
  });
  it('copies the request before crossing the callback boundary', () => {
    const frame = award(make()); const ids = [root];
    const request: BuildPanelRequest = { kind: 'tree.respec', discipleId: 'entity:1', nodeIds: ids, expectedRevision: frame.builds.revision };
    const onCommand = (body: BuildPanelRequest) => { if (body.kind === 'tree.respec') (body.nodeIds as string[]).push(middle); return { ok: true }; };
    expect(dispatchBuildPanelRequest(props(frame, { onCommand }), request).ok).toBe(true); expect(ids).toEqual([root]);
  });
});

describe('localized authored names, seconds and support explanations', () => {
  it('reuses combat names, supports a localized name resolver, and never falls back to a raw ID', () => {
    expect(buildDefinitionName('zh-CN', 'skill.liuhen-jian', catalog)).toBe('留痕剑');
    expect(buildDefinitionName('en', 'skill.liuhen-jian', catalog)).toBe('Traceblade');
    expect(buildDefinitionName('en', 'node.sword.liuhen', catalog)).toBe('Lasting Trace');
    expect(buildDefinitionName('en', 'skill.unknown', catalog)).not.toContain('skill.unknown');
    const text = visible(renderToStaticMarkup(<BuildPanel {...props(make(), { discipleName: '林清', nameFor: id => id === root ? '本地化留痕' : id })} />));
    expect(text).toContain('林清的修行谱'); expect(text).toContain('本地化留痕'); expect(text).not.toContain('skill.liuhen-jian');
  });
  it('formats live action values as seconds and never exposes simulation ticks in descriptions', () => {
    for (const skill of catalog.skills) {
      for (const locale of ['zh-CN', 'en'] as const) {
        const description = buildDefinitionDescription(locale, skill);
        expect(description).not.toMatch(/\bticks?\b|\d+\s*刻|cooldownTicks|castTicks/);
        const timing = buildSkillTiming(skill);
        if (skill.activation === 'active') {
          expect(timing).toEqual({ cost: skill.action.spiritCostUnits, cooldown: skill.action.cooldownTicks / 20, cast: skill.action.castTicks / 20 });
          expect(buildText(locale, 'skillTiming', timing!)).not.toMatch(/\bticks?\b|\d+\s*刻/);
        } else expect(timing).toBeNull();
      }
    }
    const english = visible(renderToStaticMarkup(<BuildPanel {...props(make(), { locale: 'en' })} />));
    expect(english).toContain('Cooldown'); expect(english).not.toMatch(/cooldownTicks|\bticks?\b/);
  });
  it('exposes implemented spatial skills while keeping genuine unsupported reasons readable', () => {
    const sword = visible(renderToStaticMarkup(<BuildPanel {...props(award(make()))} />));
    expect(sword).toContain(buildDefinitionName('zh-CN', 'skill.wanjian-chaozong', catalog)); expect(sword).not.toContain('持续区域效果尚未开放');
    const body = visible(renderToStaticMarkup(<BuildPanel {...props(make(), { discipleId: 'entity:2', locale: 'en' })} />));
    expect(body).toContain(buildDefinitionName('en', 'skill.yuanhu', catalog)); expect(body).not.toContain('Movement effects are not available yet'); expect(body).not.toContain('capability');
    const talisman = visible(renderToStaticMarkup(<BuildPanel {...props(make(), { discipleId: 'entity:4' })} />));
    expect(talisman).toContain(buildDefinitionName('zh-CN', 'skill.zhikui', catalog)); expect(talisman).not.toContain('召唤效果尚未开放');
    expect(buildSupportExplanation('zh-CN', ['Unsupported adjustment: additionalChainTargets.staggerTicks (talent.test)'])).toBe('额外连锁目标的失衡效果尚未开放。');
    expect(buildSupportExplanation('en', ['Unverified combat definition: skill.example'])).not.toContain('skill.example');
  });
  it('has matching zh/en parameter specs and Chinese fallback for every new interface key', () => {
    const specifications = localeFixture.specifications as MessageSpecifications;
    const issues = validateLocales(localeFixture.zhCN, localeFixture.en, specifications);
    expect(issues.errors).toEqual([]); expect(issues.missingEnglishKeys).toEqual([]);
    const translate = createTranslator({ baseCatalog: localeFixture.zhCN, englishCatalog: {}, specifications });
    expect(translate('en', 'buildView.title')).toBe('经脉与配装');
    expect(Object.keys(localeFixture.zhCN).sort()).toEqual(Object.keys(localeFixture.en).sort());
  });
  it('includes responsive container layout, visible keyboard focus and reduced-motion support', () => {
    const css = readFileSync(resolve('src/app/build-panel.css'), 'utf8');
    expect(css).toContain('@container build-ledger'); expect(css).toContain(':focus-visible'); expect(css).toContain('prefers-reduced-motion');
    const source = readFileSync(resolve('src/app/BuildPanel.tsx'), 'utf8');
    expect(source).not.toContain('applyBuildAuthorityCommand'); expect(source).not.toContain('Math.random'); expect(source).not.toContain('Date.now');
    expect(source).toContain('currentDraft.expectedRevision !== frame.builds.revision');
  });
});
