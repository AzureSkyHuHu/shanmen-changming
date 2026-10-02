import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { ApplicationSessionV9, type BuildRequestV9, type SessionCommandResultV9 } from '../../src/application/session-v9';
import { createManagementBuildControllerV9, managementBuildBlockedV9, managementBuildContentV9, managementBuildEquipmentV9,
  managementBuildIntentGuardV9, managementBuildLearnErrorV9, managementBuildRequestErrorV9, managementBuildResultV9,
  managementBuildToggleNodeV9, managementBuildTreeErrorV9, type ManagementBuildReviewV9, type ManagementBuildSessionV9,
} from '../../src/application/management-v9-build-contract';
import type { ManagementSnapshotV9 } from '../../src/application/management-v9-contract';
import { ManagementBuildPanelV9, focusManagementBuildReviewV9, managementBuildNameV9 } from '../../src/app/ManagementBuildPanelV9';
import { managementV9BuildContext } from '../../src/content/sect-v9/world-content';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { createCultivationStateV3, createCultivatorV3 } from '../../src/core/cultivation/v3';
import { reconcileV9Lifecycle } from '../../src/core/world/v9-cultivation-bridge';
import { parseSaveV9 } from '../../src/core/kernel/save-v9';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { createTranslator, messageSpecifications, translate, type Locale, type TextKey } from '../../src/i18n';
import { zhCN } from '../../src/content/locales/zh-CN';
import { en } from '../../src/content/locales/en';

const sessions: ApplicationSessionV9[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); });
const create = (world?: WorldStateV9) => {
  const session = world ? new ApplicationSessionV9(world) : new ApplicationSessionV9(); sessions.push(session);
  session.select({ kind: 'disciple', id: 'entity:1' }); session.setPaused('player', true); return session;
};
/** Explicit initial-qi fixture, not a simulated breakthrough. Realm awards are
 * issued by the real v9 lifecycle reconciler; no display points or receipts are forged. */
function initialQiWorld(): WorldStateV9 {
  const world = createUnregisteredWorldV9('management-build-qi-origin');
  world.cultivation = createCultivationStateV3(world.cultivation.disciples.map(profile => profile.discipleId === 'entity:1'
    ? createCultivatorV3(profile.discipleId, { realm: 'qi', ageMonths: profile.ageMonths, aptitude: profile.aptitude }) : profile));
  return reconcileV9Lifecycle(world);
}
function swap(snapshot: ManagementSnapshotV9): BuildRequestV9 {
  const selected = snapshot.build.selected!; return { kind: 'loadout.set', discipleId: selected.discipleId, expectedRevision: snapshot.build.revision,
    loadout: { ...selected.loadout, activeSkillIds: [selected.loadout.activeSkillIds[1], selected.loadout.activeSkillIds[0]] } };
}
function prepare(controller: ReturnType<typeof createManagementBuildControllerV9>, snapshot: ManagementSnapshotV9, request = swap(snapshot)) {
  const result = controller.prepare(snapshot, request); expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.reason); return result.review;
}
function render(session: ApplicationSessionV9, snapshot = session.getSnapshot(), locale: Locale = 'zh-CN', readOnly = false) {
  return renderToStaticMarkup(createElement(ManagementBuildPanelV9, { session, snapshot, locale, readOnly, getReadOnly: () => readOnly, onFeedback: vi.fn() }));
}
const visible = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

/** A small focus-port fixture only. These assertions exercise focus ownership,
 * not browser layout, scroll geometry or native DOM focusability. */
