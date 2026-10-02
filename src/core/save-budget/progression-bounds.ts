import { campaignKnowledge } from '../campaign/catalog';
import type { BuildReceipt, BuildSourceOperation, MilestoneAward, MilestoneRuleId } from '../builds/types';
import type { BuildAuthorityCommandV2, BuildHistoryEntryV2, EquipmentOwner, LearnedSkillV2, RetiredBuildDisciple } from '../builds/v2-types';
import { REALM_RULES } from '../cultivation/rules';
import type { BreakthroughAttempt, CultivationCommand, CultivationCommandResult, CultivationEvent, CultivationReceipt,
  DeathRecord, LearnedKnowledge, PendingDeath, Realm } from '../cultivation/types';
import type { CultivationAuthorityCommandV3, CultivationAuthorityReceiptV3, DeceasedCultivator } from '../cultivation/v3/types';
import { lookupArchivedEvent } from '../history/archive';
import type { CommandReceipt, DomainEvent } from '../kernel/contracts';
import { CALENDAR_TICKS_PER_MONTH } from '../kernel/clock';
import type { SequenceState } from '../kernel/ids';
import { RANDOM_ALGORITHM } from '../kernel/random';
import { canonicalStringify, cloneJson } from '../kernel/serialization';
import type { WorldDeceasedIdentity, WorldEstateRecord } from '../world/campaign-state';
import type { WorldStateV8 } from '../world/v8-types';
import { assessBuildHistoryObligations, type BuildHistoryObligationFacts } from './build-obligations';
import { canonicalUtf8ByteLength } from './canonical-bytes';
import { measureCanonicalRecord } from './canonical-records';

/** Structural build-2/cultivation-3 record port; no World identity or save admission. */
export type ProgressionRecordSource = Pick<WorldStateV8, 'automaticProduction' | 'builds' | 'clock' | 'cultivation' | 'disciples' | 'events' | 'expedition' | 'history' | 'legacy' | 'randomStreams' | 'sequences' | 'transactions'>;

const MAX = Number.MAX_SAFE_INTEGER;
const DIGITS = String(MAX).length;
// Allocating MAX itself cannot complete its increment. MAX-1 has the same width.
const INSTANCE = `instance:${MAX - 1}`;
const EVENT = `event:${MAX - 1}`;
const ACTION = `action:${MAX - 1}`;
const PLAYER_COMMAND = 'c'.repeat(128);
const SEQUENCES: SequenceState = { nextAction: MAX, nextEntity: MAX, nextEvent: MAX, nextInstance: MAX };

export interface ProgressionCultivationRows {
  receipts: number; events: number; pendingDeaths: number; deaths: number; archivedDisciples: number; authorityReceipts: number;
}
export interface ProgressionBudgetAmounts {
  bytes: number;
  /** Encoded World event/receipt fallback only; excluded from domainDecoded*. */
  archiveBytes: number;
  archiveRows: { commandReceipts: number; events: number };
  /** Exact decoded canonical UTF-16/node charges, including 32 nodes per World archive row. */
  archiveDecodedCharacters: number; archiveDecodedNodes: number;
  /** Future domain record growth, without a World-archive per-row surcharge. */
  domainDecodedCharacters: number; domainDecodedNodes: number;
  cultivationRows: ProgressionCultivationRows;
  /** Paired build history/receipt rows. Do not add the build-obligations result again. */
  buildRows: number;
  buildCollections: { history: number; receipts: number; retiredDisciples: number; awards: number; learnedSkills: number };
  legacyRows: { estates: number; archivedIdentities: number };
  sequenceReserve: SequenceState;
  counterReserve: { cultivationRevisions: number; calendarMonths: number; calendarTicks: number; eventsSamples: number };
}
export interface ProgressionRecordBound {
  label: string; bytes: number; decodedCharacters: number; decodedNodes: number;
  placement: 'domain-array' | 'domain-replacement' | 'world-archive';
}
export interface ProgressionReservation extends ProgressionBudgetAmounts {
  kind: 'disciple-lifecycle' | 'teaching' | 'breakthrough' | 'run-build'; id: string;
  records: ProgressionRecordBound[];
  /** Conditions to check on the COMPLETE candidate, never an intermediate reducer frame. */
  discharge: string[];
}
export interface ProgressionReservationAssessment {
  supported: boolean;
  owners: ProgressionReservation[];
  totals: ProgressionBudgetAmounts;
  unknowns: string[];
  coverage: readonly string[];
  excluded: readonly string[];
  /** Separate numeric gate: never inferred from supported (record derivation).
   * fits only compares the enumerated terminal requirements, not uncovered work. */
  numeric: { fits: boolean; diagnostics: string[]; uncovered: string[] };
}

