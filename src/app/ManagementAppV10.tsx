import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ApplicationSessionV10, BreakthroughProposalV10, PlacementProposalV10, UpgradeProposalV10,
  SessionCommandResultV10, SessionControlResultV10, SessionProjectionV10, SessionRequestV10, SessionSelectionV10, BuildRequestV10 } from '../application/session-v10';
import { disciplePresentation } from '../application/character-presentation';
import { MANAGEMENT_BASE_RECIPES_V9, managementContentTextV9, managementPhaseKeyV9, managementReasonV9, managementResourceTextV9 } from '../application/management-v9-contract';
import { MANAGEMENT_BUILD_SLOTS_V9, managementBuildEquipmentV9, managementBuildLearnErrorV9,
  managementBuildLoadoutErrorV9, managementBuildTreeErrorV9, managementBuildToggleNodeV9, managementBuildSupportedV9 } from '../application/management-v9-build-contract';
import { managementV9BuildContext } from '../content/sect-v9/world-content';
import { SECT_V9_CANDIDATE } from '../content/sect-v9/catalog';
import type { SectResourceLine } from '../content/sect-v9/types';
import { STARTER_RECIPES } from '../core/economy/recipes';
import type { BuildLoadout } from '../core/builds/types';
import type { BreakthroughPreparation } from '../core/cultivation/types';
import type { SectPlacementRequest, SectRotation } from '../core/sect-expansion/types';
import type { RuntimeReadonlyV10, RuntimeExpansionJobV10, RuntimeProductionSiteV10, RuntimeDoseSourceV10 } from '../core/world/runtime-view-types-v10';
import { createTranslator, DEFAULT_LOCALE, messageSpecifications, readLocalePreference, translate, writeLocalePreference, type Locale, type TextKey, type TranslationParams } from '../i18n';
import type { MessageSpecifications } from '../i18n/types';
import { copySectRenderTerrain, copySectRenderLegacyBuildings, freezeSectRendererSnapshot,
  type SectRendererSource, type SectRendererSnapshot, type SectVisualWork, type SectPlacementRenderPreview } from '../phaser/sect-renderer-contract';
import { PhaserWorld } from '../phaser/PhaserWorld';
import { ManagementCultivationRiskV9 } from './ManagementCultivationPanelV9';
import { managementBuildNameV9 } from './ManagementBuildPanelV9';
import './app.css';
import './management-v9.css';
import './management-v9-navigation.css';
import './management-v9-save.css';
import './management-v10.css';

/** Private presentation only. The entry owns creation, activation and persistence. */
export type ManagementSnapshotV10 = RuntimeReadonlyV10<SessionProjectionV10>;
export type ManagementSessionV10 = Pick<ApplicationSessionV10, 'getSnapshot' | 'subscribe' | 'select' | 'dispatch' | 'dispatchCultivation' | 'dispatchBuild' | 'dispatchSect'
  | 'preparePlacement' | 'confirmPlacement' | 'prepareUpgrade' | 'confirmUpgrade' | 'prepareBreakthrough' | 'confirmBreakthrough' | 'isProposalCurrent'
  | 'setReviewPaused' | 'setOverlayPaused' | 'setPaused' | 'setSpeed' | 'setForeground' | 'frame' | 'resetFrameBaseline' | 'refresh'>;

/** Stable local keys use the existing validated translator and Chinese fallback.
 * Kept here until the integration owner elects to register the private surface. */
export const managementMessagesV10 = {
  'managementV10.candidate': ['私有 v10 经营组件', 'Private v10 management component'],
  'managementV10.scope': ['药性配伍、丹房升级与替代伤药。活动工作性能与真实浏览器验收尚未通过；此组件不会启用公开入口。', 'Herbal compatibility, alchemy upgrades and alternative medicine. Active-work performance and browser acceptance remain unverified; this component does not enable a public entry.'],
  'managementV10.upgrade': ['丹房升级', 'Alchemy upgrade'],
  'managementV10.upgradePreview': ['预览 L1 → L2', 'Preview L1 → L2'],
  'managementV10.upgradeConfirm': ['确认开始升级', 'Confirm upgrade'],
  'managementV10.upgradeAdvisory': ['预览仅核对当前开工条件。完整命令仍会检查工人、通路、维护、材料与保存容量。', 'This preview checks current start conditions only. The command still checks worker, paths, maintenance, materials and save capacity.'],
  'managementV10.upgradeRule': ['有效工作到第 200 刻扣首批，第 400 刻扣余款并完成。行走与阻塞不计工作；取消只退尚未消耗的预留材料。', 'The first batch is consumed at work tick 200; the remainder at 400 on completion. Travel and blocked time do not count. Cancelling releases only unconsumed reservations.'],
  'managementV10.upgradeHalf': ['第 200 工作刻：{cost}', 'Work tick 200: {cost}'],
  'managementV10.upgradeRemainder': ['第 400 工作刻：{cost}', 'Work tick 400: {cost}'],
  'managementV10.upgradeCancelled': ['取消升级后仍为 L1；已消耗材料不会退回，工人不会传送。', 'Cancellation leaves L1, does not refund consumed materials and does not teleport the worker.'],
  'managementV10.noAlchemy': ['先完成基础药理与 L1 丹房建设。', 'Complete basic medicine and construction of an L1 alchemy hall first.'],
  'managementV10.origin': ['建造来源：{construction}；升级来源：{upgrade}', 'Construction source: {construction}; upgrade source: {upgrade}'],
  'managementV10.none': ['无', 'None'],
  'managementV10.actualSite': ['实际场所：{site} · L{level} · 建造来源 {construction} · 升级来源 {upgrade}', 'Actual site: {site} · L{level} · construction {construction} · upgrade {upgrade}'],
  'managementV10.eligibleSite': ['候选场所：{site} · L{level} · {state}', 'Eligible site: {site} · L{level} · {state}'],
  'managementV10.siteBusy': ['被占用', 'Occupied'],
  'managementV10.recipeAdvisory': ['配方与场所列表仅供查看，不保证命令获准；实际生产工作会记录最终采用的场所。', 'Recipe and site queries are advisory. The real production job records the site actually used.'],
  'managementV10.doseSource': ['此剂伤药来源：{recipe} · 生产任务 {job}', 'This dose source: {recipe} · production job {job}'],
  'managementV10.noDoseChoice': ['照护会使用实际库存中可用的一剂伤药；开工后显示权威药剂来源，不预设基础方或替代方。', 'Care uses an available dose from actual stock. Its authoritative source appears after starting; no recipe is presumed.'],
  'managementV10.currentPeriod': ['当前已付期间按 L{level} 计费：日历刻 {paid} → {due}', 'Current paid period uses the L{level} rate: calendar tick {paid} → {due}'],
  'managementV10.noPaidPeriod': ['当前没有已付的维护期间。', 'There is no currently paid maintenance period.'],
  'managementV10.nextMaintenance': ['下一次维护费用：{cost}', 'Next maintenance cost: {cost}'],
  'managementV10.maintenanceRate': ['升级不追收当前 L1 期间差额，也不重设到期刻；到期后的下一次付款才按 L2 费用。', 'An upgrade neither back-charges the current L1 period nor resets its due tick. The next payment after expiry uses L2 costs.'],
  'managementV10.hiddenPause': ['存档保留了隐藏暂停。点击“显式恢复”仅解除 hidden/player 暂停，领域待决与容量停止仍会保留。', 'This save retains a hidden pause. Explicit resume clears only hidden/player pauses; domain decisions and capacity stops remain.'],
  'managementV10.resumeExplicit': ['显式恢复', 'Explicit resume'],
  'managementV10.storageUnavailable': ['v10 存档控制器尚未接入：此会话不会声称已保存、导入或转换旧档。', 'No v10 save controller is connected. This session cannot claim a successful save, import or conversion.'],
  'managementV10.migrationUnavailable': ['旧 v9 → v10 复制转换尚未接入；不会自动改写旧槽位。', 'The v9 → v10 copy-conversion flow is not connected. Old slots are not automatically changed.'],
  'managementV10.storageTitle': ['v10 存档与复制转换', 'v10 saves and copy conversion'],
  'managementV10.unsavedSession': ['当前仅为运行中的会话，请勿将画面状态当作已保存进度。', 'This is a running session; visible progress is not proof of a save.'],
  'managementV10.reviewTitle': ['核对操作', 'Review action'],
  'managementV10.checkpointPolicy': ['检查点策略：{half} / {end} 有效工作刻；当前实际 {active} 刻', 'Checkpoint policy: work ticks {half} / {end}; actual progress {active}'],
  'managementV10.checkpointRecord': ['已记录检查点：第 {active} 工作刻（模拟刻 {tick}）', 'Recorded checkpoint: work tick {active} (simulation tick {tick})'],
  'managementV10.noCheckpoint': ['尚无已记录的材料检查点。', 'No material checkpoint is recorded yet.'],
  'managementV10.terminalLevel': ['任务 {job}：{state}，结果 L{level}', 'Job {job}: {state}, result L{level}'],
  'managementV10.consumed': ['实际已消耗：{cost}', 'Actually consumed: {cost}'],
  'managementV10.released': ['实际已释放的预留：{cost}', 'Actually released reservations: {cost}'],
  'managementV10.buildChange': ['{slot}：{before} → {after}', '{slot}: {before} → {after}'],
  'managementV10.buildBefore': ['调整前：{names}', 'Before: {names}'],
  'managementV10.buildAfter': ['调整后：{names}', 'After: {names}'],
  'managementV10.buildAdded': ['新增节点：{names}', 'Added nodes: {names}'],
  'managementV10.buildRemoved': ['移除节点：{names}', 'Removed nodes: {names}'],
  'managementV10.buildNoChanges': ['没有配装变更。', 'There are no loadout changes.'],
  'managementV10.reason.upgradeUnsupported': ['当前仅支持已建成丹房从 L1 升至 L2。', 'Only a completed L1 alchemy hall can be upgraded to L2.'],
  'managementV10.reason.alreadyUpgraded': ['该丹房已完成升级。', 'This alchemy hall has already been upgraded.'],
  'managementV10.reason.upgradeActive': ['该丹房已有进行中的升级，请先查看或取消该任务。', 'This alchemy hall already has an active upgrade. Review or cancel that job first.'],
  'managementV10.reason.buildingBusy': ['该建筑正在被其他工作占用。', 'This building is occupied by another job.'],
  'managementV10.reason.maintenanceUnpaid': ['维护期间已到期且尚未付款；请补足维护材料后等待实际续费。', 'The maintenance period has expired without payment. Supply the maintenance materials and wait for actual renewal.'],
  'managementV10.reason.reservation': ['材料预留状态已变化，请重新核对任务。', 'Material reservations have changed. Review the job again.'],
  'managementV10.reason.invalid': ['当前状态无法执行此操作，请刷新并重新核对。', 'This action cannot use the current state. Refresh and review it again.'],
} as const;
export type ManagementLocalKeyV10 = keyof typeof managementMessagesV10;
export type ManagementTextV10 = { key: TextKey | ManagementLocalKeyV10; parameters?: TranslationParams };
const integer = { type: 'number', format: 'integer' } as const;
const string = { type: 'string', format: 'text' } as const;
const parameterSpecsV10: MessageSpecifications = {
  'managementV10.upgradeHalf': { parameters: { cost: string } }, 'managementV10.upgradeRemainder': { parameters: { cost: string } },
  'managementV10.origin': { parameters: { construction: string, upgrade: string } },
  'managementV10.actualSite': { parameters: { site: string, level: integer, construction: string, upgrade: string } },
  'managementV10.eligibleSite': { parameters: { site: string, level: integer, state: string } },
  'managementV10.doseSource': { parameters: { recipe: string, job: string } },
  'managementV10.currentPeriod': { parameters: { level: integer, paid: integer, due: integer } },
  'managementV10.nextMaintenance': { parameters: { cost: string } },
  'managementV10.checkpointPolicy': { parameters: { half: integer, end: integer, active: integer } },
  'managementV10.checkpointRecord': { parameters: { active: integer, tick: integer } },
  'managementV10.terminalLevel': { parameters: { job: string, state: string, level: integer } },
  'managementV10.consumed': { parameters: { cost: string } }, 'managementV10.released': { parameters: { cost: string } },
  'managementV10.buildChange': { parameters: { slot: string, before: string, after: string } },
  'managementV10.buildBefore': { parameters: { names: string } }, 'managementV10.buildAfter': { parameters: { names: string } },
  'managementV10.buildAdded': { parameters: { names: string } }, 'managementV10.buildRemoved': { parameters: { names: string } },
};
export const managementMessageSpecificationsV10: MessageSpecifications = Object.fromEntries(Object.keys(managementMessagesV10).map(key => [key, parameterSpecsV10[key] ?? { parameters: {} }]));
export function createManagementTranslatorV10(locale: Locale, english: Record<string, string> = Object.fromEntries(Object.entries(managementMessagesV10).map(([key, values]) => [key, values[1]]))) {
  const local = createTranslator({ specifications: managementMessageSpecificationsV10,
    baseCatalog: Object.fromEntries(Object.entries(managementMessagesV10).map(([key, values]) => [key, values[0]])), englishCatalog: english });
  return (key: TextKey | ManagementLocalKeyV10, parameters?: TranslationParams): string => Object.hasOwn(managementMessagesV10, key)
    ? local(locale, key, parameters) : translate(locale, key as TextKey, parameters);
}
type Translator = ReturnType<typeof createManagementTranslatorV10>;
type ProposalV10 = RuntimeReadonlyV10<PlacementProposalV10 | UpgradeProposalV10 | BreakthroughProposalV10>;
type PolicyV10 = 'ordinary' | 'build' | 'cultivation-exit';
function freezeUiRequestV10(request: SessionRequestV10): SessionRequestV10 {
  const copy = structuredClone(request);
  const freeze = (value: unknown): void => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(copy); return copy;
}
export function managementBoundaryV10(expected: ManagementSnapshotV10, current: ManagementSnapshotV10, includeRevision = true): boolean {
  return expected.sessionEpoch === current.sessionEpoch && expected.worldRevision === current.worldRevision
    && (!includeRevision || expected.revision === current.revision)
    && expected.stamp.generation === current.stamp.generation && expected.stamp.publication === current.stamp.publication
    && expected.selection?.kind === current.selection?.kind && expected.selection?.id === current.selection?.id
    && expected.cultivation.resourceStamp === current.cultivation.resourceStamp;
}
export function managementBlockedV10(current: ManagementSnapshotV10, readOnly: boolean, allowReview = false, policy: PolicyV10 = 'ordinary'): TextKey | null {
  if (current.closed || current.stopped || current.runtimeFailure) return 'managementV9.stopped';
  if (readOnly || current.holds.storage) return 'managementV9.readOnly';
  if (current.holds.storageBusy || current.holds.staging) return 'managementV9.busy';
  if (current.holds.overlay || current.holds.review && !allowReview) return 'managementV9.reviewHeld';
  if (current.holds.hidden || current.holds.player || current.frame.clock.mode !== 'management'
    || current.frame.clock.pauseReasons.some(reason => !(policy === 'build' && reason === 'player') && !(policy === 'cultivation-exit' && reason === 'cultivation'))) return 'managementV9.pausedHint';
  if (policy === 'build' && !current.frame.clock.pauseReasons.includes('player')) return 'managementV9.buildPauseHint';
  return null;
}
const buildReasonKeysV10: Readonly<Record<string, TextKey>> = {
  REVISION_CONFLICT: 'managementV9.stale', INSUFFICIENT_POINTS: 'buildView.insufficientPoints', POINT_LIMIT: 'buildView.pointLimit',
  INSUFFICIENT_LEARNING_CREDITS: 'buildView.insufficientCredits', MISSING_PREREQUISITE: 'buildView.missingPrerequisite',
  ALREADY_LEARNED: 'buildView.learned', UNKNOWN_DEFINITION: 'buildView.unknownDefinition', CONTENT_MISMATCH: 'buildView.unknownDefinition',
  UNSUPPORTED_CONTENT: 'buildView.unavailable', INVALID_LOADOUT: 'managementV9.buildInvalidLoadout', ITEM_NOT_OWNED: 'managementV9.buildItemUnavailable',
  ITEM_ALREADY_EQUIPPED: 'managementV9.buildItemUnavailable', EXPEDITION_LOCKED: 'managementV9.buildOccupied', INVALID_STATE: 'managementV9.buildOccupied',
  COMMAND_LIMIT: 'managementV9.reason.capacity', COUNTER_EXHAUSTED: 'managementV9.reason.capacity', OVERFLOW: 'managementV9.reason.capacity',
};
export function managementReasonV10(code: string): ManagementTextV10 {
  const keys: Readonly<Record<string, ManagementTextV10['key']>> = {
    UNSUPPORTED_UPGRADE: 'managementV10.reason.upgradeUnsupported', ALREADY_UPGRADED: 'managementV10.reason.alreadyUpgraded',
    UPGRADE_ACTIVE: 'managementV10.reason.upgradeActive', BUILDING_BUSY: 'managementV10.reason.buildingBusy',
    MAINTENANCE_UNPAID: 'managementV10.reason.maintenanceUnpaid', INVALID_RESERVATION: 'managementV10.reason.reservation',
    UNKNOWN_BUILDING: 'managementV9.reason.station', UNKNOWN_JOB: 'managementV9.reason.finished', SITE_UNAVAILABLE: 'managementV9.reason.station',
    UNSAFE_POSITION: 'managementV9.reason.path', IDENTITY_CONFLICT: 'managementV9.stale', CLOCK_GAP: 'managementV9.stale',
    INVALID_FRAME: 'managementV10.reason.invalid', INVALID_CONTEXT: 'managementV10.reason.invalid', INVALID_COMMAND: 'managementV10.reason.invalid',
  };
  return keys[code] ? { key: keys[code] } : managementReasonV9(code);
}
export function managementResultV10(result: SessionCommandResultV10 | SessionControlResultV10): ManagementTextV10 {
  if (!result.ok) return managementReasonV10(result.kind === 'runtime-failure' ? result.error : result.code);
  if ('result' in result && result.result.status !== 'accepted') {
    const rejection = result.result.rejection;
    if (rejection && 'cultivationCode' in rejection && rejection.cultivationCode) {
      const key = `cultivation.error.${rejection.cultivationCode}`;
      if (Object.hasOwn(messageSpecifications, key)) return { key: key as TextKey };
    }
    if (rejection && 'buildCode' in rejection && rejection.buildCode) {
      const key = buildReasonKeysV10[rejection.buildCode]; if (key) return { key };
    }
    return managementReasonV10(rejection && 'detail' in rejection && rejection.detail ? rejection.detail : rejection?.code ?? 'INVALID_REQUEST');
  }
  return { key: 'managementV9.accepted' };
}
export function managementWorkerAvailableV10(snapshot: ManagementSnapshotV10, id: string): boolean {
  return snapshot.frame.disciples.some(actor => actor.id === id && actor.lifeState === 'alive' && !actor.traveling)
    && snapshot.cultivation.summaries.some(row => row.discipleId === id && row.workerAvailable && row.workOwner === null);
}
export function managementHasResourcesV10(snapshot: ManagementSnapshotV10, costs: readonly SectResourceLine[]): boolean {
  return costs.every(line => ((line.ledger === 'base' ? snapshot.frame.resources : snapshot.expansion.stock).find(row => row.resourceId === line.resourceId)?.available ?? 0) >= line.quantity);
}

