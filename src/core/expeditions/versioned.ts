import { contentIdentity, LEGACY_V7_CONTENT, resolveContentIdentity } from '../../content/registry';
import type { GameContentIdentity } from '../../content/registry';
import { canonicalStringify } from '../kernel/serialization';
import { createExpedition as createLegacy, applyExpeditionCommand as applyLegacy, getNextTimeCheckpoint as legacyCheckpoint } from './legacy-v2/expedition';
import { restoreExpedition as restoreLegacy, serializeExpedition as serializeLegacy } from './legacy-v2/snapshot';
import { createExpedition as createRelease, applyExpeditionCommand as applyRelease, getNextTimeCheckpoint as releaseCheckpoint } from './v3/expedition';
import { restoreReleaseExpedition, serializeReleaseExpedition } from './v3/snapshot';
import { RELEASE_ELIGIBILITY_RULES_ID, evaluateReleaseEligibility } from './release-eligibility';
import { releaseAnalysisView, releaseContextForRun } from './v3/context';
import type { ReleaseExpeditionContext, ExpeditionState as ReleaseExpeditionState } from './v3/types';
import type { CreateExpeditionOptions, ExpeditionState, ExpeditionCommand, ExpeditionError, ExpeditionReceipt, ExpeditionAdapterEffect, Immutable } from './types';
import { assertPlainJson, copy, freeze } from './shared';

export type RegisteredExpedition =
  | { readonly schemaVersion: 1; readonly identity: Readonly<GameContentIdentity>; readonly routeId: string; readonly protocol: 'legacy-v2'; readonly run: ExpeditionState }
  | { readonly schemaVersion: 1; readonly identity: Readonly<GameContentIdentity>; readonly routeId: string; readonly protocol: 'release-v3'; readonly run: ReleaseExpeditionState };
export type RegisteredExpeditionTransition =
  | { ok: true; expedition: RegisteredExpedition; receipt: Immutable<ExpeditionReceipt>; effects: Immutable<ExpeditionAdapterEffect[]>; replayed: boolean }
  | { ok: false; expedition: RegisteredExpedition; code: ExpeditionError };
const same = (left: unknown, right: unknown) => canonicalStringify(left) === canonicalStringify(right);
export function resolveReleaseExpeditionContext(identity: unknown): ReleaseExpeditionContext {
  const selected = resolveContentIdentity(identity, { allowCandidate: true });
  if (!selected || selected.id === LEGACY_V7_CONTENT.id || selected.protocols.expedition !== 'expedition-3'
    || selected.protocols.admission !== RELEASE_ELIGIBILITY_RULES_ID) throw new TypeError('Unsupported registered expedition protocol');
  return Object.freeze({ identity: contentIdentity(selected), catalog: selected.combat, encounters: selected.encounters,
    expeditionProtocol: 'expedition-3', admissionProtocol: RELEASE_ELIGIBILITY_RULES_ID });
}
function routeMatches(routeId: string, run: ExpeditionState | ReleaseExpeditionState, identity: Readonly<GameContentIdentity>): boolean {
  const content = resolveContentIdentity(identity, { allowCandidate: true }); const route = content?.routes.find(entry => entry.id === routeId);
  if (!route) return false;
  const expected = copy(route.specification); expected.regularEncounterIds.sort();
  const actual = copy(run.origin.route); actual.regularEncounterIds.sort(); return same(actual, expected);
}
/** Existing source is fully replayed under the frozen algorithm. Nothing inside the run is relabeled. */
export function pinLegacyExpedition(run: ExpeditionState): Extract<RegisteredExpedition, { protocol: 'legacy-v2' }> {
  const restored = restoreLegacy(serializeLegacy(run), LEGACY_V7_CONTENT.combat);
  if (!routeMatches('route.qingfeng-trial', restored, contentIdentity(LEGACY_V7_CONTENT))) throw new TypeError('Unknown legacy World route');
  return freeze({ schemaVersion: 1, identity: contentIdentity(LEGACY_V7_CONTENT), routeId: 'route.qingfeng-trial', protocol: 'legacy-v2', run: restored });
}
export function createRegisteredExpedition(options: CreateExpeditionOptions, routeId: string, identity: unknown): RegisteredExpedition {
  const context = resolveReleaseExpeditionContext(identity);
  const run = createRelease(options, context);
  if (!routeMatches(routeId, run, context.identity)) throw new TypeError('Run route does not match registered route');
  return freeze({ schemaVersion: 1, identity: context.identity, routeId, protocol: 'release-v3', run });
}
export function restoreRegisteredExpedition(value: unknown): RegisteredExpedition {
  assertPlainJson(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'identity,protocol,routeId,run,schemaVersion') throw new TypeError('Invalid registered expedition');
  const candidate = value as RegisteredExpedition;
  if (candidate.schemaVersion !== 1 || !resolveContentIdentity(candidate.identity, { allowCandidate: true })
    || !routeMatches(candidate.routeId, candidate.run, candidate.identity)) throw new TypeError('Invalid run content identity');
  if (candidate.protocol === 'legacy-v2') {
    if (!same(candidate.identity, contentIdentity(LEGACY_V7_CONTENT))) throw new TypeError('Legacy run cannot adopt current catalog');
    return freeze({ ...candidate, identity: copy(candidate.identity), run: restoreLegacy(serializeLegacy(candidate.run), LEGACY_V7_CONTENT.combat) });
  }
  if (candidate.protocol !== 'release-v3') throw new TypeError('Unknown run protocol');
  const context = resolveReleaseExpeditionContext(candidate.identity);
  return freeze({ ...candidate, identity: copy(candidate.identity), run: restoreReleaseExpedition(serializeReleaseExpedition(candidate.run), context) });
}
/** Mutations resolve the saved identity on every call. Exact receipts keep their original result. */
export function applyRegisteredExpeditionCommand(expedition: RegisteredExpedition, command: ExpeditionCommand): RegisteredExpeditionTransition {
  try {
    // Domain command paths are bounded and pure; restore/import handles full history replay.
    if (!routeMatches(expedition.routeId, expedition.run, expedition.identity)) throw new TypeError('Invalid route identity');
    const result = expedition.protocol === 'legacy-v2'
      ? same(expedition.identity, contentIdentity(LEGACY_V7_CONTENT)) ? applyLegacy(expedition.run, command, LEGACY_V7_CONTENT.combat) : null
      : applyRelease(expedition.run, command, resolveReleaseExpeditionContext(expedition.identity));
    if (!result) return { ok: false, expedition, code: 'CONTENT_MISMATCH' };
    if (!result.ok) return { ok: false, expedition, code: result.code };
    const next = freeze({ ...expedition, identity: copy(expedition.identity), run: result.state }) as RegisteredExpedition;
    return { ok: true, expedition: result.replayed ? expedition : next, receipt: result.receipt, effects: result.effects, replayed: result.replayed };
  } catch { return { ok: false, expedition, code: 'CONTENT_MISMATCH' }; }
}
export function registeredTimeCheckpoint(expedition: RegisteredExpedition) {
  return expedition.protocol === 'legacy-v2' ? legacyCheckpoint(expedition.run) : releaseCheckpoint(expedition.run);
}
export function registeredEligibility(expedition: RegisteredExpedition) {
  if (expedition.protocol !== 'release-v3') return null;
  const context = resolveReleaseExpeditionContext(expedition.identity);
  return evaluateReleaseEligibility(releaseAnalysisView(expedition.run), context.catalog, releaseContextForRun(expedition.run, context));
}