function amounts(): ProgressionBudgetAmounts {
  return { bytes: 0, archiveBytes: 0, archiveRows: { commandReceipts: 0, events: 0 }, archiveDecodedCharacters: 0, archiveDecodedNodes: 0,
    domainDecodedCharacters: 0, domainDecodedNodes: 0,
    cultivationRows: { receipts: 0, events: 0, pendingDeaths: 0, deaths: 0, archivedDisciples: 0, authorityReceipts: 0 }, buildRows: 0,
    buildCollections: { history: 0, receipts: 0, retiredDisciples: 0, awards: 0, learnedSkills: 0 },
    legacyRows: { estates: 0, archivedIdentities: 0 }, sequenceReserve: { nextAction: 0, nextEntity: 0, nextEvent: 0, nextInstance: 0 },
    counterReserve: { cultivationRevisions: 0, calendarMonths: 0, calendarTicks: 0, eventsSamples: 0 } };
}
function add(target: ProgressionBudgetAmounts, source: ProgressionBudgetAmounts): void {
  for (const key of ['bytes', 'archiveBytes', 'archiveDecodedCharacters', 'archiveDecodedNodes', 'domainDecodedCharacters', 'domainDecodedNodes', 'buildRows'] as const) target[key] += source[key];
  for (const key of ['archiveRows', 'cultivationRows', 'buildCollections', 'legacyRows', 'sequenceReserve', 'counterReserve'] as const) {
    const targetRows = target[key] as unknown as Record<string, number>;
    for (const [field, value] of Object.entries(source[key])) targetRows[field] = (targetRows[field] ?? 0) + value;
  }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Same canonical UTF-16/value-node definitions as history/archive's decoded
 * accounting for ordinary enumerable JSON data. The record counter captures data
 * descriptors once, rejects accessors/sparse arrays, and reuses only authenticated
 * fully frozen subtrees; no full canonical document or live-value second walk. */
export function measureProgressionRecord(value: unknown): { bytes: number; decodedCharacters: number; decodedNodes: number } {
  return measureCanonicalRecord(value);
}

function reserve(owner: ProgressionReservation, label: string, fixture: unknown, current?: unknown): void {
  const maximum = measureProgressionRecord(fixture);
  const used = current === undefined ? { bytes: 0, decodedCharacters: 0, decodedNodes: 0 } : measureProgressionRecord(current);
  // A newly inserted array member can add one comma. Existing replacement keeps its comma.
  const delimiter = current === undefined ? 1 : 0;
  const bound: ProgressionRecordBound = { label, placement: current === undefined ? 'domain-array' : 'domain-replacement',
    bytes: Math.max(0, maximum.bytes - used.bytes) + delimiter,
    decodedCharacters: Math.max(0, maximum.decodedCharacters - used.decodedCharacters) + delimiter,
    decodedNodes: Math.max(0, maximum.decodedNodes - used.decodedNodes) };
  owner.records.push(bound); owner.bytes += bound.bytes;
  owner.domainDecodedCharacters += bound.decodedCharacters; owner.domainDecodedNodes += bound.decodedNodes;
}
function archive(owner: ProgressionReservation, label: string, value: DomainEvent | CommandReceipt, table: 'events' | 'commandReceipts'): void {
  const id = 'eventId' in value ? value.eventId : value.commandId;
  const decoded = measureProgressionRecord(value);
  // Cultivation events and receipts with cultivationResult use codec tag 1.
  // Fund either current tail representation or raw fallback, a fresh page's []
  // and separator (3), row separator (1), and count's entire safe-integer width.
  const bytes = Math.max(canonicalUtf8ByteLength({ [id]: value }), canonicalUtf8ByteLength([1, id, value])) + 3 + 1 + DIGITS;
  owner.records.push({ label, placement: 'world-archive', bytes, decodedCharacters: decoded.decodedCharacters, decodedNodes: decoded.decodedNodes + 32 });
  owner.bytes += bytes; owner.archiveBytes += bytes; owner.archiveRows[table] += 1;
  owner.archiveDecodedCharacters += decoded.decodedCharacters; owner.archiveDecodedNodes += decoded.decodedNodes + 32;
}
function build(owner: ProgressionReservation, label: string, command: BuildAuthorityCommandV2, resultId: string | null,
  operations: BuildSourceOperation[] = []): void {
  const history: BuildHistoryEntryV2 = { authority: true, command, sequencesBefore: { ...SEQUENCES } };
  const receipt: BuildReceipt = { commandId: command.commandId, fingerprint: canonicalStringify({ command, authority: true }), authority: true,
    revision: MAX, operations, resultId };
  reserve(owner, `${label}:build.history`, history); reserve(owner, `${label}:build.receipt+escaped-fingerprint+source-operations`, receipt);
  owner.buildRows += 1; owner.buildCollections.history += 1; owner.buildCollections.receipts += 1;
}
function cultivationReceipt(owner: ProgressionReservation, label: string, command: CultivationCommand, relatedId: string,
  outcome: CultivationCommandResult['outcome'], eventCount: number, worldReceipt: boolean): void {
  const result: CultivationCommandResult = { commandId: command.commandId, kind: command.kind, relatedId, outcome };
  const receipt: CultivationReceipt = { commandId: command.commandId, fingerprint: canonicalStringify(command), result };
  reserve(owner, `${label}:cultivation.receipt+escaped-fingerprint`, receipt); owner.cultivationRows.receipts += 1;
  owner.sequenceReserve.nextAction += 1;
  if (worldReceipt) {
    const outer: CommandReceipt = { commandId: PLAYER_COMMAND,
      fingerprint: canonicalStringify({ kind: 'cultivation.command', payload: { command } }),
      result: { commandId: PLAYER_COMMAND, status: 'accepted', transactionId: null, eventIds: Array.from({ length: eventCount }, () => EVENT), rejection: null, cultivationResult: result } };
    archive(owner, `${label}:World.receipt+escaped-nested-fingerprint`, outer, 'commandReceipts');
  }
}
function cultivationEvent(owner: ProgressionReservation, world: ProgressionRecordSource, label: string, kind: CultivationEvent['kind'], discipleId: string,
  relatedId: string, existing?: CultivationEvent, rootActionId = ACTION): void {
  const event: CultivationEvent = { eventId: EVENT, kind, month: MAX, rootActionId, discipleId, relatedId };
  if (!existing) {
    reserve(owner, `${label}:cultivation.event`, event); owner.cultivationRows.events += 1; owner.sequenceReserve.nextEvent += 1;
  }
  if (!existing || (!world.events.some(entry => entry.eventId === existing.eventId) && !lookupArchivedEvent(world.history, existing.eventId))) {
    const copy: DomainEvent = { eventId: existing?.eventId ?? EVENT, kind, tick: MAX, rootActionId: existing?.rootActionId ?? rootActionId,
      parentEventId: null, payload: { discipleId, relatedId, month: MAX } };
    archive(owner, `${label}:World.event-copy`, copy, 'events');
  }
}
function isBuildId(id: string): boolean { return /^[A-Za-z][A-Za-z0-9._:/-]{0,119}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id); }
function owner(kind: ProgressionReservation['kind'], id: string, discharge: string[]): ProgressionReservation {
  return { ...amounts(), kind, id, records: [], discharge };
}
function sortedIds(values: readonly string[]): string { return canonicalStringify([...values].sort()); }