/** UI-local reference counts: disposing an old mount cannot release a newer hold. */
type HoldKind = 'review' | 'overlay';
type HoldPort = Pick<ManagementSessionV10, 'subscribe' | 'getSnapshot' | 'setReviewPaused' | 'setOverlayPaused'>;
const holdCoordinators = new WeakMap<HoldPort, { claims: Record<HoldKind, Set<object>>; owned: Record<HoldKind, boolean>; enqueue: () => void }>();
export function createManagementHoldsV10(session: HoldPort) {
  let coordinator = holdCoordinators.get(session);
  if (!coordinator) {
    let queued = false; let unsubscribe: (() => void) | null = null;
    const created = { claims: { review: new Set<object>(), overlay: new Set<object>() }, owned: { review: false, overlay: false }, enqueue: () => {
      if (queued) return; queued = true;
      queueMicrotask(() => {
        queued = false;
        for (const kind of ['review', 'overlay'] as const) {
          const current = session.getSnapshot();
          if (current.closed) { created.claims[kind].clear(); created.owned[kind] = false; continue; }
          if (!created.owned[kind] || created.claims[kind].size || current.holds.storageBusy) continue;
          if (!current.holds[kind]) { created.owned[kind] = false; continue; }
          const result = kind === 'review' ? session.setReviewPaused(false) : session.setOverlayPaused(false);
          if (result.ok) created.owned[kind] = false;
        }
        const pending = (['review', 'overlay'] as const).some(kind => created.owned[kind] && !created.claims[kind].size);
        if (pending && !unsubscribe) unsubscribe = session.subscribe(created.enqueue);
        if (!pending && unsubscribe) { const stop = unsubscribe; unsubscribe = null; stop(); }
      });
    } };
    coordinator = created; holdCoordinators.set(session, coordinator);
  }
  const owner = coordinator; const token = {}; let disposed = false;
  return {
    set(kind: HoldKind, held: boolean): SessionControlResultV10 {
      if (disposed || session.getSnapshot().closed) return { ok: false, kind: 'session-rejection', code: 'CLOSED' };
      if (!held) { owner.claims[kind].delete(token); owner.enqueue(); return { ok: true, changed: true, ephemeral: true }; }
      const before = session.getSnapshot().holds[kind]; const result = kind === 'review' ? session.setReviewPaused(true) : session.setOverlayPaused(true);
      if (result.ok) { owner.claims[kind].add(token); if (!before) owner.owned[kind] = true; }
      return result;
    },
    dispose() { if (disposed) return; disposed = true; owner.claims.review.delete(token); owner.claims.overlay.delete(token); owner.enqueue(); },
  };
}
export interface ManagementReviewFocusV10 { readonly opener: HTMLElement; readonly restoreTo?: HTMLElement }
export type ManagementReviewV10 = Readonly<{ basis: ManagementSnapshotV10; policy: PolicyV10; title: ManagementTextV10; warning: ManagementTextV10 | null; acknowledge: boolean; focus: ManagementReviewFocusV10 | null }> & (
  | Readonly<{ kind: 'proposal'; proposal: ProposalV10 }>
  | Readonly<{ kind: 'command'; request: SessionRequestV10 }>
);
export function createManagementReviewV10(session: ManagementSessionV10, getReadOnly: () => boolean) {
  let active: ManagementReviewV10 | null = null; let holds: ReturnType<typeof createManagementHoldsV10> | null = null;
  let stop: (() => void) | null = null; let lifecycle = 0; const listeners = new Set<() => void>();
  const publish = (next: ManagementReviewV10 | null) => { active = next; for (const listener of [...listeners]) listener(); };
  const cancel = () => { publish(null); holds?.set('review', false); };
  const guard = (review: ManagementReviewV10, allowReview = true, includeRevision = true): TextKey | null => {
    const current = session.getSnapshot();
    return managementBlockedV10(current, getReadOnly(), allowReview, review.policy)
      ?? (!managementBoundaryV10(review.basis, current, includeRevision) ? 'managementV9.stale' : null)
      ?? (review.kind === 'proposal' && !session.isProposalCurrent(review.proposal) ? 'managementV9.stale' : null);
  };
  const acquire = (basis: ManagementSnapshotV10, policy: PolicyV10): ManagementTextV10 | null => {
    const current = session.getSnapshot();
    const denied = managementBlockedV10(current, getReadOnly(), active !== null, policy)
      ?? (!managementBoundaryV10(basis, current) ? 'managementV9.stale' : null);
    if (denied || !holds) return { key: denied ?? 'managementV9.stopped' };
    const result = holds.set('review', true); return result.ok ? null : managementResultV10(result);
  };
  return {
    getSnapshot: () => active,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { if (holds) return; lifecycle++; holds = createManagementHoldsV10(session); stop = session.subscribe(() => { if (active && guard(active)) cancel(); }); },
    stop() { lifecycle++; stop?.(); stop = null; cancel(); holds?.dispose(); holds = null; },
    cancel, guard,
    prepare(basis: ManagementSnapshotV10, query: () => ReturnType<ManagementSessionV10['prepareUpgrade']> | ReturnType<ManagementSessionV10['preparePlacement']> | ReturnType<ManagementSessionV10['prepareBreakthrough']>, title: ManagementTextV10, acknowledge = false, focus: ManagementReviewFocusV10 | null = null): ManagementTextV10 | null {
      const previous = active;
      const denied = acquire(basis, 'ordinary'); if (denied) return denied;
      let result: ReturnType<typeof query>;
      try { result = query(); } catch { cancel(); return { key: 'managementV9.stopped' }; }
      if (!result.ok) { cancel(); return managementResultV10(result); }
      const focusScope = result.value.kind === 'placement' && previous?.kind === 'proposal' && previous.proposal.kind === 'placement' ? previous.focus : focus;
      publish(Object.freeze({ kind: 'proposal', basis: session.getSnapshot(), policy: 'ordinary', proposal: result.value, title, warning: null, acknowledge, focus: focusScope })); return null;
    },
    open(basis: ManagementSnapshotV10, request: SessionRequestV10, title: ManagementTextV10, warning: ManagementTextV10 | null = null, acknowledge = false, policy: PolicyV10 = 'ordinary', focus: ManagementReviewFocusV10 | null = null): ManagementTextV10 | null {
      const denied = acquire(basis, policy); if (denied) return denied;
      let captured: SessionRequestV10;
      try { captured = freezeUiRequestV10(request); } catch { cancel(); return { key: 'managementV9.stale' }; }
      publish(Object.freeze({ kind: 'command', basis: session.getSnapshot(), policy, request: captured, title, warning, acknowledge, focus })); return null;
    },
    async confirm(expected: ManagementReviewV10, acknowledged: boolean): Promise<ManagementTextV10> {
      if (active !== expected || !holds) return { key: 'managementV9.stale' };
      if (expected.acknowledge && !acknowledged) return { key: 'cultivation.error.ACKNOWLEDGEMENT_REQUIRED' };
      const denied = guard(expected); if (denied) { cancel(); return { key: denied }; }
      if (expected.kind === 'proposal') {
        const proposal = expected.proposal;
        if (proposal.kind === 'placement' && !proposal.view.allowed || proposal.kind === 'upgrade' && !proposal.view.eligible
          || proposal.kind === 'breakthrough' && (proposal.view.preview.blockers.length > 0 || proposal.view.workOwner !== null)) return { key: 'managementV9.reason.worker' };
      }
      const scope = holds; const version = lifecycle; publish(null); // Synchronous one-shot ownership, before any await or dispatch.
      if (expected.kind === 'proposal') {
        // Publication is observable: a subscriber may synchronously unmount,
        // select another actor or change readonly state. None grants dispatch.
        const changed = !holds || lifecycle !== version ? 'managementV9.stale' : guard(expected);
        if (changed) { scope.set('review', false); return { key: changed }; }
        const proposal = expected.proposal;
        const result = proposal.kind === 'placement' ? session.confirmPlacement(proposal) : proposal.kind === 'upgrade' ? session.confirmUpgrade(proposal) : session.confirmBreakthrough(proposal);
        scope.set('review', false); return managementResultV10(result);
      }
      scope.set('review', false); await Promise.resolve();
      if (!holds || lifecycle !== version) return { key: 'managementV9.stale' };
      const changed = guard(expected, false, false); const current = session.getSnapshot();
      if (changed || current.revision !== expected.basis.revision + 1) return { key: changed ?? 'managementV9.stale' };
      return managementResultV10(session.dispatch(expected.request));
    },
  };
}

