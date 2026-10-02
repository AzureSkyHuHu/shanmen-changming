import { managementV9BuildContext } from '../content/sect-v9/world-content';
import { isBuildCommand } from '../core/builds/builds';
import type { BuildLoadout, EquipmentSlot } from '../core/builds/types';
import type { BuildContentContext } from '../core/builds/v2-types';
import { combatDefinitionSupport } from '../core/combat/runtime/engine';
import { compareStable } from '../core/kernel/serialization';
import { captureSaveDataV9 } from '../core/world/save-admission-v9';
import type { RuntimeReadonlyV9 } from '../core/world/runtime-view-types-v9';
import type { TextKey } from '../i18n';
import { managementReasonV9, type ManagementSnapshotV9, type ManagementTextV9 } from './management-v9-contract';
import type { ApplicationSessionV9, BuildRequestV9, SessionCommandResultV9 } from './session-v9';

/** Fixed DTOs plus the existing player command and explicit player-pause ports. */
export type ManagementBuildSessionV9 = Pick<ApplicationSessionV9, 'getSnapshot' | 'dispatchBuild' | 'setPaused'>;
export const MANAGEMENT_BUILD_SLOTS_V9 = ['weapon', 'robe', 'artifact'] as const;
export type ManagementBuildSelectedV9 = NonNullable<ManagementSnapshotV9['build']['selected']>;

export function managementBuildContentV9(snapshot: ManagementSnapshotV9): BuildContentContext | null {
  try { return managementV9BuildContext(snapshot.build.contentIdentity); } catch { return null; }
}

/** Build-only policy: a real player pause permits editing in the existing domain.
 * Temporary player holds and every non-player/domain pause remain blocking. */
export function managementBuildBlockedV9(snapshot: ManagementSnapshotV9, readOnly: boolean): TextKey | null {
  if (snapshot.closed || snapshot.stopped || snapshot.runtimeFailure) return 'managementV9.stopped';
  if (readOnly || snapshot.holds.storage) return 'managementV9.readOnly';
  if (snapshot.holds.storageBusy) return 'managementV9.busy';
  if (snapshot.holds.overlay || snapshot.holds.review) return 'managementV9.reviewHeld';
  if (snapshot.holds.player || snapshot.holds.hidden || snapshot.frame.clock.mode !== 'management'
    || snapshot.frame.clock.pauseReasons.some(reason => reason !== 'player')) return 'managementV9.pausedHint';
  if (!managementBuildContentV9(snapshot)) return 'buildView.unknownDefinition';
  const selected = snapshot.build.selected;
  if (!selected || snapshot.selection?.kind !== 'disciple' || snapshot.selection.id !== selected.discipleId) return 'buildView.selectDisciple';
  if (selected.lifeState !== 'alive') return 'buildView.readOnly';
  if (selected.locked) return 'managementV9.buildOccupied' as TextKey;
  return null;
}

/** Session revision also catches selection-away-and-back and holds released again.
 * A draft is never silently rebased onto a newer world, even if the build is equal. */
export function managementBuildIntentGuardV9(expected: ManagementSnapshotV9, current: ManagementSnapshotV9, readOnly: boolean): TextKey | null {
  const blocked = managementBuildBlockedV9(current, readOnly); if (blocked) return blocked;
  return expected.sessionEpoch !== current.sessionEpoch || expected.revision !== current.revision
    || expected.worldRevision !== current.worldRevision || expected.build.revision !== current.build.revision
    || expected.stamp.generation !== current.stamp.generation || expected.stamp.publication !== current.stamp.publication
    || expected.cultivation.resourceStamp !== current.cultivation.resourceStamp
    || expected.selection?.kind !== current.selection?.kind || expected.selection?.id !== current.selection?.id
    || expected.build.selected?.discipleId !== current.build.selected?.discipleId ? 'managementV9.stale' : null;
}

export function managementBuildEquipmentV9(selected: ManagementBuildSelectedV9, context: BuildContentContext, slot: EquipmentSlot) {
  return selected.equipment.filter(item => {
    const definition = context.rules.equipment.find(row => row.id === item.definitionId);
    return definition?.slot === slot && (definition.school === null || definition.school === selected.school);
  });
}
export function managementBuildSkillRequirementsV9(selected: ManagementBuildSelectedV9, context: BuildContentContext,
  skillId: string, nodeIds: readonly string[] = selected.allocatedNodeIds): boolean {
  const rule = context.rules.lessons.find(row => row.skillId === skillId);
  return !!rule && rule.requiredSkillIds.every(id => selected.learnedSkillIds.includes(id)) && rule.requiredNodeIds.every(id => nodeIds.includes(id));
}
/** The catalog capability check is presentation advice, never an acceptance receipt. */
export function managementBuildSupportedV9(context: BuildContentContext, id: string): boolean {
  return combatDefinitionSupport(context.catalog, id, 'experimental').supported;
}
export function managementBuildLearnErrorV9(selected: ManagementBuildSelectedV9, context: BuildContentContext, id: string): TextKey | null {
  const skill = context.catalog.skills.find(row => row.id === id); const rule = context.rules.lessons.find(row => row.skillId === id);
  if (!skill || !rule || skill.school !== selected.school) return 'buildView.unknownDefinition';
  if (selected.learnedSkillIds.includes(id)) return 'buildView.learned';
  if (!managementBuildSupportedV9(context, id)) return 'buildView.unavailable';
  if (!managementBuildSkillRequirementsV9(selected, context, id)) return 'buildView.missingPrerequisite';
  return selected.progress.availableLearningCredits < rule.creditCost ? 'buildView.insufficientCredits' : null;
}