function focusFixture() {
  const body = {} as HTMLElement; let active: Element | null = body;
  const make = () => {
    const state = { isConnected: true, disabled: false, ariaDisabled: false, focus: vi.fn(),
      matches: (_selector: string): boolean => state.disabled || state.ariaDisabled };
    const element = state as unknown as HTMLElement; state.focus.mockImplementation(() => { active = element; }); return { state, element };
  };
  const opener = make(); const target = make(); const outside = make();
  const regionState = { isConnected: true, focus: vi.fn(), matches: () => false,
    contains: (node: Node | null): boolean => node === target.element || node === region,
    querySelector: vi.fn(() => target.element) };
  const region = regionState as unknown as HTMLElement; regionState.focus.mockImplementation(() => { active = region; });
  const documentPort = { body, get activeElement() { return active; } };
  const canEnter = vi.fn(() => true); const canRestore = vi.fn(() => true);
  return { opener, target, outside, region, regionState, documentPort, canEnter, canRestore,
    setActive: (element: Element | null) => { active = element; },
    start: () => focusManagementBuildReviewV9({ region, opener: opener.element, document: documentPort, canEnter, canRestore }),
  };
}

describe('v9 build confirmation focus ownership', () => {
  it('brings the actual confirmation control into focus once and restores a re-enabled opener once', () => {
    const fixture = focusFixture(); fixture.setActive(fixture.opener.element); fixture.opener.state.disabled = true;
    const release = fixture.start();
    expect(fixture.target.state.focus).toHaveBeenCalledTimes(1); expect(fixture.documentPort.activeElement).toBe(fixture.target.element);
    fixture.opener.state.disabled = false; release(); release();
    expect(fixture.opener.state.focus).toHaveBeenCalledTimes(1); expect(fixture.documentPort.activeElement).toBe(fixture.opener.element);
  });

  it('does not enter an unrelated overlay, stale review, detached region or newer focus', () => {
    for (const change of ['overlay', 'detached', 'newer-focus', 'disabled-target'] as const) {
      const fixture = focusFixture();
      if (change === 'overlay') fixture.canEnter.mockReturnValue(false);
      if (change === 'detached') fixture.regionState.isConnected = false;
      if (change === 'newer-focus') fixture.setActive(fixture.outside.element);
      if (change === 'disabled-target') fixture.target.state.disabled = true;
      const release = fixture.start(); release();
      expect(fixture.target.state.focus).not.toHaveBeenCalled(); expect(fixture.opener.state.focus).not.toHaveBeenCalled();
    }
  });

  it('never restores a disconnected, disabled or aria-disabled stale opener', () => {
    for (const flag of ['disconnected', 'disabled', 'ariaDisabled'] as const) {
      const fixture = focusFixture(); const release = fixture.start();
      if (flag === 'disconnected') fixture.opener.state.isConnected = false;
      if (flag === 'disabled') fixture.opener.state.disabled = true;
      if (flag === 'ariaDisabled') fixture.opener.state.ariaDisabled = true;
      release(); expect(fixture.opener.state.focus).not.toHaveBeenCalled();
    }
  });

  it('leaves newer user focus alone and obeys live selection, unmount and hold vetoes at cleanup', () => {
    const moved = focusFixture(); const releaseMoved = moved.start(); moved.setActive(moved.outside.element); releaseMoved();
    expect(moved.opener.state.focus).not.toHaveBeenCalled(); expect(moved.documentPort.activeElement).toBe(moved.outside.element);
    const blocked = focusFixture(); const releaseBlocked = blocked.start(); blocked.canRestore.mockReturnValue(false); releaseBlocked();
    expect(blocked.opener.state.focus).not.toHaveBeenCalled();
    const removedControl = focusFixture(); const releaseRemoved = removedControl.start(); removedControl.setActive(removedControl.documentPort.body); releaseRemoved();
    expect(removedControl.opener.state.focus).toHaveBeenCalledTimes(1);
  });

  it('wires captured click targets to a labelled review with current-session checks and no global autofocus', () => {
    const source = readFileSync(new URL('../../src/app/ManagementBuildPanelV9.tsx', import.meta.url), 'utf8');
    expect(source).toContain('prepare(draft.basis, draft.request, event.currentTarget)');
    expect(source).toContain('skillId: skill.id }, event.currentTarget)');
    expect(source).toContain('ref={reviewRegion} tabIndex={-1} role="group"');
    expect(source).toContain('canEnter: () => sameOwner() && reviewRef.current === review');
    expect(source).toContain('managementBuildIntentGuardV9(review.basis, session.getSnapshot()');
    expect(source).toContain('if (!sameOwner() || reviewRef.current !== null) return false;');
    expect(source).toContain('current.sessionEpoch === review.basis.sessionEpoch');
    expect(source).toContain('current.selection?.id === review.basis.selection?.id');
    expect(source).toContain('!managementBuildBlockedV9(current, latest.current.readOnly || latest.current.getReadOnly())');
    expect(source).not.toContain('autoFocus');
  });
});