/** Only an explicit UI event calls this. It never removes domain pause reasons. */
export function resumeManagementV10(session: Pick<ManagementSessionV10, 'getSnapshot' | 'setPaused'>, basis: ManagementSnapshotV10, readOnly = false): SessionControlResultV10 {
  const current = session.getSnapshot();
  if (!managementBoundaryV10(basis, current) || readOnly || current.closed || current.stopped || current.runtimeFailure || current.holds.storage || current.holds.storageBusy || current.holds.staging || current.holds.review || current.holds.overlay)
    return { ok: false, kind: 'session-rejection', code: 'PREVIEW_STALE' };
  const hidden = session.setPaused('hidden', false); if (!hidden.ok) return hidden;
  return session.setPaused('player', false);
}

export function projectManagementRendererV10(snapshot: ManagementSnapshotV10, placement: SectPlacementRenderPreview | null = null): SectRendererSnapshot {
  const work = new Map<string, SectVisualWork | null>();
  for (const actor of snapshot.frame.disciples) {
    const owners = snapshot.expansion.workOwners.filter(row => row.workerId === actor.id); const owner = owners.length === 1 ? owners[0] : null;
    let value: SectVisualWork | null = null;
    if (owner?.kind === 'legacy-production') {
      const job = snapshot.frame.transactions.find(row => row.transactionId === owner.id && row.workerId === actor.id && row.state !== 'Committed' && row.state !== 'Cancelled');
      if (job) value = { kind: 'legacy-production', ownerId: job.transactionId, activeTicks: job.activeTicks, requiredTicks: job.requiredTicks, blocked: job.state === 'Blocked' };
    } else if (owner) {
      const job = snapshot.expansion.jobs.find(row => row.jobId === owner.id && (row.domain === 'care' ? row.patientId : row.workerId) === actor.id
        && (row.domain === 'production' ? 'sect-production' : row.domain) === owner.kind);
      if (job) value = { kind: job.domain === 'production' ? 'sect-production' : job.domain, ownerId: job.jobId,
        activeTicks: job.activeTicks, requiredTicks: job.requiredTicks, blocked: job.blocked !== null };
    }
    work.set(actor.id, value);
  }
  const geometry = (row: ManagementSnapshotV10['expansion']['buildings'][number] | ManagementSnapshotV10['expansion']['blueprints'][number]) => ({
    definitionId: row.definitionId, footprint: { cells: row.footprint.cells.map(cell => ({ ...cell })), entrance: { ...row.footprint.entrance } },
  });
  return freezeSectRendererSnapshot({
    map: copySectRenderTerrain(snapshot.frame.map), buildings: copySectRenderLegacyBuildings(snapshot.frame.buildings),
    expansion: [
      ...snapshot.expansion.blueprints.map(row => {
        const job = snapshot.expansion.jobs.find(job => job.domain === 'construction' && job.blueprintId === row.blueprintId && job.jobId === row.jobId);
        const visual = job && job.domain === 'construction' ? work.get(job.workerId) : null;
        return { ...geometry(row), kind: 'blueprint' as const, id: row.blueprintId, status: row.status, work: visual?.kind === 'construction' ? visual : null };
      }),
      ...snapshot.expansion.buildings.map(row => ({ ...geometry(row), kind: 'sect-building' as const, id: row.buildingId, level: row.level, operational: row.maintenance.operational })),
    ],
    disciples: snapshot.frame.disciples.map((actor, index) => ({ id: actor.id, nameKey: actor.nameKey, presentationId: disciplePresentation(actor, index).id,
      position: { ...actor.position }, lifeState: actor.lifeState, traveling: actor.traveling, work: work.get(actor.id) ?? null })),
    selection: snapshot.selection ? { ...snapshot.selection } : null, clock: { simulationTick: snapshot.frame.clock.simulationTick }, paused: snapshot.paused,
    placement: placement ? { anchor: { ...placement.anchor }, allowed: placement.allowed, footprint: placement.footprint
      ? { cells: placement.footprint.cells.map(cell => ({ ...cell })), entrance: { ...placement.footprint.entrance } } : null } : null,
  });
}
export function createManagementRendererV10(session: Pick<ManagementSessionV10, 'getSnapshot' | 'subscribe'>,
  select: (selection: SessionSelectionV10) => void, point: (cell: { x: number; y: number }) => void): SectRendererSource & { setPlacementPreview: (preview: SectPlacementRenderPreview | null) => void } {
  let previous: ManagementSnapshotV10 | null = null; let rendered: SectRendererSnapshot | null = null;
  let placement: SectPlacementRenderPreview | null = null; const listeners = new Set<() => void>();
  return {
    rendererContract: 'sect-renderer.1',
    subscribe(listener) { listeners.add(listener); const stop = session.subscribe(listener); return () => { listeners.delete(listener); stop(); }; },
    getSnapshot() { const current = session.getSnapshot(); if (!rendered || current !== previous) { rendered = projectManagementRendererV10(current, placement); previous = current; } return rendered; },
    select, onPlacementCell(cell) { if (placement) point({ x: cell.x, y: cell.y }); },
    setPlacementPreview(preview) { placement = preview; previous = null; for (const listener of [...listeners]) listener(); },
  };
}
export interface ManagementStorageStatusV10 { readonly busy: boolean; readonly readOnly: boolean; readonly summary: ManagementTextV10; readonly notice: ManagementTextV10 | null }
/** Integration slot, not a fake controller. The injected controller owns every
 * storage fence, real result, acknowledgement and migration source backup. */
export interface ManagementStorageSlotV10 {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ManagementStorageStatusV10;
  renderBody(context: { session: ManagementSessionV10; locale: Locale; close: () => void }): ReactNode;
}
const noStorageStatus: ManagementStorageStatusV10 = Object.freeze({ busy: false, readOnly: false, summary: { key: 'managementV10.unsavedSession' as const }, notice: null });
const noStorage = { subscribe: () => () => {}, getSnapshot: () => noStorageStatus };
export interface ManagementAppV10Props { session: ManagementSessionV10; storage?: ManagementStorageSlotV10; initialLocale?: Locale }
type UiContext = { session: ManagementSessionV10; snapshot: ManagementSnapshotV10; readOnly: boolean; getReadOnly: () => boolean; t: Translator;
  feedback: (notice: ManagementTextV10) => void; reviews: ReturnType<typeof createManagementReviewV10> };
export function focusManagementReviewV10({ region, focus, document: documentPort, canEnter, canRestore }: {
  region: HTMLElement; focus: ManagementReviewFocusV10; document: Pick<Document, 'activeElement' | 'body'>;
  canEnter: () => boolean; canRestore: () => boolean;
}): () => void {
  if (!region.isConnected || !canEnter()) return () => {};
  const active = documentPort.activeElement;
  if (active !== focus.opener && active !== documentPort.body && !region.contains(active)) return () => {};
  (region.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? region).focus();
  return () => {
    const target = focus.restoreTo ?? focus.opener;
    if (canRestore() && target.isConnected && !target.matches(':disabled, [aria-disabled="true"]')
      && (region.contains(documentPort.activeElement) || documentPort.activeElement === documentPort.body)) target.focus();
  };
}
export function managementReviewFocusOwnerV10(owner: Pick<ManagementSessionV10, 'getSnapshot'>, latestOwner: Pick<ManagementSessionV10, 'getSnapshot'>, basis: ManagementSnapshotV10): boolean {
  if (owner !== latestOwner) return false;
  const current = owner.getSnapshot(); return !current.closed && !current.holds.storageBusy && !current.holds.overlay
    && current.sessionEpoch === basis.sessionEpoch && current.selection?.kind === basis.selection?.kind && current.selection?.id === basis.selection?.id;
}
function useReviewFocusV10(review: ManagementReviewV10 | null, region: React.RefObject<HTMLDivElement | null>, cancel: () => void, session: ManagementSessionV10) {
  const latest = useRef(review); latest.current = review; const focus = review?.focus ?? null;
  const latestSession = useRef(session); latestSession.current = session;
  useEffect(() => {
    const opened = latest.current; if (!focus || !opened || !region.current) return;
    const sameSelection = () => managementReviewFocusOwnerV10(session, latestSession.current, opened.basis);
    const restore = focusManagementReviewV10({ region: region.current, focus, document,
      canEnter: () => latest.current?.focus === focus && sameSelection(),
      canRestore: () => latest.current === null && sameSelection() });
    return () => { queueMicrotask(restore); };
  }, [focus, region, session]);
  useEffect(() => {
    if (!review) return;
    const escape = (event: KeyboardEvent) => { const current = session.getSnapshot(); if (event.key !== 'Escape' || event.defaultPrevented || current.holds.overlay || current.holds.storageBusy) return; event.preventDefault(); cancel(); };
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('keydown', escape); };
  }, [review !== null, cancel, session]);
}

/** Draft Escape is scoped to this mounted editor, separate from review Escape. */
export function attachManagementDraftEscapeV10({ target, canDiscard, discard }: {
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>; canDiscard: () => boolean; discard: () => void;
}): () => void {
  const escape = (event: Event) => { if (event.defaultPrevented || !('key' in event) || event.key !== 'Escape' || !canDiscard()) return; event.preventDefault(); discard(); };
  target.addEventListener('keydown', escape); return () => target.removeEventListener('keydown', escape);
}
export function restoreManagementDraftFocusV10({ opener, region, document: documentPort, canRestore }: {
  opener: Pick<HTMLElement, 'isConnected' | 'matches' | 'focus'> | null; region: Pick<HTMLElement, 'contains'>;
  document: Pick<Document, 'activeElement' | 'body'>; canRestore: () => boolean;
}) {
  if (canRestore() && opener?.isConnected && !opener.matches(':disabled, [aria-disabled="true"]')
    && (region.contains(documentPort.activeElement) || documentPort.activeElement === documentPort.body)) opener.focus();
}
function StorageDialogV10({ session, storage, locale, t, onClose }: { session: ManagementSessionV10; storage?: ManagementStorageSlotV10; locale: Locale; t: Translator; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const id = useId();
  const status = useSyncExternalStore(storage?.subscribe ?? noStorage.subscribe, storage?.getSnapshot ?? noStorage.getSnapshot, storage?.getSnapshot ?? noStorage.getSnapshot);
  const canClose = () => !session.getSnapshot().holds.storageBusy && !storage?.getSnapshot().busy;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null; const node = dialog.current; node?.showModal();
    return () => { node?.close(); if (opener?.isConnected && !opener.matches(':disabled')) opener.focus(); };
  }, []);
  const close = () => { if (canClose()) onClose(); };
  return <dialog ref={dialog} className="management-v9-save-dialog management-v10-dialog" aria-labelledby={`${id}-title`}
    onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter(node => !node.hidden);
      const first = focusable[0], last = focusable.at(-1); if (!first || !last) { event.preventDefault(); dialog.current.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
    <header className="management-v9-dialog-heading management-v9-save-heading"><h2 id={`${id}-title`}>{t('managementV10.storageTitle')}</h2><button className="secondary" disabled={status.busy || session.getSnapshot().holds.storageBusy} onClick={close}>{t('save.close')}</button></header>
    <div className="management-v9-save-body">{storage ? storage.renderBody({ session, locale, close }) : <><p>{t('managementV10.storageUnavailable')}</p><button disabled>{t('save.write')}</button><p>{t('managementV10.migrationUnavailable')}</p></>}</div>
    <footer className="management-v9-save-feedback" role="status" aria-live="polite">{t((status.notice ?? status.summary).key, (status.notice ?? status.summary).parameters)}</footer>
  </dialog>;
}
export function managementBuildEquipmentLabelV10(equipment: readonly { readonly instanceId: string; readonly definitionId: string }[], id: string,
  name: (definitionId: string) => string, t: Translator): string {
  const item = equipment.find(row => row.instanceId === id); if (!item) return t('buildView.itemUnknown');
  const copies = equipment.filter(row => row.definitionId === item.definitionId);
  return copies.length > 1 ? t('buildView.itemCopy', { name: name(item.definitionId), number: copies.findIndex(row => row.instanceId === id) + 1 }) : name(item.definitionId);
}
/** The displayed comparison belongs to the frozen review, never to a newer
 * selected disciple or a mutable editor draft. Command authority is unchanged. */