/**
 * Pure record envelope for an already-authenticated complete World v8 boundary.
 * Facts are derived with worldBuildHistoryObligationFacts, never loaded as budget
 * authority. This does not replace World/domain validation or candidate sizing.
 * Failed derivation returns supported=false; partial totals NEVER authorize work.
 *
 * Current World is counted once by the caller. New records reserve a complete
 * maximum; replacement records debit only their current representation. New
 * source/knowledge/relic/item/heir changes must re-admit this derivation. Teaching
 * knowledge and permanent grants are also included in eventual archive summaries.
 */
function deriveProgressionEnvelope(input: { world: ProgressionRecordSource; buildFacts: BuildHistoryObligationFacts }, numericTail: boolean): ProgressionReservationAssessment {
  const result: ProgressionReservationAssessment = { supported: false, owners: [], totals: amounts(), unknowns: [],
    coverage: ['build retirement/history/receipt/source-removal and remaining item ownership chains',
      'cultivation expiry/death/archive, active teaching and accepted breakthrough terminal records',
      'World cultivation-event copies and necessary player cultivation receipts',
      'World estate item/transfer provenance and deceased identity', 'build realm awards, one run unlock, surviving first-victory awards'],
    excluded: ['run/battle peaks, run receipts/history, route clear and full Ended proof',
      'production cancellation, pending-command/journal obligations', 'whole-World 4MiB admission and arbitrary future optional commands',
      'additional time spent on optional new commands or the separately owned run/battle simulation'],
    numeric: { fits: false, diagnostics: [], uncovered: ['Shared month/birthday steps before eventual natural lifespan death',
      'Production/run/battle counters and other future consumers of shared IDs or RNG streams'] } };
  try {
    // Do this before touching any supplied properties. The result owns no input refs.
    canonicalUtf8ByteLength(input);
    const { world, buildFacts: facts } = input;
    const rows = assessBuildHistoryObligations(facts);
    if (world.builds.schemaVersion !== 2 || world.cultivation.schemaVersion !== 3 || world.legacy.schemaVersion !== 1) throw new TypeError('Requires World v8 progression domains');
    if (facts.historyCount !== world.builds.history.length || sortedIds(facts.disciples.map(d => d.discipleId)) !== sortedIds(world.builds.disciples.map(d => d.discipleId))
      || sortedIds(facts.retiredDiscipleIds) !== sortedIds(world.builds.retiredDisciples.map(d => d.discipleId))) throw new TypeError('Build obligation facts differ from domain identities/history');
    if (sortedIds(world.builds.disciples.map(d => d.discipleId)) !== sortedIds(world.cultivation.disciples.map(d => d.discipleId))
      || sortedIds(world.disciples.map(d => d.id)) !== sortedIds(world.cultivation.disciples.map(d => d.discipleId))) throw new TypeError('Incomplete retirement cannot release lifecycle ownership');
    const profiles = new Map(world.cultivation.disciples.map(d => [d.discipleId, d]));
    const members = new Map(facts.disciples.map(d => [d.discipleId, d]));
    const pendingEstates = new Map(facts.pendingEstates.map(e => [e.discipleId, e.beneficiaryId]));
    for (const member of facts.disciples) {
      const profile = profiles.get(member.discipleId);
      if (!profile || profile.lifeState !== member.lifeState || profile.heirId !== member.heirId) throw new TypeError('Lifecycle facts differ from cultivation');
      if (member.lifeState === 'dead' && world.cultivation.deaths.find(d => d.deathId === profile.deathId && d.discipleId === member.discipleId)?.beneficiaryId !== pendingEstates.get(member.discipleId)) throw new TypeError('Death beneficiary fact differs');
    }
    if (facts.equipment.length !== world.builds.equipment.length || facts.equipment.some(item => {
      const actual = world.builds.equipment.find(e => e.instanceId === item.itemInstanceId);
      return !actual || item.ownerDiscipleId !== (actual.owner.kind === 'disciple' ? actual.owner.discipleId : null);
    })) throw new TypeError('Equipment obligation facts differ');
    const commandId = (value: string): string => {
      if (!isBuildId(value)) throw new TypeError(`Necessary authority identity exceeds legal width: ${value.slice(0, 40)}`);
      return value;
    };
    // Exactly the same distinct-owner traversal as build-obligations. Each item's
    // future transfer and each relic's future death payload belong to THAT owner.
    const chain = (first: string): string[] => {
      const visited: string[] = []; let next: string | null = first;
      while (next !== null && !visited.includes(next)) {
        const member = members.get(next); if (!member) throw new TypeError('Unknown inheritance owner');
        visited.push(next);
        const heir: string | null = member.lifeState === 'dead' ? pendingEstates.get(next)! : member.heirId;
        next = heir !== null && members.get(heir)?.lifeState === 'alive' ? heir : null;
      }
      return visited;
    };
    const futureItems = new Map(facts.disciples.map(d => [d.discipleId, [] as string[]]));
    const futureRelics = new Map(facts.disciples.map(d => [d.discipleId, [] as string[]]));
    for (const item of facts.equipment) if (item.ownerDiscipleId !== null) for (const id of chain(item.ownerDiscipleId)) futureItems.get(id)!.push(item.itemInstanceId);
    for (const profile of profiles.values()) for (const relic of profile.relicIds) for (const id of chain(profile.discipleId)) futureRelics.get(id)!.push(relic);
    for (const values of [...futureItems.values(), ...futureRelics.values()]) values.sort();
    if ([...futureItems.values()].reduce((sum, items) => sum + items.length, 0) !== rows.breakdown.transfers) throw new TypeError('Item transfer count differs from history obligation');

    const teachings = new Map<string, { teacherId: string; studentId: string; knowledgeId: string; remainingMonths: number; event?: CultivationEvent }>();
    for (const profile of profiles.values()) if (profile.teaching) teachings.set(profile.teaching.teachingId,
      { teacherId: profile.discipleId, studentId: profile.teaching.studentId, knowledgeId: profile.teaching.knowledgeId,
        remainingMonths: profile.teaching.requiredMonths - profile.teaching.completedMonths });
    for (const teachingId of facts.teachingIds) if (!teachings.has(teachingId)) {
      const event = world.cultivation.events.find(e => e.kind === 'cultivation.taught' && e.relatedId === teachingId);
      const knowledge = event && profiles.get(event.discipleId)?.knowledge.find(k => k.teachingId === teachingId);
      if (!event || !knowledge?.teacherId) throw new TypeError('Outstanding teaching lacks its plan or taught provenance');
      teachings.set(teachingId, { teacherId: knowledge.teacherId, studentId: event.discipleId, knowledgeId: knowledge.knowledgeId, remainingMonths: 0, event });
    }
    const futureKnowledge = new Map<string, LearnedKnowledge[]>();
    const futureSkills = new Map<string, LearnedSkillV2[]>();
    for (const [teachingId, teaching] of [...teachings].sort(([a], [b]) => a.localeCompare(b))) {
      const pendingGrant = facts.teachingIds.includes(teachingId);
      const commitment = owner('teaching', teachingId, ['Taught knowledge AND World event copy committed; any required permanent build grant committed',
        'Clearing teacher.teaching alone is not discharge; cancellation requires an authenticated teacher/student unavailability transition']);
      const learned: LearnedKnowledge = { knowledgeId: teaching.knowledgeId, teacherId: teaching.teacherId, teachingId };
      if (!teaching.event) {
        reserve(commitment, 'teaching:student.knowledge', learned);
        futureKnowledge.set(teaching.studentId, [...(futureKnowledge.get(teaching.studentId) ?? []), learned]);
      }
      cultivationEvent(commitment, world, 'teaching-completed', 'cultivation.taught', teaching.studentId, teachingId, teaching.event);
      // A month action is shared by many completions. One per owner is an explicit
      // upper bound; it is NOT charged as another history row.
      if (!teaching.event) {
        commitment.sequenceReserve.nextAction += teaching.remainingMonths;
        commitment.counterReserve.calendarMonths += teaching.remainingMonths;
      }
      if (pendingGrant) {
        const definition = campaignKnowledge(teaching.knowledgeId);
        if (!definition) throw new TypeError('No authenticated permanent knowledge definition');
        const acquisitionId = commandId(`teaching/${teachingId}/${teaching.studentId}`);
        const provenance = { kind: 'teaching' as const, knowledgeId: teaching.knowledgeId, teacherId: teaching.teacherId, teachingId };
        const command: BuildAuthorityCommandV2 = { kind: 'skill.grantKnowledge', commandId: acquisitionId, acquisitionId,
          expectedRevision: MAX - 1, discipleId: teaching.studentId, skillId: definition.skillId, provenance };
        build(commitment, 'teaching-grant', command, definition.skillId);
        const skill: LearnedSkillV2 = { skillId: definition.skillId, origin: 'teaching', creditCost: 0, acquisitionId, provenance };
        reserve(commitment, 'teaching-grant:build.learnedSkill', skill); commitment.buildCollections.learnedSkills += 1;
        futureSkills.set(teaching.studentId, [...(futureSkills.get(teaching.studentId) ?? []), skill]);
      }
      result.owners.push(commitment);
    }

    const lifecycleOwners = new Map<string, ProgressionReservation>();
    for (const member of [...facts.disciples].sort((a, b) => a.discipleId.localeCompare(b.discipleId))) {
      const profile = profiles.get(member.discipleId)!;
      const disciple = world.builds.disciples.find(d => d.discipleId === member.discipleId)!;
      const actor = world.disciples.find(d => d.id === member.discipleId);
      if (!actor) throw new TypeError('Archive lacks a World identity');
      const deathId = profile.deathId ?? profile.pendingDeathId ?? INSTANCE;
      const namespace = `death/${deathId}`;
      const commitment = owner('disciple-lifecycle', member.discipleId, ['Finalized death, all item transfers and estate settlement committed',
        'Build retirement, cultivation authority archive AND World identity archive committed; all executable ownership removed',
        'Every transferred item retains the recipient lifecycle reservation until that recipient settles']);
      lifecycleOwners.set(member.discipleId, commitment);
      const heirId = member.lifeState === 'dead' ? pendingEstates.get(member.discipleId)! : member.heirId;
      const beneficiaryId = heirId !== null && members.get(heirId)?.lifeState === 'alive' ? heirId : null;
      const settledOwner: EquipmentOwner = beneficiaryId === null ? { kind: 'sect-estate' } : { kind: 'disciple', discipleId: beneficiaryId };
      const itemIds = futureItems.get(member.discipleId)!;
      const relicIds = futureRelics.get(member.discipleId)!;
      if (member.lifeState === 'alive') {
        const pending: PendingDeath = { deathId, discipleId: member.discipleId, cause: 'lifespan', month: MAX };
        reserve(commitment, 'expiry:pendingDeath', pending); commitment.cultivationRows.pendingDeaths += 1;
        cultivationEvent(commitment, world, 'expiry', 'cultivation.expiryPending', member.discipleId, deathId);
        commitment.sequenceReserve.nextAction += 1; commitment.sequenceReserve.nextInstance += 1;
      }
      if (member.lifeState !== 'dead') {
        const death: DeathRecord = { deathId, discipleId: member.discipleId, cause: 'breakthrough', month: MAX, beneficiaryId,
          transferredRelicIds: [...relicIds], revokedSourceInstanceIds: profile.talents.filter(t => t.active).map(t => t.sourceInstanceId),
          cancelledAttemptId: profile.activeAttemptId, cleanupDiscipleId: member.discipleId };
        reserve(commitment, 'death:record+relic-chain+revoked-sources', death); commitment.cultivationRows.deaths += 1;
        cultivationEvent(commitment, world, 'death', 'cultivation.died', member.discipleId, deathId);
        const finalize: CultivationCommand = { kind: 'death.finalize', commandId: PLAYER_COMMAND, expectedRevision: MAX - 1,
          discipleId: member.discipleId, deathId, cause: 'breakthrough', acknowledgeDeath: true };
        // The player lifespan path has a shorter cause string. A combat/resolve
        // path may use no World receipt; reserving the player path is conservative.
        const cancellationEvents = Object.values(world.transactions).filter(job => job.workerId === member.discipleId && ['Running', 'Blocked'].includes(job.state)).length
          + Object.values(world.automaticProduction.live).filter(pair => pair.transaction.workerId === member.discipleId).length;
        cultivationReceipt(commitment, 'death-finalize', finalize, deathId, 'death', 1 + (profile.activeAttemptId ? 1 : 0) + cancellationEvents, true);
        // Relics keep their identity after moving. Fund destination array insertion
        // once at each actual chain owner, in addition to the death provenance copy.
        if (relicIds.length) reserve(commitment, 'death:destination-relic-array-insertions', relicIds);
      }
      const retire: BuildAuthorityCommandV2 = { kind: 'disciple.retire', commandId: commandId(`${namespace}/retire`), expectedRevision: MAX - 1,
        discipleId: member.discipleId, deathId };
      const operations: BuildSourceOperation[] = disciple.sources.map(source => ({ kind: 'source.remove', source: cloneJson(source) }));
      build(commitment, 'retirement', retire, member.discipleId, operations);
      const retired: RetiredBuildDisciple = { discipleId: member.discipleId, school: disciple.school, treeId: disciple.treeId, deathId,
        learnedSkills: [...cloneJson(disciple.learnedSkills), ...(futureSkills.get(member.discipleId) ?? [])], retiredRevision: MAX };
      reserve(commitment, 'retirement:build.summary+retained-learned-provenance', retired); commitment.buildCollections.retiredDisciples += 1;
      const transferCommandIds: string[] = [];
      for (const itemInstanceId of itemIds) {
        const transferId = commandId(`${namespace}/item/${itemInstanceId}`); transferCommandIds.push(transferId);
        const transfer: BuildAuthorityCommandV2 = { kind: 'equipment.transfer', commandId: transferId, expectedRevision: MAX - 1,
          transferId, itemInstanceId, fromOwner: { kind: 'disciple', discipleId: member.discipleId }, toOwner: settledOwner, reason: { kind: 'death', deathId } };
        build(commitment, `transfer:${itemInstanceId}`, transfer, itemInstanceId);
        // Ownership replacement may grow when the heir has a longer actual ID.
        const currentItem = world.builds.equipment.find(item => item.instanceId === itemInstanceId)!;
        reserve(commitment, `transfer:${itemInstanceId}:equipment-owner`, settledOwner, currentItem.owner);
      }
      const archiveCommand: CultivationAuthorityCommandV3 = { kind: 'disciple.archive', commandId: commandId(`${namespace}/archive`),
        expectedRevision: MAX - 1, discipleId: member.discipleId, deathId };
      const archiveReceipt: CultivationAuthorityReceiptV3 = { command: archiveCommand, fingerprint: canonicalStringify(archiveCommand), revision: MAX, relatedId: member.discipleId };
      reserve(commitment, 'archive:cultivation.authority-receipt+escaped-fingerprint', archiveReceipt); commitment.cultivationRows.authorityReceipts += 1;
      const target = world.cultivation.attempts.find(a => a.attemptId === profile.activeAttemptId)?.preview.targetRealm ?? profile.realm;
      const realm = maximumRealm(profile.realm, target);
      const lifespanMonths = Math.max(REALM_RULES[profile.realm].lifespanMonths, REALM_RULES[target].lifespanMonths);
      const cultivation = Math.max(REALM_RULES[profile.realm].cultivationRequired, REALM_RULES[target].cultivationRequired);
      const knowledge = [...cloneJson(profile.knowledge), ...(futureKnowledge.get(member.discipleId) ?? [])];
      const archived: DeceasedCultivator = { discipleId: member.discipleId, ageMonths: MAX, realm, lifespanMonths,
        cultivation, understanding: 100, foundation: 100, mindset: 100,
        injury: 100, aptitude: profile.aptitude, knowledge,
        talents: profile.talents.map(talent => ({ ...cloneJson(talent), active: false })), deathId, archivedRevision: MAX };
      reserve(commitment, 'archive:cultivation.profile+knowledge+talents', archived); commitment.cultivationRows.archivedDisciples += 1;
      const identity: WorldDeceasedIdentity = { discipleId: actor.id, nameKey: actor.nameKey, presentationId: actor.presentationId,
        birthCalendarTick: actor.birthCalendarTick, ageMonths: MAX, aptitude: profile.aptitude, school: disciple.school, realm, deathId, archivedMonth: MAX };
      reserve(commitment, 'archive:World.identity+actual-escaped-name', identity); commitment.legacyRows.archivedIdentities += 1;
      // Preserve accepted profile extensions and fund growth BEFORE archive too.
      // The summary is deliberately a second copy. Death cannot spend that copy
      // merely because age/stat/teaching/relic fields grew on an earlier month.
      reserve(commitment, 'lifecycle:live-profile-field-growth', { ...cloneJson(profile), ageMonths: MAX, realm, lifespanMonths, cultivation,
        understanding: 100, foundation: 100, mindset: 100, injury: 100, knowledge, lifeState: 'pendingDeath',
        pendingDeathId: deathId, deathId, relicIds,
        teaching: profile.teaching ? { ...cloneJson(profile.teaching), completedMonths: profile.teaching.requiredMonths } : null,
        talents: profile.talents.map(talent => ({ ...cloneJson(talent), active: false })) }, profile);
      reserve(commitment, 'lifecycle:World-age-and-life-projection-growth', { ...cloneJson(actor), ageMonths: MAX, lifeState: 'pendingDeath', canWork: false }, actor);
      const estate: WorldEstateRecord = { estateId: `estate/${deathId}`, deathId, discipleId: member.discipleId,
        beneficiaryId: heirId, itemInstanceIds: [...itemIds], pendingRunId: profile.activityOwner?.runId ?? null,
        transferCommandIds, recordedMonth: MAX, settledMonth: MAX, settledOwner };
      // A synthetic superset includes pendingRunId AND terminal metadata. Both
      // individually legal shapes are bounded without assuming they coexist.
      const currentEstate = world.legacy.estates.find(entry => entry.deathId === profile.deathId);
      reserve(commitment, 'estate:record+item-list+transfer-provenance+pending-run+terminal-owner', estate, currentEstate);
      if (!currentEstate) commitment.legacyRows.estates += 1;
      result.owners.push(commitment);
    }

    const activeAttempts = world.cultivation.attempts.filter(a => ['Reserved', 'InSeclusion', 'DecisionReady'].includes(a.phase));
    const attemptOwners = new Map<string, ProgressionReservation>();
    for (const attempt of [...activeAttempts].sort((a, b) => a.attemptId.localeCompare(b.attemptId))) {
      const commitment = owner('breakthrough', attempt.attemptId, ['Resolved or cancelled attempt and required cultivation/World events and receipts committed',
        'Success target realm award committed; fatal outcome keeps disciple-lifecycle estate/archive ownership']);
      attemptOwners.set(attempt.attemptId, commitment);
      const stream = { algorithm: RANDOM_ALGORITHM, state: 0xffffffff, draws: MAX };
      const terminal: BreakthroughAttempt = { ...cloneJson(attempt), phase: 'Cancelled', reservation: { ...cloneJson(attempt.reservation), state: 'committed' },
        completedMonths: attempt.preview.seclusionMonths, blockedMonths: MAX, blockedReason: 'SUPPLY_SHORTAGE',
        sample: { sampleId: INSTANCE, successRoll: 10000, deathRoll: 10000, randomBefore: { ...stream }, randomAfter: { ...stream } }, outcome: 'cancelled' };
      // Preserve every accepted legacy extension on the attempt/reservation/preview.
      reserve(commitment, 'breakthrough:terminal-attempt+sample+actual-preview+legacy-fields', terminal, attempt);
      if (attempt.phase === 'Reserved') {
        const begin: CultivationCommand = { kind: 'breakthrough.begin', commandId: PLAYER_COMMAND, expectedRevision: MAX - 1, attemptId: attempt.attemptId };
        cultivationReceipt(commitment, 'breakthrough-begin', begin, attempt.attemptId, 'accepted', 1, true);
        cultivationEvent(commitment, world, 'breakthrough-started', 'cultivation.started', attempt.discipleId, attempt.attemptId, undefined, attempt.rootActionId);
      }
      if (attempt.phase !== 'DecisionReady') {
        cultivationEvent(commitment, world, 'breakthrough-ready', 'cultivation.ready', attempt.discipleId, attempt.attemptId, undefined, attempt.rootActionId);
        commitment.sequenceReserve.nextAction += Math.max(0, attempt.preview.seclusionMonths - attempt.completedMonths);
        commitment.counterReserve.calendarMonths += Math.max(0, attempt.preview.seclusionMonths - attempt.completedMonths);
      }
      const resolve: CultivationCommand = { kind: 'breakthrough.resolve', commandId: PLAYER_COMMAND, expectedRevision: MAX - 1, attemptId: attempt.attemptId, acknowledgeRisk: true };
      cultivationReceipt(commitment, 'breakthrough-resolve-or-cancel', resolve, attempt.attemptId, 'cancelled', 2, true);
      // At most one of resolved/cancelled is emitted. Their IDs/payloads coincide;
      // cancelled has the longer literal, so this one record bounds both paths.
      cultivationEvent(commitment, world, 'breakthrough-terminal', 'cultivation.cancelled', attempt.discipleId, attempt.attemptId, undefined, attempt.rootActionId);
      commitment.sequenceReserve.nextInstance += 1;
      // Samples are not raw RNG draws: rejection sampling can use more draws,
      // and optional intervening commands can change the future starting stream.
      commitment.counterReserve.eventsSamples = 1 + (attempt.preview.failureDeathBps > 0 ? 1 : 0);
      result.owners.push(commitment);
    }

    const addAward = (commitment: ProgressionReservation, discipleId: string, milestoneId: string, ruleId: MilestoneRuleId, id: string): void => {
      const command: BuildAuthorityCommandV2 = { kind: 'milestone.award', commandId: commandId(id), expectedRevision: MAX - 1,
        discipleId, milestoneId: commandId(milestoneId), ruleId };
      build(commitment, `award:${milestoneId}`, command, milestoneId);
      const award: MilestoneAward = { discipleId, milestoneId, ruleId, treePoints: 1, learningCredits: 2 };
      reserve(commitment, `award:${milestoneId}:build.awards`, award); commitment.buildCollections.awards += 1;
    };
    for (const milestoneId of facts.realmMilestoneIds) {
      const match = facts.disciples.map(member => ({ member, prefix: `realm/${member.discipleId}/` })).find(entry => milestoneId.startsWith(entry.prefix));
      if (!match) throw new TypeError('Unknown realm award owner');
      const realm = milestoneId.slice(match.prefix.length);
      if (!['qi', 'foundation', 'golden-core', 'nascent-soul'].includes(realm)) throw new TypeError('Unknown realm obligation');
      const attempt = activeAttempts.find(entry => entry.discipleId === match.member.discipleId && entry.preview.targetRealm === realm);
      const commitment = attempt ? attemptOwners.get(attempt.attemptId)! : lifecycleOwners.get(match.member.discipleId)!;
      addAward(commitment, match.member.discipleId, milestoneId, `realm.${realm}` as MilestoneRuleId, `system/${milestoneId}`);
    }
    if (facts.activeRun) {
      const run = world.expedition.run;
      if (!run || run.runId !== facts.activeRun.runId || run.phase === 'Ended') throw new TypeError('Active run facts differ');
      const commitment = owner('run-build', run.runId, ['Ended run, complete squad unlock and applicable surviving first-victory build awards committed',
        'This owner does not own run/battle/proof or inventory-recovery capacity']);
      const unlock: BuildAuthorityCommandV2 = { kind: 'expedition.unlock', commandId: commandId(`${run.runId}/build-unlock`), expectedRevision: MAX - 1,
        runId: run.runId, locks: run.members.map(member => ({ discipleId: member.discipleId, lockId: member.lockId })) };
      build(commitment, 'run-unlock', unlock, run.runId);
      commitment.counterReserve.cultivationRevisions += 1;
      for (const discipleId of facts.activeRun.firstVictoryDiscipleIds) addAward(commitment, discipleId,
        `milestone.first-expedition.${discipleId.replace(':', '-')}`, 'expedition.first-victory', `${run.runId}/award/${discipleId}`);
      result.owners.push(commitment);
    }
    for (const commitment of result.owners) {
      commitment.counterReserve.cultivationRevisions += commitment.sequenceReserve.nextAction + commitment.cultivationRows.authorityReceipts;
      commitment.counterReserve.calendarTicks = commitment.counterReserve.calendarMonths * CALENDAR_TICKS_PER_MONTH;
      // Each surviving owner carries the complete shared-scalar delta. This is an
      // explicit conservative duplication, not another history row or byte margin.
      reserve(commitment, 'shared-counter-width-growth', { buildRevision: MAX, cultivationRevision: MAX, calendarMonth: MAX,
        sequences: SEQUENCES, simulationTick: MAX, calendarTick: MAX, eventsDraws: MAX, eventsState: 0xffffffff },
      { buildRevision: world.builds.revision, cultivationRevision: world.cultivation.revision, calendarMonth: world.cultivation.calendarMonth,
        sequences: world.sequences, simulationTick: world.clock.simulationTick, calendarTick: world.clock.calendarTick,
        eventsDraws: world.randomStreams.events.draws, eventsState: world.randomStreams.events.state });
      add(result.totals, commitment);
    }
    if (result.totals.buildRows !== rows.reservedCommands) throw new TypeError('Progression build rows differ from exact history obligations');
    for (const value of Object.values(result.totals).flatMap(value => typeof value === 'number' ? [value] : Object.values(value))) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new RangeError('Progression charge exceeds finite safe range');
    }
    if (numericTail) result.numeric = assessProgressionReservationNumbers(world, result.totals, activeAttempts.length);
    result.supported = result.unknowns.length === 0;
  } catch (error) {
    result.unknowns.push(error instanceof Error ? error.message : 'No finite progression record envelope derived');
    // Never return a useful-looking partial allowance after failing derivation.
    result.owners = []; result.totals = amounts();
  }
  return freeze(result);
}