describe('bounded v9 permanent build rendering', () => {
  it.each(['zh-CN', 'en'] as const)('renders actual owned gear, current skills and zero earned points in %s', locale => {
    const session = create(); const before = session.getSnapshot(); const html = render(session, before, locale); const text = visible(html);
    const selected = before.build.selected!; const context = managementV9BuildContext(before.build.contentIdentity);
    expect(html.match(/<select\b/g)).toHaveLength(6);
    for (const item of selected.equipment) expect(text).toContain(managementBuildNameV9(context, locale, item.definitionId));
    for (const skillId of selected.learnedSkillIds) expect(text).toContain(managementBuildNameV9(context, locale, skillId));
    expect(text).toContain(translate(locale, 'buildView.points', { earned: 0, allocated: 0, remaining: 0 }));
    expect(text).toContain(translate(locale, 'managementV9.buildSlotsRequired'));
    expect(text).toContain(translate(locale, 'managementV9.buildTreeCost'));
    expect(text).not.toMatch(/(?:node|skill|tree|equipment)\.[a-z]|(?:entity|instance):\d|文本暂不可用/);
    expect(html).not.toContain('<option value=""'); expect(html).not.toContain('equipment.grant');
    expect(session.getSnapshot()).toBe(before);
  });

  it('keeps three slots present without showing any unowned catalog equipment', () => {
    const session = create(); const snapshot = session.getSnapshot(); const html = render(session);
    const own = new Set(snapshot.build.selected!.equipment.map(item => item.definitionId));
    const content = managementBuildContentV9(snapshot)!;
    for (const item of content.rules.equipment.filter(item => !own.has(item.id))) expect(visible(html)).not.toContain(managementBuildNameV9(content, 'zh-CN', item.id));
    for (const slot of ['weapon', 'robe', 'artifact']) expect(html).toMatch(new RegExp(`id="[^"]*-gear-${slot}"[^>]*disabled=""`));
    expect(visible(html)).toContain(translate('zh-CN', 'managementV9.buildOneItem'));
  });

  it('has associated labels, described blockers, non-submit controls, anchored section and quiet closed details', () => {
    const html = render(create());
    expect(html).toContain('id="management-v9-build"'); expect(html).toContain('tabindex="-1"'); expect(html).toContain('aria-live="polite"');
    expect(html.match(/<details\b/g)).toHaveLength(2); expect(html).not.toMatch(/<details[^>]+open/);
    for (const select of html.match(/<select\b[^>]*>/g) ?? []) {
      const id = /id="([^"]+)"/.exec(select)?.[1]; expect(id).toBeTruthy(); expect(html).toContain(`for="${id}"`); expect(select).toContain('aria-describedby=');
    }
    for (const button of html.match(/<button\b[^>]*>/g) ?? []) expect(button).toContain('type="button"');
  });

  it('disables all mutations under read-only, lock, pending death, hidden, review, storage and capacity holds', () => {
    const session = create(); const base = session.getSnapshot();
    const variations: ManagementSnapshotV9[] = [
      { ...base, build: { ...base.build, selected: { ...base.build.selected!, locked: true } } },
      { ...base, build: { ...base.build, selected: { ...base.build.selected!, lifeState: 'pendingDeath' } } },
      ...(['hidden', 'review', 'overlay', 'storageBusy', 'storage', 'player'] as const).map(key => ({ ...base, holds: { ...base.holds, [key]: true } })),
      { ...base, stopped: { kind: 'capacity', details: [] } }, { ...base, runtimeFailure: 'query-failed' }, { ...base, closed: true },
    ];
    for (const snapshot of variations) {
      const html = render(session, snapshot); expect(managementBuildBlockedV9(snapshot, false)).not.toBeNull();
      for (const control of html.match(/<(?:button|select)\b[^>]*>/g) ?? []) expect(control).toContain('disabled');
    }
    for (const control of render(session, base, 'zh-CN', true).match(/<(?:button|select)\b[^>]*>/g) ?? []) expect(control).toContain('disabled');
  });

  it('requests player pause before editing and preserves the existing domain pauses', () => {
    const session = create(); session.setPaused('player', false);
    const running = session.getSnapshot(); const html = render(session);
    expect(html).toContain(translate('zh-CN', 'managementV9.buildPauseEdit'));
    for (const select of html.match(/<select\b[^>]*>/g) ?? []) expect(select).toContain('disabled');
    for (const reason of ['hidden', 'error', 'danger', 'choice', 'cultivation', 'save-capacity'] as const) {
      expect(managementBuildBlockedV9({ ...running, frame: { ...running.frame, clock: { ...running.frame.clock, pauseReasons: ['player', reason] } } }, false)).toBe('managementV9.pausedHint');
    }
    session.setPaused('player', true); expect(managementBuildBlockedV9(session.getSnapshot(), false)).toBeNull();
    expect(render(session)).not.toContain(translate('zh-CN', 'managementV9.buildPauseEdit'));
  });

  it('does not borrow a legacy build context or retain a panel for another selection', () => {
    const session = create(); const base = session.getSnapshot();
    const wrong = { ...base, build: { ...base.build, contentIdentity: { ...base.build.contentIdentity, registryId: 'unknown' } } };
    expect(managementBuildContentV9(wrong)).toBeNull(); expect(render(session, wrong)).toContain(translate('zh-CN', 'buildView.unknownDefinition'));
    session.select({ kind: 'building', id: base.frame.buildings[0]!.id });
    const html = render(session); expect(html).toContain(translate('zh-CN', 'buildView.selectDisciple')); expect(html).not.toContain('<select');
  });
});