export function ManagementBuildReviewDetailsV10({ review, locale, t }: { review: ManagementReviewV10; locale: Locale; t: Translator }) {
  if (review.kind !== 'command' || review.request.kind !== 'build.command') return null;
  const request = review.request.payload.command; const selected = review.basis.build.selected;
  if (!selected || selected.discipleId !== request.discipleId) return <p>{t('managementV9.stale')}</p>;
  let registry: ReturnType<typeof managementV9BuildContext>;
  try { registry = managementV9BuildContext(review.basis.build.contentIdentity); } catch { return <p>{t('buildView.unknownDefinition')}</p>; }
  const name = (id: string) => managementBuildNameV9(registry, locale, id);
  const names = (ids: readonly string[]) => ids.length ? ids.map(name).join(' · ') : t('managementV10.none');
  const itemName = (id: string) => managementBuildEquipmentLabelV10(selected.equipment, id, name, t);
  if (request.kind === 'tree.respec') return <div className="management-v10-build-review" data-build-review="tree.respec">
    <h4>{t('buildView.tree')}</h4><p>{t('managementV10.buildBefore', { names: names(selected.allocatedNodeIds) })}</p><p>{t('managementV10.buildAfter', { names: names(request.nodeIds) })}</p>
    <p>{t('managementV10.buildAdded', { names: names(request.nodeIds.filter(id => !selected.allocatedNodeIds.includes(id))) })}</p>
    <p>{t('managementV10.buildRemoved', { names: names(selected.allocatedNodeIds.filter(id => !request.nodeIds.includes(id))) })}</p><p>{t('managementV9.buildTreeCost')}</p>
  </div>;
  if (request.kind === 'skill.learn') return <p>{t('managementV9.buildLearnConfirm', { name: name(request.skillId), cost: registry.rules.lessons.find(row => row.skillId === request.skillId)?.creditCost ?? 0 })}</p>;
  const changes: { id: string; slot: TextKey; before: string; after: string }[] = [];
  for (const index of [0, 1] as const) if (selected.loadout.activeSkillIds[index] !== request.loadout.activeSkillIds[index]) changes.push({ id: `active-${index}`, slot: index === 0 ? 'buildView.activeOne' : 'buildView.activeTwo', before: name(selected.loadout.activeSkillIds[index]), after: name(request.loadout.activeSkillIds[index]) });
  if (selected.loadout.passiveSkillId !== request.loadout.passiveSkillId) changes.push({ id: 'passive', slot: 'buildView.passive', before: name(selected.loadout.passiveSkillId), after: name(request.loadout.passiveSkillId) });
  for (const slot of MANAGEMENT_BUILD_SLOTS_V9) if (selected.loadout.equipment[`${slot}Id`] !== request.loadout.equipment[`${slot}Id`]) changes.push({ id: slot, slot: `buildView.${slot}`, before: itemName(selected.loadout.equipment[`${slot}Id`]), after: itemName(request.loadout.equipment[`${slot}Id`]) });
  return <div className="management-v10-build-review" data-build-review="loadout.set"><h4>{t('buildView.loadout')}</h4>{changes.length ? <ul>{changes.map(change => <li key={change.id} data-build-change={change.id}>{t('managementV10.buildChange', { slot: t(change.slot), before: change.before, after: change.after })}</li>)}</ul> : <p>{t('managementV10.buildNoChanges')}</p>}</div>;
}
function ReviewPanelV10({ context, review, locale }: { context: UiContext; review: ManagementReviewV10 | null; locale: Locale }) {
  const { reviews, session, t, feedback } = context; const region = useRef<HTMLDivElement>(null); const [acknowledged, setAcknowledged] = useState<ManagementReviewV10 | null>(null);
  useReviewFocusV10(review, region, reviews.cancel, session);
  if (!review) return null;
  const proposal = review.kind === 'proposal' ? review.proposal : null; const denied = reviews.guard(review);
  const costs = (lines: readonly SectResourceLine[]) => managementResourceTextV9(lines, t);
  const disabled = !!denied || review.acknowledge && acknowledged !== review || !!proposal && (proposal.kind === 'placement' ? !proposal.view.allowed : proposal.kind === 'upgrade' ? !proposal.view.eligible : !!proposal.view.workOwner || proposal.view.preview.blockers.length > 0);
  return <div className="management-v9-review management-v10-review" ref={region} tabIndex={-1} role="group" aria-label={t('managementV10.reviewTitle')}>
    <h3>{t(review.title.key, review.title.parameters)}</h3>
    <ManagementBuildReviewDetailsV10 review={review} locale={locale} t={t} />
    {proposal?.kind === 'upgrade' && <><p>{t('managementV10.upgradeAdvisory')}</p><p>{costs(proposal.view.costs)}</p><p>{t('managementV9.workTicks', { ticks: proposal.view.requiredTicks })}</p><p>{t('managementV10.upgradeHalf', { cost: costs(proposal.view.halfCosts) })}</p><p>{t('managementV10.upgradeRemainder', { cost: costs(proposal.view.remainingCosts) })}</p><p>{t('managementV10.upgradeRule')}</p>{proposal.view.rejection && <p>{reasonText(proposal.view.rejection, t)}</p>}</>}
    {proposal?.kind === 'placement' && <><p>{t(proposal.view.allowed ? 'managementV9.previewAllowed' : 'managementV9.previewRejected')}</p><p>{costs(proposal.view.costs)}</p><p>{t('managementV9.workTicks', { ticks: proposal.view.requiredTicks })}</p>{proposal.view.code && <p>{reasonText(proposal.view.code, t)}</p>}{proposal.view.footprint && <p>{t('managementV9.geometry', { x: proposal.view.request.anchor.x, y: proposal.view.request.anchor.y, rotation: proposal.view.request.rotation, entranceX: proposal.view.footprint.entrance.x, entranceY: proposal.view.footprint.entrance.y })}</p>}</>}
    {proposal?.kind === 'breakthrough' && <ManagementCultivationRiskV9 preview={proposal.view.preview} t={t} />}
    {review.kind === 'command' && review.request.kind === 'cultivation.command' && review.request.payload.command.kind === 'breakthrough.resolve' && review.basis.cultivation.selected?.activeAttempt && <ManagementCultivationRiskV9 preview={review.basis.cultivation.selected.activeAttempt.preview} t={t} />}
    {review.warning && <p>{t(review.warning.key, review.warning.parameters)}</p>}
    {denied && <p>{t(denied)}</p>}
    {review.acknowledge && <label className="management-v9-checkbox"><input type="checkbox" checked={acknowledged === review} onChange={event => setAcknowledged(event.currentTarget.checked ? review : null)} /><span>{t(review.kind === 'command' && review.request.kind === 'cultivation.command' && review.request.payload.command.kind === 'death.finalize' ? 'cultivation.ui.acknowledgeDeath' : 'cultivation.ui.acknowledgeRisk')}</span></label>}
    <div className="management-v9-actions"><button type="button" disabled={disabled} onClick={() => { void reviews.confirm(review, acknowledged === review).then(feedback); }}>{t(proposal?.kind === 'upgrade' ? 'managementV10.upgradeConfirm' : proposal?.kind === 'placement' ? 'managementV9.placeBlueprint' : 'managementV9.buildConfirm')}</button><button type="button" className="secondary" onClick={reviews.cancel}>{t('managementV9.cancelPreview')}</button></div>
  </div>;
}
function reasonText(code: string, t: Translator) { const message = managementReasonV10(code); return t(message.key, message.parameters); }
function content(key: string, t: Translator) { return managementContentTextV9(key, t); }
function recipeName(id: string, t: Translator) { return content(SECT_V9_CANDIDATE.recipes.find(row => row.recipeId === id)?.nameKey ?? STARTER_RECIPES[id]?.nameKey ?? '', t); }
function personName(snapshot: ManagementSnapshotV10, id: string, t: Translator) { return content(snapshot.frame.disciples.find(actor => actor.id === id)?.nameKey ?? '', t); }
function performV10(context: UiContext, request: (current: ManagementSnapshotV10) => SessionRequestV10 | null, policy: PolicyV10 = 'ordinary') {
  const current = context.session.getSnapshot(); const denied = managementBlockedV10(current, context.getReadOnly(), false, policy)
    ?? (!managementBoundaryV10(context.snapshot, current) ? 'managementV9.stale' : null);
  if (denied) { context.feedback({ key: denied }); return; }
  const command = request(current); if (!command) { context.feedback({ key: 'managementV9.stale' }); return; }
  context.feedback(managementResultV10(context.session.dispatch(command)));
}
function SiteSourceV10({ source, t }: { source: RuntimeReadonlyV10<RuntimeProductionSiteV10>; t: Translator }) {
  return <p className="management-v10-source">{t('managementV10.actualSite', { site: source.siteId, level: source.level,
    construction: source.sourceJobId ?? t('managementV10.none'), upgrade: source.upgradeJobId ?? t('managementV10.none') })}</p>;
}
function DoseSourceV10({ source, t }: { source: RuntimeReadonlyV10<RuntimeDoseSourceV10>; t: Translator }) {
  return <div className="management-v10-source"><p>{t('managementV10.doseSource', { recipe: recipeName(source.recipeId, t), job: source.productionJobId })}</p><SiteSourceV10 source={source.site} t={t} /></div>;
}

