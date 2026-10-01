/** Versioned data registry only. World selection/migration is deliberately not wired yet. */
import legacyData from './legacy-v7.json';
import { prepareCombatCatalog, catalogFingerprint } from '../../core/combat/runtime/catalog';
import type { CombatContentCatalog, School } from '../../core/combat/definitions/types';
import type { EquipmentDefinition, SkillLearningRule } from '../../core/builds/types';
import type { BattleEntityInput } from '../../core/combat/runtime/types';
import type { ExpeditionEncounterDefinition } from '../../core/expeditions/encounter-catalog';
import type { Immutable, RouteSpecification } from '../../core/expeditions/types';
import type { CampaignKnowledgeDefinition, CampaignRecruitDefinition, CampaignRouteDefinition } from '../../core/campaign/types';
import type { ResourceLine } from '../../core/economy/types';
import { cloneJson, stableHash } from '../../core/kernel/serialization';
import { validateCombatStructure } from '../schemas/combat';
import { releaseCombatCatalog } from '../release';
import { CAMPAIGN_ENCOUNTERS, CAMPAIGN_EQUIPMENT, CAMPAIGN_KNOWLEDGE, CAMPAIGN_RECRUITS, CAMPAIGN_ROUTES, RECRUIT_COSTS, RECOVERY_RESOURCES } from '../../core/campaign/catalog';
import { MAX_CAMPAIGN_CLAIMS } from '../../core/campaign/shared';

function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value as Immutable<T>;
}
export interface ContentBuildRules {
  version: number;
  schools: readonly School[];
  equipmentSlots: readonly string[];
  equipment: readonly EquipmentDefinition[];
  lessons: readonly SkillLearningRule[];
  starterSkills: Readonly<Record<School, readonly string[]>>;
  milestones: readonly string[];
  maximumAllocatedPoints: number; maximumCommands: number; maximumDisciples: number; maximumEquipment: number;
  basics: readonly { id: string; definition: NonNullable<BattleEntityInput['basic']> }[];
}
export interface ContentOfferRules {
  protocol: string; authoredTalentIds: readonly string[]; fallbackSupplies: readonly ResourceLine[];
  maximumCommands: number; maximumEncounters: number; maximumSquad: number; maximumMonthsPerNode: number;
}
export interface ContentCampaignRules {
  protocol: string; routes: readonly Immutable<CampaignRouteDefinition>[];
  knowledge: readonly Immutable<CampaignKnowledgeDefinition>[]; recruits: readonly CampaignRecruitDefinition[];
  recruitCosts: readonly ResourceLine[]; recoveryResources: readonly ResourceLine[]; maximumClaims: number;
  defaultMode: 'standard'; ordinaryInvitations: 'first-clear-once';
  reliefPolicy: { protocol: string; mode: 'standard'; requiredLivingCount: number; requireExhaustedUnlockedInvitations: boolean;
    costs: readonly ResourceLine[]; cooldownMonths: number; countPendingDeathAsLiving: boolean };
}
export interface GameContentBundle {
  id: string; status: 'frozen' | 'candidate'; worldContentVersion: string;
  combat: CombatContentCatalog; encounters: readonly ExpeditionEncounterDefinition[];
  routes: readonly { id: string; specification: RouteSpecification }[];
  buildRules: ContentBuildRules; offerRules: ContentOfferRules; campaign: ContentCampaignRules | null;
  protocols: Readonly<Record<'combatRuntime' | 'combatSnapshot' | 'controller' | 'builds' | 'expedition' | 'admission', string | number>>;
  blockers: readonly string[];
}
export interface GameContentIdentity {
  registryId: string; compositeFingerprint: string; combatFingerprint: string; buildRulesVersion: number;
}
/** Locale templates, build timestamps and capture provenance are not simulation inputs. */
export function contentFingerprint(bundle: Immutable<GameContentBundle>): string {
  return stableHash({ worldContentVersion: bundle.worldContentVersion, combat: bundle.combat,
    encounters: bundle.encounters, routes: bundle.routes, buildRules: bundle.buildRules,
    offerRules: bundle.offerRules, campaign: bundle.campaign, protocols: bundle.protocols });
}
export function contentIdentity(bundle: Immutable<GameContentBundle>): Readonly<GameContentIdentity> {
  return Object.freeze({ registryId: bundle.id, compositeFingerprint: contentFingerprint(bundle),
    combatFingerprint: catalogFingerprint(bundle.combat), buildRulesVersion: bundle.buildRules.version });
}
const checkedLegacy = validateCombatStructure(legacyData.combat);
if (!checkedLegacy.valid || !checkedLegacy.value) throw new TypeError('Frozen v7 combat structure is invalid');
const frozenCombat = prepareCombatCatalog(checkedLegacy.value);
if (catalogFingerprint(frozenCombat) !== legacyData.combatFingerprint) throw new TypeError('Frozen v7 combat fingerprint mismatch');
/** Static snapshot, not a re-export of mutable future starter definitions or rules. */
export const LEGACY_V7_CONTENT = freeze<GameContentBundle>({
  id: legacyData.id, status: 'frozen', worldContentVersion: legacyData.worldContentVersion,
  combat: frozenCombat, encounters: cloneJson(legacyData.encounters) as ExpeditionEncounterDefinition[],
  routes: cloneJson(legacyData.routes) as { id: string; specification: RouteSpecification }[],
  buildRules: cloneJson(legacyData.buildRules) as ContentBuildRules,
  offerRules: cloneJson(legacyData.offerRules) as ContentOfferRules,
  protocols: cloneJson(legacyData.protocols), campaign: null, blockers: [],
});
export const LEGACY_V7_PROVENANCE = freeze({ sourceCommit: legacyData.sourceCommit, sourceHashes: legacyData.sourceHashes });