describe('v9 build one-shot intent and typed business outcomes', () => {
  it('commits one real paused loadout swap, rejects repeated confirmation, and survives save/reload', () => {
    const session = create(); const controller = createManagementBuildControllerV9(session, () => false);
    const basis = session.getSnapshot(); const review = prepare(controller, basis); const resources = basis.frame.resources;
    expect(controller.confirm(review).accepted).toBe(true); const after = session.getSnapshot();
    expect(after.build.selected!.loadout.activeSkillIds).toEqual([...basis.build.selected!.loadout.activeSkillIds].reverse());
    expect(after.build.revision).toBe(basis.build.revision + 1); expect(after.frame.resources).toEqual(resources);
    expect(controller.confirm(review)).toMatchObject({ accepted: false, feedback: { key: 'managementV9.stale' } });
    expect(session.getSnapshot()).toBe(after);
    const saved = session.exportSave({ buildId: 'v9-build-panel-test', savedAt: '2026-10-02T16:00:00Z' });
    expect(saved.ok).toBe(true); if (!saved.ok) throw new Error('Save rejected');
    const parsed = parseSaveV9(saved.value); expect(parsed.ok).toBe(true); if (!parsed.ok) throw new Error('Parse rejected');
    expect(session.replaceWorld(parsed.world).ok).toBe(true); session.select({ kind: 'disciple', id: 'entity:1' });
    expect(session.getSnapshot().build.selected!.loadout).toEqual(after.build.selected!.loadout);
  });

  it('cancels, rejects copied reviews and prevents reentrant or repeated dispatch', () => {
    const session = create(); const basis = session.getSnapshot(); const dispatch = vi.fn((request: BuildRequestV9) => session.dispatchBuild(request));
    const port: ManagementBuildSessionV9 = { getSnapshot: session.getSnapshot, setPaused: session.setPaused.bind(session), dispatchBuild: dispatch };
    const controller = createManagementBuildControllerV9(port, () => false); const review = prepare(controller, basis);
    expect(controller.confirm({ ...review }).accepted).toBe(false); expect(controller.prepare(basis, swap(basis)).ok).toBe(false);
    controller.cancel(); expect(controller.confirm(review).accepted).toBe(false); expect(dispatch).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toBe(basis); expect(basis.frame.clock.pauseReasons).toContain('player');
    const next = prepare(controller, basis);
    dispatch.mockImplementation(request => { expect(controller.confirm(next).accepted).toBe(false); return session.dispatchBuild(request); });
    expect(controller.confirm(next).accepted).toBe(true); expect(dispatch).toHaveBeenCalledTimes(1);
    controller.dispose(); expect(controller.prepare(session.getSnapshot(), swap(session.getSnapshot())).ok).toBe(false);
  });

  it.each(['selection', 'selection-return', 'replacement', 'hidden-return', 'tick', 'storage', 'readonly'] as const)('cannot confirm an old review after %s', change => {
    const session = create(); let readOnly = false; const controller = createManagementBuildControllerV9(session, () => readOnly);
    const basis = session.getSnapshot(); const review = prepare(controller, basis); const dispatch = vi.spyOn(session, 'dispatchBuild');
    if (change === 'selection' || change === 'selection-return') { session.select({ kind: 'disciple', id: 'entity:2' }); if (change === 'selection-return') session.select({ kind: 'disciple', id: 'entity:1' }); }
    if (change === 'replacement') expect(session.replaceWorld(createUnregisteredWorldV9()).ok).toBe(true);
    if (change === 'hidden-return') { session.setForeground({ visible: false }); session.setForeground({ visible: true }); }
    if (change === 'tick') { session.setPaused('player', false); session.frame(0); session.frame(50); session.setPaused('player', true); }
    if (change === 'storage') session.setStorageBusy(true);
    if (change === 'readonly') readOnly = true;
    expect(controller.confirm(review).accepted).toBe(false); expect(dispatch).not.toHaveBeenCalled();
    if (change === 'storage') session.setStorageBusy(false);
  });

  it('independently guards epoch, world/session/build revision, selection, runtime stamp and resource stamp', () => {
    const session = create(); const base = session.getSnapshot();
    const variants: ManagementSnapshotV9[] = [
      { ...base, sessionEpoch: base.sessionEpoch + 1 }, { ...base, revision: base.revision + 1 }, { ...base, worldRevision: base.worldRevision + 1 },
      { ...base, build: { ...base.build, revision: base.build.revision + 1 } }, { ...base, selection: { kind: 'disciple', id: 'entity:2' } },
      { ...base, stamp: { ...base.stamp, generation: base.stamp.generation + 1 } }, { ...base, stamp: { ...base.stamp, publication: base.stamp.publication + 1 } },
      { ...base, cultivation: { ...base.cultivation, resourceStamp: 'changed' } },
    ];
    for (const current of variants) expect(managementBuildIntentGuardV9(base, current, false)).not.toBeNull();
    expect(managementBuildIntentGuardV9(base, base, false)).toBeNull();
  });

  it('does not report a typed build rejection as success or retry it', () => {
    const session = create(); const rejected: SessionCommandResultV9 = { ok: true, kind: 'command', published: false, result: {
      commandId: 'actual.rejected', status: 'rejected', transactionId: null, eventIds: [], rejection: { code: 'BUILD_REJECTED', buildCode: 'INSUFFICIENT_LEARNING_CREDITS' },
    } };
    const dispatch = vi.fn(() => rejected); const port: ManagementBuildSessionV9 = { getSnapshot: session.getSnapshot, setPaused: session.setPaused.bind(session), dispatchBuild: dispatch };
    const controller = createManagementBuildControllerV9(port, () => false); const review = prepare(controller, session.getSnapshot());
    expect(controller.confirm(review)).toEqual({ accepted: false, feedback: { key: 'buildView.insufficientCredits' }, result: rejected });
    expect(controller.confirm(review).accepted).toBe(false); expect(dispatch).toHaveBeenCalledTimes(1);
    expect(managementBuildResultV9({ ok: false, kind: 'runtime-failure', error: 'capacity', stopped: { kind: 'capacity', details: [] } }).key).toBe('managementV9.stopped');
  });

  it('copies player payloads without invoking getters and rejects authority, IDs, wrong owners and empty slots', () => {
    const session = create(); const snapshot = session.getSnapshot(); const controller = createManagementBuildControllerV9(session, () => false);
    const valid = swap(snapshot); const getter = vi.fn(() => 'loadout.set'); const hostile = { ...valid };
    Object.defineProperty(hostile, 'kind', { enumerable: true, get: getter });
    expect(controller.prepare(snapshot, hostile).ok).toBe(false); expect(getter).not.toHaveBeenCalled();
    const invalid = [
      { ...valid, commandId: 'forged' }, { ...valid, discipleId: 'entity:2' },
      { kind: 'equipment.grant', discipleId: 'entity:1', expectedRevision: snapshot.build.revision, definitionId: 'equipment.trail-robe', acquisitionId: 'fake' },
      { ...valid, loadout: { ...snapshot.build.selected!.loadout, equipment: { ...snapshot.build.selected!.loadout.equipment, weaponId: '' } } },
      { ...valid, loadout: { ...snapshot.build.selected!.loadout, equipment: { ...snapshot.build.selected!.loadout.equipment, robeId: 'instance.foreign' } } },
    ];
    for (const request of invalid) expect(controller.prepare(snapshot, request as BuildRequestV9).ok).toBe(false);
    const review = prepare(controller, snapshot); expect(Object.isFrozen(review.request)).toBe(true);
    if (review.request.kind === 'loadout.set') expect(Object.isFrozen(review.request.loadout.equipment)).toBe(true);
    expect(session.getSnapshot()).toBe(snapshot);
  });
});