export function managementCareReasonV10(snapshot: ManagementSnapshotV10, readOnly: boolean): TextKey | null {
  const blocked = managementBlockedV10(snapshot, readOnly); if (blocked) return blocked;
  const selected = snapshot.cultivation.selected; if (!selected) return 'managementV9.selectPatient';
  if (selected.lifeState === 'dead') return 'managementV9.careDead';
  if (selected.lifeState !== 'alive') return 'managementV9.carePendingDeath';
  if (selected.injury <= 0) return 'managementV9.careHealthy';
  if (selected.activityLocked || selected.workOwner !== null) return 'managementV9.careOccupied';
  return snapshot.expansion.stock.some(row => row.resourceId === 'wound-powder' && row.available > 0) ? null : 'managementV9.carePowderMissing';
}
export function ManagementSectPanelsV10({ context }: { context: UiContext }) {
  const { session, snapshot, readOnly, t, reviews, feedback } = context;
  const careCostId = `${useId()}-care-cost`;
  const [workerId, setWorkerId] = useState(() => snapshot.frame.disciples.find(row => managementWorkerAvailableV10(snapshot, row.id))?.id ?? '');
  useEffect(() => { setWorkerId(''); }, [snapshot.sessionEpoch]);
  const blocked = managementBlockedV10(snapshot, readOnly); const available = managementWorkerAvailableV10(snapshot, workerId);
  const careReason = managementCareReasonV10(snapshot, readOnly);
  const startDisabled = !!blocked || !available; const costs = (lines: readonly SectResourceLine[]) => managementResourceTextV9(lines, t);
  const name = (id: string) => personName(snapshot, id, t);
  const start = (request: (current: ManagementSnapshotV10) => SessionRequestV10) => performV10(context, current => managementWorkerAvailableV10(current, workerId) ? request(current) : null);
  const cancel = (job: RuntimeReadonlyV10<RuntimeExpansionJobV10>, opener: HTMLElement) => {
    const revision = snapshot.expansion.revisions[job.domain];
    const request: SessionRequestV10 = { kind: 'sect.command', payload: job.domain === 'construction'
      ? { domain: 'construction', command: { kind: 'construction.cancel', blueprintId: job.blueprintId, expectedRevision: revision } }
      : job.domain === 'upgrade' ? { domain: 'upgrade', command: { kind: 'upgrade.cancel', jobId: job.jobId, expectedRevision: revision } }
        : job.domain === 'production' ? { domain: 'production', command: { kind: 'production.cancel', jobId: job.jobId, expectedRevision: revision } }
          : job.domain === 'research' ? { domain: 'research', command: { kind: 'research.cancel', jobId: job.jobId, expectedRevision: revision } }
            : { domain: 'care', command: { kind: 'care.cancel', jobId: job.jobId, expectedRevision: revision } } };
    const notice = reviews.open(snapshot, request, { key: 'managementV9.cancelJob' }, { key: job.domain === 'upgrade' ? 'managementV10.upgradeCancelled' : 'managementV9.cancelHint' }, false, 'ordinary', { opener }); if (notice) feedback(notice);
  };
  return <div className="management-v9-panels">
    <div className="management-v9-panel-column"><section id="management-v10-production" className="management-v9-panel management-v9-anchor" tabIndex={-1}>
      <h2>{t('managementV9.production')}</h2><p className="management-v9-help">{t('managementV9.loopHint')}</p>
      <label className="management-v9-field">{t('production.worker')}<select value={workerId} disabled={!!blocked} onChange={event => setWorkerId(event.currentTarget.value)}><option value="">{t('managementV9.chooseWorker')}</option>{snapshot.frame.disciples.map(actor => <option key={actor.id} value={actor.id} disabled={!managementWorkerAvailableV10(snapshot, actor.id)}>{name(actor.id)} · {t(managementWorkerAvailableV10(snapshot, actor.id) ? 'managementV9.availableWorker' : 'managementV9.busyWorker')}</option>)}</select></label>
      {blocked && <p className="management-v9-notice">{t(blocked)}</p>}<p>{t('managementV9.deliveryHint')}</p>
      <div className="management-v9-recipe-list">{MANAGEMENT_BASE_RECIPES_V9.map(id => {
        const recipe = STARTER_RECIPES[id]!; const inputs: SectResourceLine[] = recipe.inputs.map(line => ({ ...line, ledger: 'base' }));
        return <article className="management-v9-card" key={id}><h3>{content(recipe.nameKey, t)}</h3><p>{t('production.recipeFlow', { inputs: costs(inputs), outputs: costs(recipe.outputs.map(line => ({ ...line, ledger: 'base' }))) })}</p><p>{t('managementV9.workTicks', { ticks: recipe.workTicks })}</p><button disabled={startDisabled || !managementHasResourcesV10(snapshot, inputs)} onClick={() => start(() => ({ kind: 'production.start', payload: { recipeId: id, workerId } }))}>{t('managementV9.start')}</button></article>;
      })}{snapshot.expansion.recipes.map(recipe => {
        const site = recipe.sites.some(row => row.paid && row.operational && !row.busy);
        return <article className="management-v9-card" key={recipe.recipeId}><h3>{recipeName(recipe.recipeId, t)}</h3><p>{t('production.recipeFlow', { inputs: costs(recipe.inputs), outputs: costs(recipe.outputs) })}</p><p>{t('managementV9.workTicks', { ticks: recipe.requiredTicks })}</p>
          {!recipe.researchSatisfied && <p>{t('managementV9.reason.research')}</p>}{recipe.deficits.length > 0 && <p>{t('managementV9.reason.resources')} · {costs(recipe.deficits)}</p>}
          {!recipe.sites.length && <p>{t('managementV9.reason.station')}</p>}{recipe.sites.map(row => <p key={`${row.kind}:${row.siteId}`}>{t('managementV10.eligibleSite', { site: row.siteId, level: row.level, state: t(row.busy ? 'managementV10.siteBusy' : row.paid && row.operational ? 'managementV9.operational' : 'managementV9.suspended') })}</p>)}
          <button disabled={startDisabled || !recipe.researchSatisfied || recipe.deficits.length > 0 || !site} onClick={() => start(current => ({ kind: 'sect.command', payload: { domain: 'production', command: { kind: 'production.start', recipeId: recipe.recipeId, workerId, expectedRevision: current.expansion.revisions.production } } }))}>{t('managementV9.start')}</button></article>;
      })}</div><p className="management-v9-help">{t('managementV10.recipeAdvisory')}</p>
    </section></div>
    <div className="management-v9-panel-column">
      <section id="management-v10-jobs" className="management-v9-panel management-v9-anchor" tabIndex={-1}><h2>{t('managementV9.jobs')}</h2><p>{t('managementV9.cancelHint')}</p>
        {snapshot.frame.transactions.filter(job => job.state !== 'Committed' && job.state !== 'Cancelled').map(job => <article className="management-v9-card" key={job.transactionId}><h3>{recipeName(job.recipeId, t)} · {name(job.workerId)}</h3><p>{t(managementPhaseKeyV9(job.phase))}</p><p>{t('managementV9.owner', { id: job.transactionId })}</p><progress value={job.activeTicks} max={job.requiredTicks} aria-label={t('managementV9.progress', { active: job.activeTicks, required: job.requiredTicks })} /><p>{t('managementV9.progress', { active: job.activeTicks, required: job.requiredTicks })}</p>{job.blockedReason && <p>{reasonText(job.blockedReason, t)}</p>}<button className="secondary" disabled={!!blocked} onClick={() => performV10(context, () => ({ kind: 'production.cancel', payload: { transactionId: job.transactionId } }))}>{t('managementV9.cancelJob')}</button></article>)}
        {snapshot.expansion.jobs.map(job => <article className="management-v9-card" key={job.jobId}><h3>{job.domain === 'production' ? recipeName(job.recipeId, t) : job.domain === 'research' ? content(SECT_V9_CANDIDATE.research.find(row => row.id === job.researchId)?.nameKey ?? '', t) : t(job.domain === 'upgrade' ? 'managementV10.upgrade' : job.domain === 'care' ? 'managementV9.care' : 'managementV9.construction')} · {name(job.domain === 'care' ? job.patientId : job.workerId)}</h3><p>{t(managementPhaseKeyV9(job.phase))}</p><p>{t('managementV9.owner', { id: job.jobId })}</p><progress value={job.activeTicks} max={job.requiredTicks} aria-label={t('managementV9.progress', { active: job.activeTicks, required: job.requiredTicks })} /><p>{t('managementV9.progress', { active: job.activeTicks, required: job.requiredTicks })}</p>
          {job.domain === 'upgrade' && <><p>{t('managementV10.checkpointPolicy', { half: 200, end: 400, active: job.activeTicks })}</p><p>{t('managementV10.upgradeRule')}</p>{job.checkpoints.length === 0 && <p>{t('managementV10.noCheckpoint')}</p>}{job.checkpoints.map(checkpoint => <div key={checkpoint.checkpointId}><p>{t('managementV10.checkpointRecord', { active: checkpoint.activeTicks, tick: checkpoint.tick })}</p><p>{t('managementV10.consumed', { cost: costs(checkpoint.consumed) })}</p></div>)}</>}
          {job.domain === 'production' && <SiteSourceV10 source={job.site} t={t} />}{job.domain === 'care' && <DoseSourceV10 source={job.doseSource} t={t} />}
          {job.blocked && <p className="management-v9-notice">{reasonText(job.blocked, t)}</p>}<button className="secondary" disabled={!!blocked} onClick={event => cancel(job, event.currentTarget)}>{t('managementV9.cancelJob')}</button></article>)}
        {!snapshot.expansion.jobs.length && !snapshot.frame.transactions.some(job => job.state !== 'Committed' && job.state !== 'Cancelled') && <p>{t('managementV9.noJobs')}</p>}
      </section>
      <section id="management-v10-research" className="management-v9-panel management-v9-anchor" tabIndex={-1}><h2>{t('managementV9.research')}</h2>
        {SECT_V9_CANDIDATE.research.map(research => {
          const done = snapshot.expansion.completedResearch.some(row => row.researchId === research.id);
          const prerequisites = research.prerequisites.every(id => snapshot.expansion.completedResearch.some(row => row.researchId === id));
          const station = snapshot.expansion.buildings.some(row => row.definitionId === 'library.v9' && row.maintenance.operational);
          return <article className="management-v9-card" key={research.id}><h3>{content(research.nameKey, t)}</h3><p>{costs(research.costs)}</p><p>{t('managementV9.workTicks', { ticks: research.workTicks })}</p>{done ? <p>{t('managementV9.researched')}</p> : <>{!prerequisites && <p>{t('managementV9.reason.research')}</p>}{!station && <p>{t('managementV9.reason.station')}</p>}<button disabled={startDisabled || !prerequisites || !station || !managementHasResourcesV10(snapshot, research.costs) || snapshot.expansion.jobs.some(row => row.domain === 'research')} onClick={() => start(current => ({ kind: 'sect.command', payload: { domain: 'research', command: { kind: 'research.start', researchId: research.id, workerId, expectedRevision: current.expansion.revisions.research } } }))}>{t('managementV9.startResearch')}</button></>}</article>;
        })}
        <h3>{t('managementV9.blueprints')}</h3>{!snapshot.expansion.blueprints.length && <p>{t('managementV9.noBlueprints')}</p>}
        {snapshot.expansion.blueprints.map(blueprint => <article className="management-v9-card" key={blueprint.blueprintId}><h3>{t(blueprint.definitionId === 'library.v9' ? 'sectV9.building.library' : 'sectV9.building.alchemy')}</h3><p>{t('managementV9.geometry', { x: blueprint.anchor.x, y: blueprint.anchor.y, rotation: blueprint.rotation, entranceX: blueprint.footprint.entrance.x, entranceY: blueprint.footprint.entrance.y })}</p><p>{t(blueprint.status === 'planned' ? 'managementV9.blueprintPlanned' : 'managementV9.blueprintStarted')}</p>{blueprint.status === 'planned' && <div className="management-v9-actions"><button disabled={startDisabled} onClick={() => start(current => ({ kind: 'sect.command', payload: { domain: 'construction', command: { kind: 'construction.start', blueprintId: blueprint.blueprintId, workerId, expectedRevision: current.expansion.revisions.construction } } }))}>{t('managementV9.startConstruction')}</button><button className="secondary" disabled={!!blocked} onClick={() => performV10(context, current => ({ kind: 'sect.command', payload: { domain: 'construction', command: { kind: 'construction.cancel', blueprintId: blueprint.blueprintId, expectedRevision: current.expansion.revisions.construction } } }))}>{t('managementV9.cancelBlueprint')}</button></div>}</article>)}
      </section>
      <section id="management-v10-upgrade" className="management-v9-panel management-v9-anchor" tabIndex={-1}><h2>{t('managementV10.upgrade')}</h2><p>{t('managementV10.upgradeRule')}</p>
        {!snapshot.expansion.buildings.some(row => row.definitionId === 'alchemy.v9') && <p>{t('managementV10.noAlchemy')}</p>}
        {snapshot.expansion.buildings.filter(row => row.definitionId === 'alchemy.v9').map(building => <article className="management-v9-card" key={building.buildingId}><h3>{t('sectV9.building.alchemy')} · {t('managementV9.level', { level: building.level })}</h3><p>{t('managementV9.owner', { id: building.buildingId })}</p><p>{t('managementV10.origin', { construction: building.levelEvidence.constructionJobId, upgrade: building.levelEvidence.upgradeJobId ?? t('managementV10.none') })}</p>{building.level === 1 && <button disabled={startDisabled || building.activeUpgradeJobId !== null} onClick={event => {
          if (!managementWorkerAvailableV10(session.getSnapshot(), workerId)) { feedback({ key: 'managementV9.reason.worker' }); return; }
          const notice = reviews.prepare(snapshot, () => session.prepareUpgrade({ buildingId: building.buildingId, workerId }), { key: 'managementV10.upgrade' }, false, { opener: event.currentTarget }); if (notice) feedback(notice);
        }}>{t('managementV10.upgradePreview')}</button>}</article>)}
        {snapshot.expansion.recentTerminals.filter(row => row.domain === 'upgrade').map(row => <article key={row.jobId} className="management-v9-card">{row.resultLevel !== null && <p>{t('managementV10.terminalLevel', { job: row.jobId, state: t(row.kind === 'completed' ? 'managementV9.phase.completed' : 'managementV9.phase.cancelled'), level: row.resultLevel })}</p>}<p>{t('managementV10.consumed', { cost: costs(row.consumed) })}</p><p>{t('managementV10.released', { cost: costs(row.released) })}</p></article>)}
      </section>
      <section id="management-v10-care" className="management-v9-panel management-v9-anchor" tabIndex={-1}><h2>{t('managementV9.care')}</h2><p>{t('managementV9.careHint')}</p><p>{t('managementV10.noDoseChoice')}</p>
        {snapshot.cultivation.selected ? <><h3>{name(snapshot.cultivation.selected.discipleId)}</h3><p>{t('managementV9.injury', { injury: snapshot.cultivation.selected.injury })}</p><p id={careCostId}>{t('managementV9.careCost')}<span className="management-v9-care-reason">{careReason ? t(careReason) : null}</span></p><button aria-describedby={careCostId} disabled={!!careReason} onClick={() => performV10(context, current => {
          const selected = current.cultivation.selected; return selected && selected.discipleId === snapshot.cultivation.selected?.discipleId && selected.lifeState === 'alive' && selected.injury > 0 && !selected.activityLocked && !selected.workOwner ? { kind: 'sect.command', payload: { domain: 'care', command: { kind: 'care.start', patientId: selected.discipleId, expectedRevision: current.expansion.revisions.care } } } : null;
        })}>{t('managementV9.startCare')}</button></> : <p>{t('managementV9.selectPatient')}</p>}
        {snapshot.expansion.recentTerminals.filter(row => row.domain === 'care').map(row => <article className="management-v9-card" key={row.jobId}>{row.beforeInjury !== null && row.afterInjury !== null && <p>{t('managementV9.careResult', { name: name(row.actorId), before: row.beforeInjury, after: row.afterInjury })}</p>}{row.doseSource && <DoseSourceV10 source={row.doseSource} t={t} />}</article>)}
      </section>
      <section id="management-v10-maintenance" className="management-v9-panel management-v9-anchor" tabIndex={-1}><h2>{t('managementV9.maintenance')}</h2><p>{t('managementV9.maintenanceHint')}</p><p>{t('managementV10.maintenanceRate')}</p>
        {snapshot.expansion.buildings.map(building => <article className="management-v9-card" key={building.buildingId}><h3>{t(building.definitionId === 'library.v9' ? 'sectV9.building.library' : 'sectV9.building.alchemy')} · {t('managementV9.level', { level: building.level })}</h3><p>{t(building.maintenance.operational ? 'managementV9.operational' : 'managementV9.suspended')}</p><p>{t('managementV9.maintenanceDue', { tick: building.maintenance.dueCalendarTick, remaining: Math.max(0, building.maintenance.dueCalendarTick - snapshot.frame.clock.calendarTick) })}</p>
          {building.maintenance.currentPeriod ? <p>{t('managementV10.currentPeriod', { level: building.maintenance.currentPeriod.level, paid: building.maintenance.currentPeriod.paidCalendarTick, due: building.maintenance.currentPeriod.dueCalendarTick })}</p> : <p>{t('managementV10.noPaidPeriod')}</p>}
          <p>{t('managementV10.nextMaintenance', { cost: costs(building.maintenance.nextMaintenanceCosts) })}</p>{building.maintenance.deficits.length > 0 && <p className="management-v9-notice">{t('managementV9.reason.resources')} · {costs(building.maintenance.deficits)}</p>}{building.maintenance.renewalBlock && <p>{reasonText(building.maintenance.renewalBlock, t)}</p>}</article>)}
      </section>
    </div>
  </div>;
}