/** Original v7/v8/.3 entry point. The numeric tail runs at the same point in the
 * derivation and retains its original whole-month amounts and diagnostic order. */
export function deriveProgressionReservations(input: { world: ProgressionRecordSource; buildFacts: BuildHistoryObligationFacts }): ProgressionReservationAssessment {
  return deriveProgressionEnvelope(input, true);
}
/** Internal record-only derivation. Deliberately has NO numeric field to clear or
 * reinterpret. Version-specific time proofs must calculate their own numbers. */
export function deriveProgressionRecordEnvelope(input: { world: ProgressionRecordSource; buildFacts: BuildHistoryObligationFacts }): Omit<ProgressionReservationAssessment, 'numeric'> {
  const { numeric: _unprovedNumeric, ...records } = deriveProgressionEnvelope(input, false);
  return freeze(records);
}
/** Shared numeric tail, called only after a version has derived its actual total
 * operands. Does not consume, clear, or override a previous assessment. */
export function assessProgressionReservationNumbers(world: ProgressionRecordSource, totals: ProgressionBudgetAmounts, activeAttempts: number): ProgressionReservationAssessment['numeric'] {
  const numeric: ProgressionReservationAssessment['numeric'] = { fits: false, diagnostics: [], uncovered: [
    'Shared month/birthday steps before eventual natural lifespan death',
    'Production/run/battle counters and other future consumers of shared IDs or RNG streams',
  ] };
  for (const key of Object.keys(SEQUENCES) as (keyof SequenceState)[]) {
    if (world.sequences[key] > MAX - totals.sequenceReserve[key]) numeric.diagnostics.push(`Insufficient terminal ${key} headroom`);
  }
  const counters: readonly [string, number, number][] = [
    ['build revision', world.builds.revision, totals.buildRows],
    ['cultivation revision', world.cultivation.revision, totals.counterReserve.cultivationRevisions],
    ['cultivation calendar month', world.cultivation.calendarMonth, totals.counterReserve.calendarMonths],
    ['World calendar tick', world.clock.calendarTick, totals.counterReserve.calendarTicks],
    ['World simulation tick', world.clock.simulationTick, totals.counterReserve.calendarTicks],
  ];
  for (const [label, current, remaining] of counters) if (current > MAX - remaining) numeric.diagnostics.push(`Insufficient terminal ${label} headroom`);
  if (activeAttempts) numeric.uncovered.push('Raw events RNG draws for accepted breakthrough samples, including rejection draws');
  numeric.fits = numeric.diagnostics.length === 0;
  return numeric;
}