describe('v9 genuine learning costs and tree redistribution', () => {
  it('spends actual realm learning credits once, keeps knowledge through respec, and adds no resource fee', () => {
    const session = create(initialQiWorld()); const controller = createManagementBuildControllerV9(session, () => false);
    const first = session.getSnapshot(); const selected = first.build.selected!;
    expect(selected.progress).toMatchObject({ earnedPoints: 1, availableLearningCredits: 2 });
    const learned = prepare(controller, first, { kind: 'skill.learn', discipleId: 'entity:1', skillId: 'skill.cangfeng', expectedRevision: first.build.revision });
    expect(controller.confirm(learned).accepted).toBe(true);
    const afterLearning = session.getSnapshot(); expect(afterLearning.build.selected!.learnedSkillIds).toContain('skill.cangfeng');
    expect(afterLearning.build.selected!.progress.availableLearningCredits).toBe(0); expect(afterLearning.build.selected!.loadout.passiveSkillId).toBe(selected.loadout.passiveSkillId);
    const allocate = prepare(controller, afterLearning, { kind: 'tree.respec', discipleId: 'entity:1', nodeIds: ['node.sword.liuhen'], expectedRevision: afterLearning.build.revision });
    expect(controller.confirm(allocate).accepted).toBe(true); expect(session.getSnapshot().build.selected!.progress.allocatedPoints).toBe(1);
    const allocated = session.getSnapshot(); const clear = prepare(controller, allocated, { kind: 'tree.respec', discipleId: 'entity:1', nodeIds: [], expectedRevision: allocated.build.revision });
    expect(controller.confirm(clear).accepted).toBe(true); const after = session.getSnapshot();
    expect(after.build.selected!.progress).toMatchObject({ earnedPoints: 1, allocatedPoints: 0, availablePoints: 1, spentLearningCredits: 2, availableLearningCredits: 0 });
    expect(after.build.selected!.learnedSkillIds).toContain('skill.cangfeng'); expect(after.frame.resources).toEqual(first.frame.resources);
    expect(after.expansion.stock).toEqual(first.expansion.stock);
  });

  it('rejects missing credits, prerequisites, wrong trees and owned-but-incompatible equipment', () => {
    const session = create(); const snapshot = session.getSnapshot(); const selected = snapshot.build.selected!; const context = managementBuildContentV9(snapshot)!;
    expect(managementBuildLearnErrorV9(selected, context, 'skill.cangfeng')).toBe('buildView.insufficientCredits');
    expect(managementBuildLearnErrorV9(selected, context, selected.learnedSkillIds[0]!)).toBe('buildView.learned');
    expect(managementBuildTreeErrorV9(selected, context, ['node.sword.liuhen'])).toBe('buildView.insufficientPoints');
    // Presentation-only boundary variants, never admitted as a World or used for a real command.
    const points = { ...selected, progress: { ...selected.progress, earnedPoints: 5, availablePoints: 5 } };
    expect(managementBuildTreeErrorV9(points, context, ['node.sword.yangfeng'])).toBe('buildView.missingPrerequisite');
    const tree = ['node.sword.liuhen', 'node.sword.yangfeng', 'node.sword.guichao'];
    expect(managementBuildToggleNodeV9(points, context, tree, 'node.sword.liuhen')).toEqual({ ok: true, nodeIds: [] });
    const foreignNode = context.catalog.treeNodes.find(node => node.school !== selected.school)!;
    expect(managementBuildTreeErrorV9(points, context, [foreignNode.id])).toBe('buildView.rejected');
    const wrongWeapon = { ...selected, equipment: [...selected.equipment, { instanceId: 'instance.wrong-school', definitionId: 'equipment.training-body' }] };
    expect(managementBuildEquipmentV9(wrongWeapon, context, 'weapon').map(item => item.instanceId)).not.toContain('instance.wrong-school');
    expect(managementBuildRequestErrorV9(snapshot, { kind: 'skill.learn', discipleId: selected.discipleId, expectedRevision: snapshot.build.revision + 1, skillId: 'skill.cangfeng' })).toBe('managementV9.stale');
  });

  it('uses translated current keys with per-key Chinese fallback and no hidden World access', () => {
    const translator = createTranslator({ baseCatalog: zhCN, englishCatalog: { ...en, 'managementV9.buildLearnConfirm': '' }, specifications: messageSpecifications });
    expect(translator('en', 'managementV9.buildLearnConfirm', { name: 'Skill', cost: 2 })).toContain('确认研习');
    for (const key of Object.keys(messageSpecifications).filter(key => key.startsWith('managementV9.build'))) {
      expect(Object.hasOwn(zhCN, key)).toBe(true); expect(Object.hasOwn(en, key)).toBe(true);
    }
    for (const file of ['../../src/app/ManagementBuildPanelV9.tsx', '../../src/application/management-v9-build-contract.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toMatch(/exportWorld\(|\.snapshot\(|as\s+(?:unknown\s+as\s+)?(?:WorldState|ApplicationSession)\b|applyBuild(?:Authority)?Command/);
      expect(source).not.toMatch(/equipment\.grant|milestone\.award|equipment\.transfer|resolveBuildContentContext/);
    }
  });
});
