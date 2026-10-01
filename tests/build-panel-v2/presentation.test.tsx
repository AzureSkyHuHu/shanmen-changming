import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { contentIdentity, LEGACY_V7_CONTENT, RELEASE_V8_CANDIDATE } from '../../src/content/registry';
import { resolveBuildContentContext } from '../../src/content/registry/build-context';
import { createBuildFrame } from '../../src/core/builds';
import { applyBuildAuthorityCommandV2, applyBuildCommandV2, createBuildFrameV2 } from '../../src/core/builds/v2';
import type { BuildAuthorityCommandV2, BuildContentContext, BuildStateFrameV2 } from '../../src/core/builds/v2-types';
import type { BuildCommand } from '../../src/core/builds/types';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { BuildPanel, buildDefinitionName, buildPanelProgress, createBuildPanelController, dispatchBuildPanelRequest, toggleBuildTreeDraft } from '../../src/app/BuildPanel';
import type { BuildPanelCommandResult, BuildPanelProps, BuildPanelRequest } from '../../src/app/BuildPanel';
import { translate, type TextKey } from '../../src/i18n';

const context = resolveBuildContentContext(contentIdentity(RELEASE_V8_CANDIDATE), { allowCandidate: true })!;
const catalog = context.catalog;
type Body<T> = T extends T ? Omit<T, 'commandId' | 'expectedRevision'> : never;
function fresh(): BuildStateFrameV2 {
  return createBuildFrameV2({ disciples: [{ discipleId: 'entity:1', school: 'sword' }, { discipleId: 'entity:2', school: 'body' },
    { discipleId: 'entity:3', school: 'alchemy' }, { discipleId: 'entity:4', school: 'talisman' }], contentMode: 'experimental' }, context);
}
function authority(frame: BuildStateFrameV2, body: Body<BuildAuthorityCommandV2>): BuildStateFrameV2 {
  const result = applyBuildAuthorityCommandV2(frame, { ...body, commandId: `authority/${frame.builds.revision}`, expectedRevision: frame.builds.revision } as BuildAuthorityCommandV2, context);
  if (!result.ok) throw new Error(result.code); return result.frame;
}
function player(frame: BuildStateFrameV2, body: Body<BuildCommand>): BuildStateFrameV2 {
  const result = applyBuildCommandV2(frame, { ...body, commandId: `player/${frame.builds.revision}`, expectedRevision: frame.builds.revision } as BuildCommand, context);
  if (!result.ok) throw new Error(result.code); return result.frame;
}
function award(frame = fresh()): BuildStateFrameV2 {
  return authority(frame, { kind: 'milestone.award', discipleId: 'entity:1', ruleId: 'realm.qi', milestoneId: 'milestone/qi' });
}
function props(frame = fresh(), overrides: Partial<BuildPanelProps> = {}): BuildPanelProps {
  return { frame, context, catalog, discipleId: 'entity:1', locale: 'zh-CN', lifeState: 'alive', onCommand: () => ({ ok: true }), ...overrides };
}
function request(frame: BuildStateFrameV2): BuildPanelRequest {
  return { kind: 'tree.respec', discipleId: 'entity:1', nodeIds: ['node.sword.liuhen'], expectedRevision: frame.builds.revision };
}
const render = (value: BuildPanelProps) => renderToStaticMarkup(<BuildPanel {...value} />);
const visible = (markup: string) => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
function selectedValue(markup: string, suffix: string): string | undefined {
  const select = markup.match(new RegExp(`<select[^>]+id="[^"]*${suffix}"[^>]*>([\\s\\S]*?)</select>`))?.[1];
  return select?.match(/<option[^>]+value="([^"]+)"[^>]+selected=""/)?.[1];
}