function CultivationPanelV10({ context }: { context: UiContext }) {
  const { session, snapshot, readOnly, t, reviews, feedback } = context; const selected = snapshot.cultivation.selected;
  const [preparation, setPreparation] = useState<BreakthroughPreparation>({ method: 'standard', arraySupport: 0 });
  const [heir, setHeir] = useState<string | null>(selected?.heirId ?? null);
  const blocked = managementBlockedV10(snapshot, readOnly); const attempt = selected?.activeAttempt;
  const decisionExit = !!selected && snapshot.cultivation.decisions.some(row => row.discipleId === selected.discipleId);
  const exitBlocked = managementBlockedV10(snapshot, readOnly, false, decisionExit ? 'cultivation-exit' : 'ordinary');
  const openDecision = (kind: 'cancel' | 'resolve' | 'death', opener: HTMLElement) => {
    if (!selected) return;
    const request: SessionRequestV10 | null = kind === 'death' && selected.pendingDeath?.cause === 'lifespan'
      ? { kind: 'cultivation.command', payload: { command: { kind: 'death.finalize', discipleId: selected.discipleId, deathId: selected.pendingDeath.deathId, cause: 'lifespan', acknowledgeDeath: true, expectedRevision: snapshot.cultivation.revision } } }
      : attempt && kind !== 'death' ? { kind: 'cultivation.command', payload: { command: kind === 'cancel'
        ? { kind: 'breakthrough.cancel', attemptId: attempt.attemptId, expectedRevision: snapshot.cultivation.revision }
        : { kind: 'breakthrough.resolve', attemptId: attempt.attemptId, acknowledgeRisk: true, expectedRevision: snapshot.cultivation.revision } } } : null;
    if (!request) return;
    const warning: ManagementTextV10 = kind === 'cancel' ? { key: 'cultivation.ui.cancelWarning' } : { key: 'cultivation.ui.deathDestination', parameters: { count: selected.relicCount, beneficiary: selected.heirId ? personName(snapshot, selected.heirId, t) : t('cultivation.ui.sectBeneficiary') } };
    const message = reviews.open(snapshot, request, { key: kind === 'death' ? 'cultivation.ui.deathTitle' : kind === 'cancel' ? 'cultivation.ui.confirmCancel' : 'managementV9.reviewCultivationRisk' }, warning, kind !== 'cancel', decisionExit ? 'cultivation-exit' : 'ordinary', { opener });
    if (message) feedback(message);
  };
  return <section id="management-v10-cultivation" className="management-v9-panel management-v9-anchor" tabIndex={-1}><h2>{t('cultivation.ui.title')}</h2>
    {snapshot.cultivation.decisions.length > 0 && <div className="management-v9-card"><p>{t('cultivation.ui.pending', { count: snapshot.cultivation.decisions.length })}</p><p>{t('managementV9.cultivationDecisionHint')}</p>{snapshot.cultivation.decisions.map(row => <button className="secondary" key={`${row.kind}:${row.discipleId}`} disabled={snapshot.closed || snapshot.holds.storageBusy || snapshot.holds.overlay} onClick={() => {
      const current = session.getSnapshot(); if (!managementBoundaryV10(snapshot, current) || current.holds.storageBusy || current.holds.overlay) { feedback({ key: 'managementV9.stale' }); return; }
      reviews.cancel(); session.select({ kind: 'disciple', id: row.discipleId });
    }}>{t('cultivation.ui.review', { name: personName(snapshot, row.discipleId, t) })}</button>)}</div>}
    {!selected ? <p>{t('managementV9.selectCultivator')}</p> : <>
      <h3>{personName(snapshot, selected.discipleId, t)} · {t(`cultivation.realm.${selected.realm}`)}</h3><p>{t('cultivation.ui.lifespan', { months: selected.remainingLifespanMonths })} · {t('cultivation.ui.injury', { value: selected.injury })}</p>
      <p>{selected.requiredCultivation > 0 ? t('cultivation.ui.progress', { value: selected.cultivation, required: selected.requiredCultivation }) : t('cultivation.ui.finalRealm')}</p>{selected.requiredCultivation > 0 && <progress value={selected.cultivation} max={selected.requiredCultivation} aria-label={t('cultivation.ui.progress', { value: selected.cultivation, required: selected.requiredCultivation })} />}
      <p>{t('cultivation.ui.understanding', { value: selected.understanding })} · {t('cultivation.ui.foundation', { value: selected.foundation })} · {t('cultivation.ui.mindset', { value: selected.mindset })}</p>
      {selected.lastOutcome && <p>{t('cultivation.ui.outcome', { outcome: t(`cultivation.outcome.${selected.lastOutcome}`) })}</p>}
      <div className="management-v9-actions" role="group" aria-label={t('cultivation.ui.mode')}>{(['duty', 'training', 'rest'] as const).map(mode => <button type="button" className="secondary" key={mode} aria-pressed={selected.trainingMode === mode}
        disabled={!!blocked || selected.lifeState !== 'alive' || !!attempt || !!selected.teaching || !!selected.learning || selected.trainingMode === mode || !!selected.workOwner && !(mode === 'duty' || mode === 'rest' && selected.workOwner.kind === 'care')}
        onClick={() => performV10(context, current => ({ kind: 'cultivation.command', payload: { command: { kind: 'training.set', discipleId: selected.discipleId, mode, expectedRevision: current.cultivation.revision } } }))}>{t(`cultivation.mode.${mode}`)}</button>)}</div><p>{t('managementV9.cultivationModeHint')} {t('cultivation.ui.monthHint')}</p>
      {selected.pendingDeath && <article className="management-v9-card"><h3>{t('cultivation.ui.deathTitle')}</h3><p>{t('cultivation.ui.deathWarning', { cause: t(`cultivation.cause.${selected.pendingDeath.cause}`) })}</p>{selected.pendingDeath.cause === 'lifespan' && <button disabled={!!exitBlocked} onClick={event => openDecision('death', event.currentTarget)}>{t('managementV9.reviewCultivationDeath')}</button>}</article>}
      {selected.lifeState === 'alive' && <article className="management-v9-card"><h3>{t('cultivation.ui.breakthrough')}</h3>{attempt ? <>
        <p>{t(`cultivation.attempt.${attempt.phase}`)}</p><p>{t('cultivation.ui.monthsCompleted', { completed: attempt.completedMonths, required: attempt.preview.seclusionMonths })}</p><progress value={attempt.completedMonths} max={attempt.preview.seclusionMonths} aria-label={t('cultivation.ui.monthsCompleted', { completed: attempt.completedMonths, required: attempt.preview.seclusionMonths })} />
        {attempt.blockedReason && <p>{t('cultivation.ui.supplyBlocked', { months: attempt.blockedMonths })}</p>}<details><summary>{t('managementV9.reservedCultivationPlan')}</summary><ManagementCultivationRiskV9 preview={attempt.preview} t={t} /></details>
        <div className="management-v9-actions">{attempt.phase === 'Reserved' && <button disabled={!!blocked} onClick={() => performV10(context, current => ({ kind: 'cultivation.command', payload: { command: { kind: 'breakthrough.begin', attemptId: attempt.attemptId, expectedRevision: current.cultivation.revision } } }))}>{t('cultivation.ui.begin')}</button>}{attempt.phase === 'DecisionReady' && <button disabled={!!exitBlocked} onClick={event => openDecision('resolve', event.currentTarget)}>{t('managementV9.reviewCultivationRisk')}</button>}<button className="secondary" disabled={!!exitBlocked} onClick={event => openDecision('cancel', event.currentTarget)}>{t('cultivation.ui.cancel')}</button></div>
      </> : <><div className="management-v9-coordinates"><label>{t('cultivation.ui.method')}<select value={preparation.method} disabled={!!blocked} onChange={event => setPreparation({ ...preparation, method: event.currentTarget.value === 'forced' ? 'forced' : 'standard' })}><option value="standard">{t('cultivation.method.standard')}</option><option value="forced">{t('cultivation.method.forced')}</option></select></label><label>{t('cultivation.ui.array')}<select value={preparation.arraySupport} disabled={!!blocked} onChange={event => { const next = Number(event.currentTarget.value); setPreparation({ ...preparation, arraySupport: next === 2 ? 2 : next === 1 ? 1 : 0 }); }}>{([0, 1, 2] as const).map(level => <option key={level} value={level}>{t('cultivation.ui.arrayLevel', { level })}</option>)}</select></label></div><p>{t('cultivation.ui.previewReadOnly')}</p><button disabled={!!blocked || !!selected.workOwner || !!selected.teaching || !!selected.learning} onClick={event => { const message = reviews.prepare(snapshot, () => session.prepareBreakthrough(selected.discipleId, preparation), { key: 'cultivation.ui.preview' }, true, { opener: event.currentTarget }); if (message) feedback(message); }}>{t('cultivation.ui.preview')}</button></>}</article>}
      <details className="management-v9-card"><summary>{t('cultivation.ui.legacy')}</summary><p>{t('cultivation.ui.deathDestination', { count: selected.relicCount, beneficiary: selected.heirId ? personName(snapshot, selected.heirId, t) : t('cultivation.ui.sectBeneficiary') })}</p>
        <label className="management-v9-field">{t('cultivation.ui.heir')}<select value={heir ?? ''} disabled={!!exitBlocked || selected.lifeState !== 'alive'} onChange={event => setHeir(event.currentTarget.value || null)}><option value="">{t('cultivation.ui.noHeir')}</option>{selected.heirChoices.map(id => <option key={id} value={id}>{personName(snapshot, id, t)}</option>)}</select></label><button className="secondary" disabled={!!exitBlocked || selected.lifeState !== 'alive' || heir === selected.heirId || heir !== null && !selected.heirChoices.includes(heir)} onClick={() => performV10(context, current => ({ kind: 'cultivation.command', payload: { command: { kind: 'legacy.setHeir', discipleId: selected.discipleId, heirId: heir, expectedRevision: current.cultivation.revision } } }), decisionExit ? 'cultivation-exit' : 'ordinary')}>{t('cultivation.ui.setHeir')}</button>
        {selected.teaching && <p>{t('cultivation.ui.teachingProgress', { name: personName(snapshot, selected.teaching.studentId, t), knowledge: t('cultivation.ui.knownKnowledge', { id: selected.teaching.knowledgeId }), completed: selected.teaching.completedMonths, required: selected.teaching.requiredMonths })}</p>}{selected.learning && <p>{t('managementV9.cultivationLearningProgress', { completed: selected.learning.completedMonths, required: selected.learning.requiredMonths })}</p>}<p>{t('managementV9.cultivationTeachingScope')}</p>
      </details>
    </>}
  </section>;
}
function BuildPanelV10({ context, locale }: { context: UiContext; locale: Locale }) {
  const { session, snapshot, readOnly, t, reviews, feedback } = context;
  const selected = snapshot.build.selected; const [draft, setDraft] = useState<{ basis: ManagementSnapshotV10; request: Exclude<BuildRequestV10, { kind: 'skill.learn' }> } | null>(null);
  const region = useRef<HTMLElement>(null); const draftOpener = useRef<HTMLElement | null>(null);
  const latest = useRef({ context, draft }); latest.current = { context, draft };
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; draftOpener.current = null; }; }, []);
  const canDiscard = () => {
    const value = latest.current; const current = session.getSnapshot(); const basis = value.draft?.basis;
    return mounted.current && !!basis && !reviews.getSnapshot() && !current.closed && !current.holds.storageBusy && !current.holds.overlay && !current.holds.review
      && basis.sessionEpoch === current.sessionEpoch && basis.selection?.kind === current.selection?.kind && basis.selection?.id === current.selection?.id;
  };
  const discard = () => {
    if (!canDiscard()) return;
    const basis = latest.current.draft!.basis; const opener = draftOpener.current;
    latest.current = { ...latest.current, draft: null }; draftOpener.current = null; setDraft(null);
    if (region.current) restoreManagementDraftFocusV10({ opener, region: region.current, document, canRestore: () => {
      const current = session.getSnapshot(); return mounted.current && !reviews.getSnapshot() && !current.closed && !current.holds.storageBusy && !current.holds.overlay
        && current.sessionEpoch === basis.sessionEpoch && current.selection?.kind === basis.selection?.kind && current.selection?.id === basis.selection?.id;
    } });
  };
  useEffect(() => {
    if (!draft) return;
    return attachManagementDraftEscapeV10({ target: document, canDiscard, discard });
  }, [draft, reviews, session]);
  const registry = useMemo(() => { try { return managementV9BuildContext(snapshot.build.contentIdentity); } catch { return null; } }, [snapshot.build.contentIdentity]);
  const blocked = managementBlockedV10(snapshot, readOnly, false, 'build');
  const stale = !!draft && !managementBoundaryV10(draft.basis, snapshot); const locked = !selected || selected.lifeState !== 'alive' || selected.locked;
  const disabled = !!blocked || stale || locked;
  const name = (id: string) => registry ? managementBuildNameV9(registry, locale, id) : t('buildView.unknownDefinition');
  const stage = (request: Exclude<BuildRequestV10, { kind: 'skill.learn' }>, opener: HTMLElement) => {
    const current = session.getSnapshot(); const denied = managementBlockedV10(current, context.getReadOnly(), false, 'build');
    if (denied || !managementBoundaryV10(draft?.basis ?? snapshot, current) || current.build.selected?.locked) { feedback({ key: denied ?? 'managementV9.stale' }); return; }
    if (!draft) draftOpener.current = opener;
    setDraft({ basis: draft?.basis ?? snapshot, request });
  };
  const open = (basis: ManagementSnapshotV10, request: BuildRequestV10, opener: HTMLElement) => {
    if (!selected || !registry) return;
    const reason = request.kind === 'skill.learn' ? managementBuildLearnErrorV9(selected, registry, request.skillId) : request.kind === 'tree.respec' ? managementBuildTreeErrorV9(selected, registry, request.nodeIds) : managementBuildLoadoutErrorV9(selected, registry, request.loadout);
    if (reason) { feedback({ key: reason }); return; }
    const title: ManagementTextV10 = request.kind === 'skill.learn' ? { key: 'managementV9.buildLearnConfirm', parameters: { name: name(request.skillId), cost: registry.rules.lessons.find(row => row.skillId === request.skillId)!.creditCost } } : { key: 'managementV9.buildConfirmChanges' };
    const notice = reviews.open(basis, { kind: 'build.command', payload: { command: request } }, title, null, false, 'build', { opener, ...(draftOpener.current ? { restoreTo: draftOpener.current } : {}) });
    if (notice) feedback(notice); else { draftOpener.current = null; setDraft(null); }
  };
  const loadout: RuntimeReadonlyV10<BuildLoadout> | null = draft?.request.kind === 'loadout.set' ? draft.request.loadout : selected?.loadout ?? null;
  const nodeIds = draft?.request.kind === 'tree.respec' ? draft.request.nodeIds : selected?.allocatedNodeIds ?? [];
  const stageLoadout = (next: RuntimeReadonlyV10<BuildLoadout>, opener: HTMLElement) => { if (selected) stage({ kind: 'loadout.set', discipleId: selected.discipleId, expectedRevision: snapshot.build.revision, loadout: next }, opener); };
  const skills = registry?.catalog.skills.filter(skill => skill.school === selected?.school) ?? [];
  return <section ref={region} id="management-v10-build" className="management-v9-panel management-v9-anchor" tabIndex={-1}><h2>{t('managementV9.buildTitle')}</h2>
    {!selected || !registry || !loadout ? <p>{t('buildView.selectDisciple')}</p> : <>
      <h3>{personName(snapshot, selected.discipleId, t)}</h3><p>{t('buildView.points', { earned: selected.progress.earnedPoints, allocated: selected.progress.allocatedPoints, remaining: selected.progress.availablePoints })}</p><p>{t('buildView.credits', { remaining: selected.progress.availableLearningCredits, earned: selected.progress.earnedLearningCredits })}</p><p>{t('managementV9.buildMilestoneHelp')}</p>
      {blocked && <p>{t(blocked)}</p>}{!snapshot.frame.clock.pauseReasons.includes('player') && <button disabled={!!managementBlockedV10(snapshot, readOnly)} onClick={() => { if (!managementBoundaryV10(snapshot, session.getSnapshot()) || managementBlockedV10(session.getSnapshot(), context.getReadOnly())) { feedback({ key: 'managementV9.stale' }); return; } feedback(managementResultV10(session.setPaused('player', true))); }}>{t('managementV9.buildPauseEdit')}</button>}{locked && <p>{t('managementV9.buildOccupied')}</p>}{stale && <p>{t('buildView.draftStale')}</p>}
      <div className="management-v9-card"><h3>{t('buildView.loadout')}</h3><p>{t('buildView.basic')} · {name(loadout.basicId)}</p><div className="management-v9-recipe-list">{([0, 1] as const).map(index => <label className="management-v9-field" key={index}>{t(index === 0 ? 'buildView.activeOne' : 'buildView.activeTwo')}<select value={loadout.activeSkillIds[index]} disabled={disabled || draft?.request.kind === 'tree.respec'} onChange={event => { const activeSkillIds: [string, string] = [...loadout.activeSkillIds]; activeSkillIds[index] = event.currentTarget.value; stageLoadout({ ...loadout, activeSkillIds }, event.currentTarget); }}>{skills.filter(skill => skill.activation === 'active' && selected.learnedSkillIds.includes(skill.id) && managementBuildSupportedV9(registry, skill.id)).map(skill => <option key={skill.id} value={skill.id} disabled={skill.id === loadout.activeSkillIds[index === 0 ? 1 : 0]}>{name(skill.id)}</option>)}</select></label>)}
        <label className="management-v9-field">{t('buildView.passive')}<select value={loadout.passiveSkillId} disabled={disabled || draft?.request.kind === 'tree.respec'} onChange={event => stageLoadout({ ...loadout, passiveSkillId: event.currentTarget.value }, event.currentTarget)}>{skills.filter(skill => skill.activation === 'passive' && selected.learnedSkillIds.includes(skill.id) && managementBuildSupportedV9(registry, skill.id)).map(skill => <option key={skill.id} value={skill.id}>{name(skill.id)}</option>)}</select></label></div>
        <button className="secondary" disabled={disabled || draft?.request.kind === 'tree.respec'} onClick={event => stageLoadout({ ...loadout, activeSkillIds: [loadout.activeSkillIds[1], loadout.activeSkillIds[0]] }, event.currentTarget)}>{t('managementV9.buildSwapActive')}</button><p>{t('managementV9.buildOnlyOwned')} {t('managementV9.buildSlotsRequired')}</p>
        {MANAGEMENT_BUILD_SLOTS_V9.map(slot => { const items = managementBuildEquipmentV9(selected, registry, slot); return <label key={slot} className="management-v9-field">{t(`buildView.${slot}`)}<select value={loadout.equipment[`${slot}Id`]} disabled={disabled || draft?.request.kind === 'tree.respec' || items.length < 2} onChange={event => stageLoadout({ ...loadout, equipment: { ...loadout.equipment, [`${slot}Id`]: event.currentTarget.value } }, event.currentTarget)}>{items.map(item => <option key={item.instanceId} value={item.instanceId}>{managementBuildEquipmentLabelV10(items, item.instanceId, name, t)}</option>)}</select>{items.length === 1 && <small>{t('managementV9.buildOneItem')}</small>}</label>; })}
      </div>
      <details className="management-v9-card"><summary>{t('buildView.tree')}</summary><p>{t('managementV9.buildTreeCost')}</p><p>{t('buildView.removeDependents')}</p>{registry.catalog.treeNodes.filter(node => node.treeId === selected.treeId).map(node => {
        const toggle = managementBuildToggleNodeV9(selected, registry, nodeIds, node.id); return <article key={node.id} className="management-v9-card"><h4>{name(node.id)}</h4><p>{t('buildView.tier', { tier: node.tier, cost: node.pointCost })}</p>{!toggle.ok && <p>{t(toggle.reason)}</p>}<button className="secondary" aria-pressed={nodeIds.includes(node.id)} disabled={disabled || draft?.request.kind === 'loadout.set' || !toggle.ok} onClick={event => { if (toggle.ok) stage({ kind: 'tree.respec', discipleId: selected.discipleId, expectedRevision: snapshot.build.revision, nodeIds: toggle.nodeIds }, event.currentTarget); }}>{t('buildView.toggleNode', { name: name(node.id) })}</button></article>;
      })}</details>
      {draft && <div className="management-v9-review"><p>{t(draft.request.kind === 'tree.respec' ? 'buildView.tree' : 'buildView.draftLoadout')}</p>{draft.request.kind === 'tree.respec' ? <p>{draft.request.nodeIds.map(name).join(' · ')}</p> : <p>{[...draft.request.loadout.activeSkillIds, draft.request.loadout.passiveSkillId].map(name).join(' · ')}</p>}<div className="management-v9-actions"><button disabled={disabled} onClick={event => open(draft.basis, draft.request, event.currentTarget)}>{t(draft.request.kind === 'tree.respec' ? 'buildView.applyTree' : 'buildView.applyLoadout')}</button><button className="secondary" onClick={discard}>{t('buildView.discardDraft')}</button></div></div>}
      <details className="management-v9-card"><summary>{t('buildView.skills')} · {t('buildView.learnedCount', { count: selected.learnedSkillIds.length })}</summary><p>{t('managementV9.buildSkillsHelp')}</p>{skills.map(skill => { const learned = selected.learnedSkillIds.includes(skill.id); const reason = managementBuildLearnErrorV9(selected, registry, skill.id); const lesson = registry.rules.lessons.find(row => row.skillId === skill.id); return <article className="management-v9-card" key={skill.id}><h3>{name(skill.id)}</h3><p>{t(learned ? 'buildView.learned' : 'buildView.notLearned')}</p>{!learned && <>{reason && <p>{t(reason)}</p>}<button disabled={disabled || !!draft || !!reason || !lesson} onClick={event => open(snapshot, { kind: 'skill.learn', discipleId: selected.discipleId, expectedRevision: snapshot.build.revision, skillId: skill.id }, event.currentTarget)}>{t('buildView.learn', { cost: lesson?.creditCost ?? 0 })}</button></>}</article>; })}</details>
    </>}
  </section>;
}