export function managementBuildTreeErrorV9(selected: ManagementBuildSelectedV9, context: BuildContentContext, ids: readonly string[]): TextKey | null {
  if (new Set(ids).size !== ids.length) return 'buildView.rejected';
  if (ids.length > context.rules.maximumAllocatedPoints) return 'buildView.pointLimit';
  if (ids.length > selected.progress.earnedPoints) return 'buildView.insufficientPoints';
  for (const id of ids) {
    const node = context.catalog.treeNodes.find(row => row.id === id);
    if (!node || node.school !== selected.school || node.treeId !== selected.treeId || node.excludes.some(excluded => ids.includes(excluded))) return 'buildView.rejected';
    if (node.prerequisites.some(required => !ids.includes(required))) return 'buildView.missingPrerequisite';
    if (!managementBuildSupportedV9(context, id)) return 'buildView.unavailable';
  }
  // The reducer revalidates equipped skill prerequisites during a respec as well.
  return [...selected.loadout.activeSkillIds, selected.loadout.passiveSkillId].some(id => !managementBuildSkillRequirementsV9(selected, context, id, ids))
    ? 'managementV9.buildEquippedPrerequisite' as TextKey : null;
}
export function managementBuildToggleNodeV9(selected: ManagementBuildSelectedV9, context: BuildContentContext, ids: readonly string[], id: string):
  { ok: true; nodeIds: readonly string[] } | { ok: false; reason: TextKey } {
  const removed = ids.includes(id); let next = removed ? ids.filter(value => value !== id) : [...ids, id];
  if (removed) {
    for (let remaining = next.length; remaining > 0; remaining--) {
      const kept = next.filter(value => context.catalog.treeNodes.find(row => row.id === value)?.prerequisites.every(required => next.includes(required)));
      if (kept.length === next.length) break; next = kept;
    }
  }
  const reason = managementBuildTreeErrorV9(selected, context, next);
  return reason ? { ok: false, reason } : { ok: true, nodeIds: next.sort((a, b) =>
    (context.catalog.treeNodes.find(row => row.id === a)?.tier ?? 0) - (context.catalog.treeNodes.find(row => row.id === b)?.tier ?? 0) || compareStable(a, b)) };
}
export function managementBuildLoadoutErrorV9(selected: ManagementBuildSelectedV9, context: BuildContentContext, loadout: RuntimeReadonlyV9<BuildLoadout>): TextKey | null {
  if (loadout.basicId !== selected.loadout.basicId || new Set(loadout.activeSkillIds).size !== 2) return 'managementV9.buildInvalidLoadout' as TextKey;
  for (const [id, activation] of [...loadout.activeSkillIds.map(id => [id, 'active'] as const), [loadout.passiveSkillId, 'passive'] as const]) {
    const skill = context.catalog.skills.find(row => row.id === id);
    if (!skill || skill.school !== selected.school || skill.activation !== activation || !selected.learnedSkillIds.includes(id)
      || !managementBuildSupportedV9(context, id)) return 'managementV9.buildInvalidLoadout' as TextKey;
    if (!managementBuildSkillRequirementsV9(selected, context, id)) return 'buildView.missingPrerequisite';
  }
  if (new Set(Object.values(loadout.equipment)).size !== 3) return 'managementV9.buildInvalidLoadout' as TextKey;
  for (const slot of MANAGEMENT_BUILD_SLOTS_V9) if (!managementBuildEquipmentV9(selected, context, slot).some(item => item.instanceId === loadout.equipment[`${slot}Id`])) return 'managementV9.buildItemUnavailable' as TextKey;
  return null;
}

function captureRequest(input: BuildRequestV9): BuildRequestV9 | null {
  const captured = captureSaveDataV9(input);
  if (!captured.ok || !captured.value || typeof captured.value !== 'object' || Array.isArray(captured.value) || Object.hasOwn(captured.value, 'commandId')) return null;
  const candidate = { ...captured.value, commandId: 'management-build-shape' };
  if (!isBuildCommand(candidate)) return null;
  const { commandId: _id, ...request } = candidate; return request;
}
export function managementBuildRequestErrorV9(snapshot: ManagementSnapshotV9, request: BuildRequestV9): TextKey | null {
  const captured = captureRequest(request); if (!captured) return 'buildView.rejected';
  const selected = snapshot.build.selected; const context = managementBuildContentV9(snapshot);
  if (!context) return 'buildView.unknownDefinition';
  if (!selected || captured.discipleId !== selected.discipleId) return 'buildView.selectDisciple';
  if (captured.expectedRevision !== snapshot.build.revision) return 'managementV9.stale';
  return captured.kind === 'skill.learn' ? managementBuildLearnErrorV9(selected, context, captured.skillId)
    : captured.kind === 'tree.respec' ? managementBuildTreeErrorV9(selected, context, captured.nodeIds)
      : managementBuildLoadoutErrorV9(selected, context, captured.loadout);
}