function maximumRealm(current: Realm, target: Realm | null | undefined): Realm {
  if (!target) return current;
  return canonicalUtf8ByteLength(target) > canonicalUtf8ByteLength(current) ? target : current;
}

/** Additional release ownership check. Capacity and all cross-domain validation
 * are still the caller's responsibility. A missing plan, unlocked build or
 * vanished owner is never by itself evidence that terminal work was committed. */
export function verifyProgressionReservationDischarges(before: { world: ProgressionRecordSource; assessment: ProgressionReservationAssessment },
  after: { world: ProgressionRecordSource; assessment: ProgressionReservationAssessment }): { supported: boolean; discharged: string[]; unknowns: string[] } {
  const discharged: string[] = []; const unknowns: string[] = [];
  if (!before.assessment.supported || !after.assessment.supported) return { supported: false, discharged, unknowns: ['Cannot discharge an unsupported progression envelope'] };
  const world = after.world;
  for (const prior of before.assessment.owners) {
    if (after.assessment.owners.some(next => next.kind === prior.kind && next.id === prior.id)) continue;
    let complete = false;
    if (prior.kind === 'disciple-lifecycle') {
      const death = world.cultivation.deaths.find(entry => entry.discipleId === prior.id);
      complete = !!death && !world.disciples.some(entry => entry.id === prior.id)
        && !world.cultivation.disciples.some(entry => entry.discipleId === prior.id) && !world.builds.disciples.some(entry => entry.discipleId === prior.id)
        && world.cultivation.archivedDisciples.some(entry => entry.discipleId === prior.id && entry.deathId === death.deathId)
        && world.builds.retiredDisciples.some(entry => entry.discipleId === prior.id && entry.deathId === death.deathId)
        && world.legacy.archivedIdentities.some(entry => entry.discipleId === prior.id && entry.deathId === death.deathId)
        && world.legacy.estates.some(entry => entry.discipleId === prior.id && entry.deathId === death.deathId && entry.settledMonth !== null
          && entry.pendingRunId === null && entry.transferCommandIds.length === entry.itemInstanceIds.length)
        && !world.builds.equipment.some(entry => entry.owner.kind === 'disciple' && entry.owner.discipleId === prior.id);
    } else if (prior.kind === 'teaching') {
      const taught = world.cultivation.events.find(event => event.kind === 'cultivation.taught' && event.relatedId === prior.id);
      const grantRequired = prior.buildRows > 0;
      if (taught) complete = !!(world.events.find(event => event.eventId === taught.eventId) ?? lookupArchivedEvent(world.history, taught.eventId))
        && [...world.cultivation.disciples, ...world.cultivation.archivedDisciples].some(profile => profile.discipleId === taught.discipleId && profile.knowledge.some(entry => entry.teachingId === prior.id))
        && (!grantRequired || world.builds.history.some(entry => entry.authority && entry.command.kind === 'skill.grantKnowledge'
          && entry.command.provenance.kind === 'teaching' && entry.command.provenance.teachingId === prior.id));
      else {
        const teacher = before.world.cultivation.disciples.find(profile => profile.teaching?.teachingId === prior.id);
        const participants = teacher ? [teacher.discipleId, teacher.teaching!.studentId] : [];
        complete = participants.some(id => world.cultivation.pendingDeaths.some(entry => entry.discipleId === id)
          || world.cultivation.deaths.some(entry => entry.discipleId === id));
      }
    } else if (prior.kind === 'breakthrough') {
      const attempt = world.cultivation.attempts.find(entry => entry.attemptId === prior.id);
      const terminal = world.cultivation.events.find(event => ['cultivation.resolved', 'cultivation.cancelled'].includes(event.kind) && event.relatedId === prior.id);
      complete = !!attempt && ['Resolved', 'Cancelled'].includes(attempt.phase)
        && !!terminal && !!(world.events.find(event => event.eventId === terminal.eventId) ?? lookupArchivedEvent(world.history, terminal.eventId))
        && (attempt.phase === 'Cancelled' || world.cultivation.receipts.some(receipt => receipt.result.kind === 'breakthrough.resolve' && receipt.result.relatedId === prior.id))
        && (attempt.outcome !== 'success' || world.builds.awards.some(award => award.discipleId === attempt.discipleId && award.ruleId === `realm.${attempt.preview.targetRealm}`));
    } else {
      const run = world.expedition.run;
      complete = !!run && run.runId === prior.id && run.phase === 'Ended'
        && world.builds.history.some(entry => entry.authority && entry.command.kind === 'expedition.unlock' && entry.command.runId === prior.id)
        && !world.builds.disciples.some(entry => entry.lock?.runId === prior.id)
        && !world.cultivation.disciples.some(entry => entry.activityOwner?.runId === prior.id)
        && (run.settlement?.reason !== 'victory' || run.members.filter(member => member.alive).every(member =>
          world.builds.awards.some(award => award.discipleId === member.discipleId && award.ruleId === 'expedition.first-victory')));
    }
    if (complete) discharged.push(`${prior.kind}:${prior.id}`);
    else unknowns.push(`Missing complete terminal evidence for ${prior.kind}:${prior.id}`);
  }
  return freeze({ supported: unknowns.length === 0, discharged, unknowns });
}