export function ManagementAppV10({ session, storage, initialLocale }: ManagementAppV10Props) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const storageStatus = useSyncExternalStore(storage?.subscribe ?? noStorage.subscribe, storage?.getSnapshot ?? noStorage.getSnapshot, storage?.getSnapshot ?? noStorage.getSnapshot);
  const [locale, setLocale] = useState<Locale>(() => initialLocale ?? (typeof window === 'undefined' ? DEFAULT_LOCALE : readLocalePreference()));
  const [notice, setNotice] = useState<ManagementTextV10 | null>(null); const [saveOpen, setSaveOpen] = useState(false);
  const [placement, setPlacement] = useState<SectPlacementRequest>({ definitionId: 'library.v9', anchor: { x: 2, y: 2 }, rotation: 0 });
  const shell = useRef<HTMLElement>(null); const commandBar = useRef<HTMLDivElement>(null);
  const readOnly = storageStatus.readOnly || snapshot.holds.storage;
  const latestReadOnly = useRef<() => boolean>(() => false); latestReadOnly.current = () => (storage?.getSnapshot().readOnly ?? false) || session.getSnapshot().holds.storage;
  const reviews = useMemo(() => createManagementReviewV10(session, () => latestReadOnly.current()), [session]);
  const review = useSyncExternalStore(reviews.subscribe, reviews.getSnapshot, reviews.getSnapshot);
  const overlay = useRef<ReturnType<typeof createManagementHoldsV10> | null>(null);
  const selectionHandler = useRef<(selection: SessionSelectionV10) => void>(() => {}); const pointHandler = useRef<(cell: { x: number; y: number }) => void>(() => {});
  const source = useMemo(() => createManagementRendererV10(session, selection => selectionHandler.current(selection), cell => pointHandler.current(cell)), [session]);
  const t = useMemo(() => createManagementTranslatorV10(locale), [locale]);
  const context: UiContext = { session, snapshot, readOnly, getReadOnly: () => latestReadOnly.current(), t, feedback: setNotice, reviews };
  const blocked = managementBlockedV10(snapshot, readOnly);
  useEffect(() => { reviews.start(); const scope = createManagementHoldsV10(session); overlay.current = scope; return () => { reviews.stop(); if (overlay.current === scope) overlay.current = null; scope.dispose(); }; }, [reviews, session]);
  useEffect(() => {
    if (review && readOnly) reviews.cancel();
  }, [review, readOnly, reviews]);
  useEffect(() => { setPlacement({ definitionId: 'library.v9', anchor: { x: 2, y: 2 }, rotation: 0 }); setNotice(null); }, [session, snapshot.sessionEpoch]);
  useEffect(() => {
    const root = shell.current, bar = commandBar.current; if (!root || !bar) return;
    const measure = () => root.style.setProperty('--management-v9-toolbar-height', `${Math.ceil(bar.getBoundingClientRect().height)}px`);
    measure(); const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure); observer?.observe(bar); window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  useEffect(() => {
    let disposed = false, frame = 0;
    const visibility = () => session.setForeground({ visible: document.visibilityState !== 'hidden' });
    const focus = () => session.setForeground({ focused: true }); const blur = () => session.setForeground({ focused: false });
    const tick = (timestamp: number) => { if (disposed) return; session.frame(timestamp); frame = requestAnimationFrame(tick); };
    session.setForeground({ visible: document.visibilityState !== 'hidden', focused: document.hasFocus() });
    document.addEventListener('visibilitychange', visibility); window.addEventListener('focus', focus); window.addEventListener('blur', blur); frame = requestAnimationFrame(tick);
    return () => { disposed = true; cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', focus); window.removeEventListener('blur', blur); session.resetFrameBaseline(); };
  }, [session]);
  useEffect(() => {
    const value = review?.kind === 'proposal' && review.proposal.kind === 'placement' ? review.proposal.view : null;
    source.setPlacementPreview(value ? { anchor: value.request.anchor, footprint: value.footprint, allowed: value.allowed } : null);
    return () => source.setPlacementPreview(null);
  }, [source, review]);
  const choose = (selection: SessionSelectionV10) => {
    const current = session.getSnapshot();
    if (!managementBoundaryV10(snapshot, current) || current.closed || current.holds.storageBusy || current.holds.overlay) { setNotice({ key: 'managementV9.stale' }); return; }
    reviews.cancel(); const result = session.select(selection); if (!result.ok) setNotice(managementResultV10(result));
  };
  selectionHandler.current = choose;
  const prepare = (next: SectPlacementRequest, opener?: HTMLElement) => { const result = reviews.prepare(snapshot, () => session.preparePlacement(next), { key: 'managementV9.placement' }, false, opener ? { opener } : null); if (result) setNotice(result); };
  const changePlacement = (next: SectPlacementRequest) => { setPlacement(next); if (review?.kind === 'proposal' && review.proposal.kind === 'placement') prepare(next); };
  pointHandler.current = cell => { if (review?.kind === 'proposal' && review.proposal.kind === 'placement') changePlacement({ ...placement, anchor: cell }); };
  const pausedByUser = snapshot.frame.clock.pauseReasons.some(reason => reason === 'hidden' || reason === 'player') || snapshot.holds.hidden || snapshot.holds.player;
  const controlsDisabled = readOnly || storageStatus.busy || snapshot.holds.storageBusy || snapshot.holds.review || snapshot.holds.overlay || snapshot.holds.staging || snapshot.closed || !!snapshot.stopped || !!snapshot.runtimeFailure;
  const navigation: readonly [string, TextKey | ManagementLocalKeyV10][] = [['overview', 'managementV9.overview'], ['roster', 'managementV9.people'], ['cultivation', 'cultivation.ui.title'], ['build', 'managementV9.buildTitle'], ['production', 'managementV9.production'], ['jobs', 'managementV9.jobs'], ['research', 'managementV9.research'], ['upgrade', 'managementV10.upgrade'], ['care', 'managementV9.care'], ['maintenance', 'managementV9.maintenance']];
  return <main className="management-v9 management-v10" lang={locale} ref={shell}>
    <header className="management-v9-header"><div><p className="management-v9-eyebrow">{t('managementV10.candidate')}</p><h1>{t('app.title')}</h1></div><div className="management-v9-header-controls"><label>{t('settings.language.label')}<select value={locale} onChange={event => { const next = event.currentTarget.value === 'en' ? 'en' : 'zh-CN'; setLocale(next); writeLocalePreference(next); }}><option value="zh-CN">{t('settings.language.zh-CN')}</option><option value="en">{t('settings.language.en')}</option></select></label></div></header>
    <p className="management-v9-scope">{t('managementV10.scope')}</p><div className="management-v9-save-summary"><span>{t(storageStatus.summary.key, storageStatus.summary.parameters)}</span>{!storage && <span>{t('managementV10.storageUnavailable')}</span>}</div>
    <div className="management-v9-command-bar" ref={commandBar} role="region" aria-label={t('managementV9.controls')}><div className="management-v9-command-row">
      <button className="secondary" disabled={controlsDisabled} aria-pressed={pausedByUser} onClick={() => {
        if (pausedByUser) setNotice(managementResultV10(resumeManagementV10(session, snapshot, latestReadOnly.current())));
        else { const current = session.getSnapshot(); if (!managementBoundaryV10(snapshot, current) || latestReadOnly.current() || current.holds.storageBusy || current.holds.review || current.holds.overlay) { setNotice({ key: 'managementV9.stale' }); return; } setNotice(managementResultV10(session.setPaused('player', true))); }
      }}>{t(pausedByUser ? 'managementV10.resumeExplicit' : 'managementV9.pause')}</button>
      {snapshot.frame.clock.speed !== 1 && <button disabled={controlsDisabled} onClick={() => { if (!managementBoundaryV10(snapshot, session.getSnapshot()) || latestReadOnly.current()) { setNotice({ key: 'managementV9.stale' }); return; } setNotice(managementResultV10(session.setSpeed(1))); }}>{t('managementV9.setNormalSpeed')}</button>}
      <button className="secondary" disabled={storageStatus.busy || snapshot.holds.storageBusy || snapshot.holds.review || !!review || snapshot.closed} onClick={() => { const current = session.getSnapshot(); if (!managementBoundaryV10(snapshot, current) || current.holds.storageBusy || current.holds.review || current.closed) { setNotice({ key: 'managementV9.stale' }); return; } const result = overlay.current?.set('overlay', true); if (!result) return; if (!result.ok) setNotice(managementResultV10(result)); else setSaveOpen(true); }}>{t('save.open')}</button><span className="management-v9-run-state">{t(snapshot.paused ? 'managementV9.clockPaused' : 'managementV9.clockRunning')}</span>
    </div><p className="management-v9-feedback" role="status" aria-live="polite" aria-atomic="true">{notice ? t(notice.key, notice.parameters) : t('managementV9.feedbackReady')}</p></div>
    {snapshot.frame.clock.pauseReasons.includes('hidden') && <p className="management-v9-notice">{t('managementV10.hiddenPause')}</p>}
    <nav className="management-v9-section-nav" aria-label={t('managementV9.navigation')}>{navigation.map(([id, key]) => <a key={id} href={`#management-v10-${id}`}>{t(key)}</a>)}</nav>
    <div className="management-v9-clock"><span>{t('live.calendar', { year: snapshot.frame.calendar.year, month: snapshot.frame.calendar.month })}</span><span>{t('live.tick', { tick: snapshot.frame.clock.simulationTick })}</span><span>{t('managementV9.speed', { speed: snapshot.frame.clock.speed })}</span></div>
    {(snapshot.stopped || snapshot.runtimeFailure) && <p role="alert" className="management-v9-notice">{t('managementV9.stopped')}</p>}
    <ReviewPanelV10 context={context} review={review} locale={locale} />
    <section id="management-v10-overview" className="management-v9-resources management-v9-anchor" tabIndex={-1} aria-label={t('live.resources')}>{snapshot.frame.resources.map(row => <article key={row.resourceId}><h2>{t(`resource.${row.resourceId}`)}</h2><strong>{row.owned}</strong><p>{t('live.available', { available: row.available, reserved: row.reserved })}</p><p>{t('live.capacity', { capacity: row.capacity })}</p></article>)}{snapshot.expansion.stock.map(row => <article key={row.resourceId}><h2>{content(SECT_V9_CANDIDATE.resources.find(resource => resource.resourceId === row.resourceId)!.nameKey, t)}</h2><strong>{row.owned}</strong><p>{t('live.available', { available: row.available, reserved: row.reserved })}</p><p>{t('live.capacity', { capacity: row.capacity })}</p></article>)}</section>
    <div className="management-v9-map-layout"><section className="management-v9-world" aria-label={t('live.worldLabel')}><PhaserWorld source={source} locale={locale} /></section><section className="management-v9-panel"><h2>{t('managementV9.placement')}</h2><p>{t('managementV9.placementHint')}</p>
      <label className="management-v9-field">{t('managementV9.buildingType')}<select disabled={storageStatus.busy || readOnly || !!review && !(review.kind === 'proposal' && review.proposal.kind === 'placement')} value={placement.definitionId} onChange={event => changePlacement({ ...placement, definitionId: event.currentTarget.value === 'alchemy.v9' ? 'alchemy.v9' : 'library.v9' })}><option value="library.v9">{t('sectV9.building.library')}</option><option value="alchemy.v9">{t('sectV9.building.alchemy')}</option></select></label>
      <div className="management-v9-coordinates">{(['x', 'y'] as const).map(axis => <label key={axis}>{t(axis === 'x' ? 'managementV9.coordinateX' : 'managementV9.coordinateY')}<input type="number" min="0" max={(axis === 'x' ? snapshot.frame.map.width : snapshot.frame.map.height) - 1} step="1" value={placement.anchor[axis]} disabled={storageStatus.busy || readOnly} onChange={event => { const value = Number(event.currentTarget.value); if (Number.isSafeInteger(value)) changePlacement({ ...placement, anchor: { ...placement.anchor, [axis]: value } }); }} /></label>)}</div>
      <label className="management-v9-field">{t('managementV9.rotation')}<select value={placement.rotation} disabled={storageStatus.busy || readOnly} onChange={event => { const value = Number(event.currentTarget.value); if ([0, 90, 180, 270].includes(value)) changePlacement({ ...placement, rotation: value as SectRotation }); }}>{([0, 90, 180, 270] as const).map(rotation => <option key={rotation} value={rotation}>{t('managementV9.degrees', { rotation })}</option>)}</select></label><p>{t('managementV9.placementAdvisory')}</p><button disabled={!!blocked} onClick={event => prepare(placement, event.currentTarget)}>{t('managementV9.preview')}</button>
    </section></div>
    <section id="management-v10-roster" className="management-v9-panel management-v9-anchor" tabIndex={-1}><h2>{t('managementV9.selection')}</h2><div className="management-v9-selection-list">{snapshot.frame.disciples.map(actor => <button className="secondary" key={actor.id} disabled={storageStatus.busy || snapshot.holds.overlay} aria-pressed={snapshot.selection?.kind === 'disciple' && snapshot.selection.id === actor.id} onClick={() => choose({ kind: 'disciple', id: actor.id })}>{content(actor.nameKey, t)} · {t('live.position', actor.position)}</button>)}{snapshot.frame.buildings.map(building => <button className="secondary" key={building.id} disabled={storageStatus.busy || snapshot.holds.overlay} aria-pressed={snapshot.selection?.kind === 'building' && snapshot.selection.id === building.id} onClick={() => choose({ kind: 'building', id: building.id })}>{content(building.nameKey, t)}</button>)}{snapshot.expansion.blueprints.map(blueprint => <button className="secondary" key={blueprint.blueprintId} disabled={storageStatus.busy || snapshot.holds.overlay} aria-pressed={snapshot.selection?.kind === 'blueprint' && snapshot.selection.id === blueprint.blueprintId} onClick={() => choose({ kind: 'blueprint', id: blueprint.blueprintId })}>{t('managementV9.blueprintLabel', { name: t(blueprint.definitionId === 'library.v9' ? 'sectV9.building.library' : 'sectV9.building.alchemy') })}</button>)}{snapshot.expansion.buildings.map(building => <button className="secondary" key={building.buildingId} disabled={storageStatus.busy || snapshot.holds.overlay} aria-pressed={snapshot.selection?.kind === 'sect-building' && snapshot.selection.id === building.buildingId} onClick={() => choose({ kind: 'sect-building', id: building.buildingId })}>{t(building.definitionId === 'library.v9' ? 'sectV9.building.library' : 'sectV9.building.alchemy')} · {t('managementV9.level', { level: building.level })}</button>)}</div></section>
    <div className="management-v9-panels"><CultivationPanelV10 key={`cultivation:${snapshot.sessionEpoch}:${snapshot.selection?.kind}:${snapshot.selection?.id}`} context={context} /><BuildPanelV10 key={`build:${snapshot.sessionEpoch}:${snapshot.selection?.kind}:${snapshot.selection?.id}`} context={context} locale={locale} /></div>
    <ManagementSectPanelsV10 context={context} />
    {saveOpen && <StorageDialogV10 session={session} {...(storage ? { storage } : {})} locale={locale} t={t} onClose={() => { if (session.getSnapshot().holds.storageBusy || storage?.getSnapshot().busy) return; setSaveOpen(false); overlay.current?.set('overlay', false); }} />}
  </main>;
}