const buildReasons: Readonly<Record<string, TextKey>> = {
  REVISION_CONFLICT: 'managementV9.stale', INSUFFICIENT_POINTS: 'buildView.insufficientPoints', POINT_LIMIT: 'buildView.pointLimit',
  INSUFFICIENT_LEARNING_CREDITS: 'buildView.insufficientCredits', MISSING_PREREQUISITE: 'buildView.missingPrerequisite',
  ALREADY_LEARNED: 'buildView.learned', UNKNOWN_DEFINITION: 'buildView.unknownDefinition', CONTENT_MISMATCH: 'buildView.unknownDefinition',
  UNSUPPORTED_CONTENT: 'buildView.unavailable', INVALID_LOADOUT: 'managementV9.buildInvalidLoadout' as TextKey,
  ITEM_NOT_OWNED: 'managementV9.buildItemUnavailable' as TextKey, ITEM_ALREADY_EQUIPPED: 'managementV9.buildItemUnavailable' as TextKey,
  EXPEDITION_LOCKED: 'managementV9.buildOccupied' as TextKey, INVALID_STATE: 'managementV9.buildOccupied' as TextKey,
  COMMAND_LIMIT: 'managementV9.reason.capacity', COUNTER_EXHAUSTED: 'managementV9.reason.capacity', OVERFLOW: 'managementV9.reason.capacity',
};
export function managementBuildResultV9(result: SessionCommandResultV9): ManagementTextV9 {
  if (!result.ok) return result.kind === 'runtime-failure' ? { key: 'managementV9.stopped' } : managementReasonV9(result.code);
  if (result.result.status === 'accepted') return { key: 'managementV9.buildApplied' as TextKey };
  const rejection = result.result.rejection;
  const code = rejection && 'buildCode' in rejection && rejection.buildCode ? rejection.buildCode
    : rejection && 'detail' in rejection && rejection.detail ? rejection.detail : rejection?.code ?? 'INVALID_REQUEST';
  return buildReasons[code] ? { key: buildReasons[code] } : managementReasonV9(code);
}

export interface ManagementBuildReviewV9 { readonly request: RuntimeReadonlyV9<BuildRequestV9>; readonly basis: ManagementSnapshotV9 }
export interface ManagementBuildCommitV9 { readonly accepted: boolean; readonly feedback: ManagementTextV9; readonly result?: SessionCommandResultV9 }
/** One controller-owned, one-shot UI review. It is not a domain proposal and grants
 * no extra permission: final dispatch still uses the ordinary Session port. */
export function createManagementBuildControllerV9(session: ManagementBuildSessionV9, getReadOnly: () => boolean) {
  let pending: ManagementBuildReviewV9 | null = null; let inFlight = false; let disposed = false;
  const freeze = <T>(value: T): RuntimeReadonlyV9<T> => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value as RuntimeReadonlyV9<T>;
  };
  return {
    prepare(basis: ManagementSnapshotV9, request: BuildRequestV9): { ok: true; review: ManagementBuildReviewV9 } | { ok: false; reason: TextKey } {
      if (disposed || inFlight || pending) return { ok: false, reason: 'managementV9.stale' };
      const current = session.getSnapshot(); const blocked = managementBuildIntentGuardV9(basis, current, getReadOnly());
      const captured = captureRequest(request); const reason = blocked ?? (captured ? managementBuildRequestErrorV9(current, captured) : 'buildView.rejected');
      if (reason || !captured) return { ok: false, reason: reason ?? 'buildView.rejected' };
      pending = Object.freeze({ basis, request: freeze(captured) }); return { ok: true, review: pending };
    },
    confirm(review: ManagementBuildReviewV9): ManagementBuildCommitV9 {
      if (disposed || inFlight || pending !== review) return { accepted: false, feedback: { key: 'managementV9.stale' } };
      pending = null; // Consume before dispatch, including rejected and reentrant attempts.
      const current = session.getSnapshot(); const reason = managementBuildIntentGuardV9(review.basis, current, getReadOnly())
        ?? managementBuildRequestErrorV9(current, review.request);
      if (reason) return { accepted: false, feedback: { key: reason } };
      inFlight = true;
      try {
        const result = session.dispatchBuild(review.request);
        return { accepted: result.ok && result.result.status === 'accepted', feedback: managementBuildResultV9(result), result };
      } finally { inFlight = false; }
    },
    cancel() { pending = null; },
    dispose() { pending = null; disposed = true; },
  };
}