/** An explicit candidate, not a shipped registry alias. Missing protocols remain blockers. */
export const RELEASE_V8_CANDIDATE = freeze<GameContentBundle>({
  id: 'content.release-v8.candidate-2', status: 'candidate', worldContentVersion: 'shanmen-five-routes-0.8.0-candidate.2',
  combat: releaseCombatCatalog,
  encounters: [...cloneJson(LEGACY_V7_CONTENT.encounters), ...cloneJson(CAMPAIGN_ENCOUNTERS)] as ExpeditionEncounterDefinition[],
  routes: CAMPAIGN_ROUTES.map(route => ({ id: route.id, specification: cloneJson(route.specification) as RouteSpecification })),
  buildRules: { ...cloneJson(LEGACY_V7_CONTENT.buildRules), version: 2,
    equipment: [...cloneJson(LEGACY_V7_CONTENT.buildRules.equipment), ...cloneJson(CAMPAIGN_EQUIPMENT)] },
  offerRules: { ...cloneJson(LEGACY_V7_CONTENT.offerRules), protocol: 'release-capabilities-v1-pending', authoredTalentIds: releaseCombatCatalog.talents.map(talent => talent.id) },
  campaign: { protocol: 'campaign-v2-candidate', routes: cloneJson(CAMPAIGN_ROUTES), knowledge: cloneJson(CAMPAIGN_KNOWLEDGE),
    recruits: cloneJson(CAMPAIGN_RECRUITS), recruitCosts: cloneJson(RECRUIT_COSTS), recoveryResources: cloneJson(RECOVERY_RESOURCES),
    maximumClaims: MAX_CAMPAIGN_CLAIMS, defaultMode: 'standard', ordinaryInvitations: 'first-clear-once', reliefPolicy: { protocol: 'standard-relief-v1', mode: 'standard', requiredLivingCount: 1,
      requireExhaustedUnlockedInvitations: true, costs: [{ resourceId: 'meal', quantity: 8 }], cooldownMonths: 12, countPendingDeathAsLiving: true } },
  protocols: { ...LEGACY_V7_CONTENT.protocols, builds: 'build-rules-v2-pending', expedition: 'expedition-v2-pending', admission: 'release-capabilities-v1-pending' },
  blockers: ['legacy-build-history-migration', 'old-active-run-protocol-selection', 'extra-target-stagger',
    'release-recipient-admission', 'standard-relief-world-integration', 'campaign-world-bridge'],
});
const bundles: readonly Immutable<GameContentBundle>[] = Object.freeze([LEGACY_V7_CONTENT, RELEASE_V8_CANDIDATE]);
/** Never resolve user-supplied catalog data or silently upgrade an unknown identity. */
export function resolveContentIdentity(input: unknown, options: { allowCandidate?: boolean } = {}): Immutable<GameContentBundle> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return null;
  const fields = ['registryId', 'compositeFingerprint', 'combatFingerprint', 'buildRulesVersion'] as const;
  if (Reflect.ownKeys(input).length !== fields.length) return null;
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, field);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    values[field] = descriptor.value;
  }
  if (typeof values.registryId !== 'string' || typeof values.compositeFingerprint !== 'string'
    || typeof values.combatFingerprint !== 'string' || !Number.isSafeInteger(values.buildRulesVersion)) return null;
  const identity = values;
  const bundle = bundles.find(entry => entry.id === identity.registryId);
  if (!bundle || (bundle.status === 'candidate' && !options.allowCandidate)) return null;
  const expected = contentIdentity(bundle);
  return expected.compositeFingerprint === identity.compositeFingerprint && expected.combatFingerprint === identity.combatFingerprint
    && expected.buildRulesVersion === identity.buildRulesVersion ? bundle : null;
}