// These are authoritative reducer fixtures, not invented earned rewards or forged display ownership.
describe('v2 permanent build presentation', () => {
  it('keeps legacy frames and helper calls working without a v2 context or life-state prop', () => {
    const frame = createBuildFrame({ disciples: [{ discipleId: 'entity:1', school: 'sword' }], contentMode: 'experimental' }, LEGACY_V7_CONTENT.combat);
    const onCommand = vi.fn(() => ({ ok: true }));
    const value: BuildPanelProps = { frame, catalog: LEGACY_V7_CONTENT.combat, discipleId: 'entity:1', locale: 'zh-CN', onCommand };
    expect(visible(render(value))).toContain('练功木剑'); expect(render(value).match(/<select\b/g)).toHaveLength(6);
    expect(dispatchBuildPanelRequest(value, { kind: 'tree.respec', discipleId: 'entity:1', nodeIds: [], expectedRevision: 0 }).ok).toBe(true);
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(visible(render({ ...value, context }))).toContain('内容已变化');
  });

  it.each([
    ['equipment.trail-robe', 'robe', '行山衣', 'Trail Robe'],
    ['equipment.apothecary-vessel', 'artifact', '药泉瓶', 'Apothecary Vessel'],
    ['equipment.storm-focus', 'artifact', '鸣雷石', 'Storm Focus'],
    ['equipment.guardian-robe', 'robe', '守岳袍', 'Guardian Robe'],
  ] as const)('renders the registered name and description for owned %s in both locales', (definitionId, slot, zh, en) => {
    let frame = authority(fresh(), { kind: 'equipment.grant', discipleId: 'entity:1', definitionId, acquisitionId: `earned/${definitionId}` });
    const item = frame.builds.equipment.at(-1)!; const disciple = frame.builds.disciples[0]!;
    frame = player(frame, { kind: 'loadout.set', discipleId: disciple.discipleId,
      loadout: { ...disciple.loadout, equipment: { ...disciple.loadout.equipment, [`${slot}Id`]: item.instanceId } } });
    const definition = context.rules.equipment.find(entry => entry.id === definitionId)! as { nameKey?: string; descriptionKey?: string };
    const before = canonicalStringify(frame);
    for (const [locale, expectedName] of [['zh-CN', zh], ['en', en]] as const) {
      const markup = render(props(frame, { locale })); const text = visible(markup);
      expect(buildDefinitionName(locale, definitionId, catalog, context)).toBe(expectedName);
      expect(text).toContain(expectedName); expect(text).toContain(translate(locale, definition.descriptionKey as TextKey));
      expect(selectedValue(markup, `-gear-${slot}`)).toBe(item.instanceId);
      expect(text).not.toMatch(/(?:equipment|campaign|instance|entity)[.:][a-z0-9]/); expect(text).not.toContain('文本暂不可用');
    }
    expect(canonicalStringify(frame)).toBe(before);
  });

  it('uses actual owner variants, excludes estate/foreign equipment and keeps school restrictions', () => {
    let frame = authority(fresh(), { kind: 'equipment.grant', discipleId: 'entity:2', definitionId: 'equipment.storm-focus', acquisitionId: 'foreign/reward' });
    frame = authority(frame, { kind: 'equipment.grant', discipleId: 'entity:1', definitionId: 'equipment.trail-robe', acquisitionId: 'estate/reward' });
    const estateItem = frame.builds.equipment.at(-1)!;
    const swordWeapon = frame.builds.disciples[0]!.loadout.equipment.weaponId;
    frame = authority(frame, { kind: 'disciple.retire', discipleId: 'entity:1', deathId: 'death/1' });
    frame = authority(frame, { kind: 'equipment.transfer', transferId: 'estate/1', itemInstanceId: estateItem.instanceId,
      fromOwner: { kind: 'disciple', discipleId: 'entity:1' }, toOwner: { kind: 'sect-estate' }, reason: { kind: 'death', deathId: 'death/1' } });
    frame = authority(frame, { kind: 'equipment.transfer', transferId: 'heir/1', itemInstanceId: swordWeapon,
      fromOwner: { kind: 'disciple', discipleId: 'entity:1' }, toOwner: { kind: 'disciple', discipleId: 'entity:2' }, reason: { kind: 'death', deathId: 'death/1' } });
    const body = render(props(frame, { discipleId: 'entity:2' }));
    expect(visible(body)).toContain('鸣雷石'); expect(visible(body)).not.toContain('行山衣'); expect(body).not.toContain(`value="${estateItem.instanceId}"`);
    expect(body).not.toContain(`value="${swordWeapon}"`); expect(visible(body)).not.toContain('练功木剑');
    const alchemy = render(props(frame, { discipleId: 'entity:3' })); expect(visible(alchemy)).not.toContain('鸣雷石');
  });

  it('shows inherited gear on a locked heir without equipping it or enabling mutation', () => {
    let frame = authority(fresh(), { kind: 'equipment.grant', discipleId: 'entity:1', definitionId: 'equipment.trail-robe', acquisitionId: 'earned/robe' });
    const item = frame.builds.equipment.at(-1)!;
    frame = authority(frame, { kind: 'expedition.lock', runId: 'run/1', locks: [{ discipleId: 'entity:2', lockId: 'lock/2' }] });
    const heirBefore = frame.builds.disciples.find(entry => entry.discipleId === 'entity:2')!;
    frame = authority(frame, { kind: 'disciple.retire', discipleId: 'entity:1', deathId: 'death/1' });
    frame = authority(frame, { kind: 'equipment.transfer', transferId: 'heir/robe', itemInstanceId: item.instanceId,
      fromOwner: { kind: 'disciple', discipleId: 'entity:1' }, toOwner: { kind: 'disciple', discipleId: 'entity:2' }, reason: { kind: 'death', deathId: 'death/1' } });
    const onCommand = vi.fn(() => ({ ok: true })); const value = props(frame, { discipleId: 'entity:2', onCommand }); const markup = render(value);
    expect(visible(markup)).toContain('行山衣'); expect(visible(markup)).toContain('出征配装已锁定');
    for (const select of markup.match(/<select\b[^>]*>/g) ?? []) expect(select).toContain('disabled');
    expect(selectedValue(markup, '-gear-robe')).toBe(heirBefore.loadout.equipment.robeId);
    expect(frame.builds.disciples.find(entry => entry.discipleId === 'entity:2')).toEqual(heirBefore);
    expect(dispatchBuildPanelRequest(value, { kind: 'loadout.set', discipleId: 'entity:2', expectedRevision: frame.builds.revision,
      loadout: { ...heirBefore.loadout, equipment: { ...heirBefore.loadout.equipment, robeId: item.instanceId } } })).toEqual({ ok: false, code: 'EXPEDITION_LOCKED' });
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('counts archive and teaching knowledge without charging credits or equipping it implicitly', () => {
    let frame = authority(fresh(), { kind: 'skill.grantKnowledge', discipleId: 'entity:3', skillId: 'skill.qingxin', acquisitionId: 'archive/1',
      provenance: { kind: 'archive', knowledgeId: 'knowledge.clear-heart' } });
    frame = authority(frame, { kind: 'disciple.enroll', discipleId: 'entity:50', school: 'alchemy', acquisitionId: 'recruit/1' });
    frame = authority(frame, { kind: 'skill.grantKnowledge', discipleId: 'entity:50', skillId: 'skill.qingxin', acquisitionId: 'teaching/1',
      provenance: { kind: 'teaching', knowledgeId: 'knowledge.clear-heart', teacherId: 'entity:3', teachingId: 'teaching/lesson' } });
    for (const discipleId of ['entity:3', 'entity:50']) {
      const markup = render(props(frame, { discipleId })); const text = visible(markup);
      expect(buildPanelProgress(frame, discipleId)?.spentLearningCredits).toBe(0);
      expect(text).toContain('已习得 4 项技艺'); expect(text).toContain('研习额度 0 / 已获 0');
      expect(markup).toContain('value="skill.qingxin"'); expect(selectedValue(markup, '-active-0')).toBe('skill.qingwu');
      const member = frame.builds.disciples.find(entry => entry.discipleId === discipleId)!;
      expect(member.sources.some(source => source.sourceDefinitionId === 'skill.qingxin')).toBe(false);
    }
  });

  it.each(['dead', 'pendingDeath', undefined, null] as const)('blocks v2 mutation for lifeState=%s at display and callback boundaries', lifeState => {
    const frame = award(); const onCommand = vi.fn(() => ({ ok: true })); const value = props(frame, { lifeState, onCommand }); const markup = render(value);
    for (const select of markup.match(/<select\b[^>]*>/g) ?? []) expect(select).toContain('disabled');
    for (const button of markup.match(/<button\b[^>]*class="build-node-toggle"[^>]*>/g) ?? []) expect(button).toContain('disabled');
    expect(visible(markup)).toContain('只读模式');
    expect(dispatchBuildPanelRequest(value, request(frame))).toEqual({ ok: false, code: 'INVALID_COMMAND' }); expect(onCommand).not.toHaveBeenCalled();
  });

  it('renders retired knowledge as readonly history with no nonexistent loadout or active controls', () => {
    const frame = authority(fresh(), { kind: 'disciple.retire', discipleId: 'entity:1', deathId: 'death/1' });
    const onCommand = vi.fn(() => ({ ok: true })); const value = props(frame, { discipleName: '故人', onCommand }); const markup = render(value);
    expect(visible(markup)).toContain('故人的修行谱'); expect(visible(markup)).toContain('已故'); expect(visible(markup)).toContain('已习得 3 项技艺');
    expect(markup).not.toContain('<select'); expect(markup).not.toContain('<button'); expect(visible(markup)).not.toContain('请选择一位弟子');
    expect(dispatchBuildPanelRequest(value, request(frame))).toEqual({ ok: false, code: 'UNKNOWN_DISCIPLE' }); expect(onCommand).not.toHaveBeenCalled();
  });

  it('does not inspect or replay full history, receipts, origin or sequences during render', () => {
    const frame = award(); const history = vi.fn(() => { throw new Error('No history read in the display'); });
    const guarded = { ...frame, builds: { ...frame.builds } };
    for (const key of ['history', 'receipts', 'origin']) Object.defineProperty(guarded.builds, key, { get: history });
    Object.defineProperty(guarded, 'sequences', { get: history });
    expect(visible(render(props(guarded)))).toContain('已获 1 点'); expect(history).not.toHaveBeenCalled();
  });
});

describe('selected content verification', () => {
  it.each([undefined, null])('fails closed for v2 without context=%s', selectedContext => {
    const frame = award(); const onCommand = vi.fn(() => ({ ok: true })); const value = props(frame, { context: selectedContext, onCommand });
    const markup = render(value); expect(visible(markup)).toContain('内容已变化'); expect(markup).not.toContain('<select'); expect(markup).not.toContain('<button');
    expect(dispatchBuildPanelRequest(value, request(frame))).toEqual({ ok: false, code: 'CONTENT_MISMATCH' });
    expect(toggleBuildTreeDraft(frame, catalog, 'entity:1', [], 'node.sword.liuhen', selectedContext)).toEqual({ ok: false, code: 'CONTENT_MISMATCH' });
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('rejects a substituted catalog, rule object, identity or legacy reference instead of falling back', () => {
    const frame = award(); const onCommand = vi.fn(() => ({ ok: true }));
    const invalid: Partial<BuildPanelProps>[] = [
      { catalog: LEGACY_V7_CONTENT.combat },
      { context: { ...context, catalog: cloneJson(catalog) } },
      { context: { ...context, rules: cloneJson(context.rules) } },
      { context: { ...context, rules: { ...context.rules, lessons: context.rules.lessons.map(lesson => ({ ...lesson, creditCost: 0 })) } } },
      { context: { ...context, identity: { ...context.identity, compositeFingerprint: '00000000' } } },
      { context: { ...context, legacy: { ...context.legacy, catalog: cloneJson(context.legacy.catalog) } } },
      { context: resolveBuildContentContext(contentIdentity(LEGACY_V7_CONTENT))! },
      { frame: { ...frame, builds: { ...frame.builds, rulesHash: '00000000' } } },
      { frame: { ...frame, builds: { ...frame.builds, contentIdentity: { ...frame.builds.contentIdentity, registryId: 'unknown/version' } } } },
    ];
    for (const override of invalid) {
      const value = props(frame, { ...override, onCommand }); const markup = render(value);
      expect(visible(markup)).toContain('内容已变化'); expect(markup).not.toContain('<select');
      expect(dispatchBuildPanelRequest(value, request(frame))).toEqual({ ok: false, code: 'CONTENT_MISMATCH' });
    }
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('accepts new wrappers around registered immutable references without allowing later identity tampering', () => {
    const frame = award(); const selectedContext: BuildContentContext = { ...context, identity: { ...context.identity }, legacy: { ...context.legacy } };
    expect(visible(render(props(frame, { context: selectedContext })))).toContain('已获 1 点');
    selectedContext.identity = { ...selectedContext.identity, buildRulesVersion: 1 };
    expect(visible(render(props(frame, { context: selectedContext })))).toContain('内容已变化');
  });

  it('uses selected lessons and allocation limits while keeping all authority outside the panel', () => {
    const frame = award(); const markup = render(props(frame)); const cangfeng = context.rules.lessons.find(lesson => lesson.skillId === 'skill.cangfeng')!;
    expect(visible(markup)).toContain(`研习 · 消耗 ${cangfeng.creditCost} 额度`);
    expect(toggleBuildTreeDraft(frame, catalog, 'entity:1', [], 'node.sword.liuhen', context)).toEqual({ ok: true, nodeIds: ['node.sword.liuhen'] });
    const source = readFileSync(new URL('../../src/app/BuildPanel.tsx', import.meta.url), 'utf8');
    expect(source).toContain('content.lessons.find'); expect(source).toContain('content.maximumAllocatedPoints');
    expect(source).not.toContain('skillLearningRule('); expect(source).not.toContain('equipmentDefinition(');
    expect(source).not.toContain('validateBuildFrame'); expect(source).not.toContain('applyBuildAuthorityCommand');
  });
});

describe('synchronous mutation latch and stale guards', () => {
  it('dispatches only once before a real revision changes and rejects an old request afterwards', () => {
    const frame = award(); const onCommand = vi.fn(() => ({ ok: true })); const value = props(frame, { onCommand }); const controller = createBuildPanelController();
    expect(controller.submit(value, request(frame)).ok).toBe(true); expect(controller.pending(value)).toBe(true);
    expect(controller.submit(value, request(frame)).ok).toBe(false);
    expect(controller.submit(value, { kind: 'skill.learn', discipleId: 'entity:1', skillId: 'skill.cangfeng', expectedRevision: frame.builds.revision }).ok).toBe(false);
    expect(onCommand).toHaveBeenCalledTimes(1);
    const next = authority(frame, { kind: 'milestone.award', discipleId: 'entity:1', ruleId: 'realm.foundation', milestoneId: 'milestone/foundation' });
    const latest = props(next, { onCommand }); expect(controller.pending(latest)).toBe(false);
    expect(controller.submit(latest, request(frame))).toEqual({ ok: false, code: 'REVISION_CONFLICT' });
    expect(controller.submit(latest, request(next)).ok).toBe(true); expect(onCommand).toHaveBeenCalledTimes(2);
  });

  it('does not duplicate rejected requests while allowing a different corrected intent', () => {
    const frame = award(); const onCommand = vi.fn((): BuildPanelCommandResult => ({ ok: false, code: 'MISSING_PREREQUISITE' }));
    const value = props(frame, { onCommand }); const controller = createBuildPanelController();
    expect(controller.submit(value, request(frame))).toEqual({ ok: false, code: 'MISSING_PREREQUISITE' });
    expect(controller.pending(value)).toBe(false); expect(controller.submit(value, request(frame))).toEqual({ ok: false, code: 'COMMAND_CONFLICT' });
    expect(controller.submit(value, { ...request(frame), kind: 'tree.respec', nodeIds: [] }).ok).toBe(false);
    expect(onCommand).toHaveBeenCalledTimes(2);
  });

  it('latches callback exceptions and malformed replies until authoritative state advances', () => {
    const frame = award();
    for (const callback of [() => { throw new Error('unknown result'); }, () => undefined as unknown as BuildPanelCommandResult]) {
      const onCommand = vi.fn(callback); const value = props(frame, { onCommand }); const controller = createBuildPanelController();
      expect(controller.submit(value, request(frame))).toEqual({ ok: false, code: 'INVALID_COMMAND' });
      expect(controller.pending(value)).toBe(true); expect(controller.submit(value, request(frame)).ok).toBe(false); expect(onCommand).toHaveBeenCalledTimes(1);
    }
  });

  it('blocks synchronous callback reentrancy and copies intents before dispatch', () => {
    const frame = award(); const controller = createBuildPanelController(); const original = request(frame); const before = cloneJson(original);
    const onCommand = vi.fn((body: BuildPanelRequest): BuildPanelCommandResult => {
      expect(controller.submit(value, original)).toEqual({ ok: false, code: 'REVISION_CONFLICT' });
      if (body.kind === 'tree.respec') (body.nodeIds as string[]).push('node.sword.yangfeng'); return { ok: true };
    });
    const value = props(frame, { onCommand }); expect(controller.submit(value, original).ok).toBe(true);
    expect(onCommand).toHaveBeenCalledTimes(1); expect(original).toEqual(before); expect(onCommand.mock.calls[0]![0]).not.toHaveProperty('commandId');
  });

  it('rejects authority-shaped, injected-ID and foreign-disciple requests in v2 too', () => {
    const frame = award(); const onCommand = vi.fn(() => ({ ok: true })); const value = props(frame, { onCommand }); const controller = createBuildPanelController();
    for (const bad of [{ ...request(frame), discipleId: 'entity:2' }, { ...request(frame), commandId: 'injected' },
      { kind: 'disciple.retire', discipleId: 'entity:1', deathId: 'death/forged', expectedRevision: frame.builds.revision }]) {
      expect(controller.submit(value, bad as BuildPanelRequest).ok).toBe(false);
    }
    expect(onCommand).not.toHaveBeenCalled();
  });
});
