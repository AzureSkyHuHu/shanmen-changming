import {
  accumulateFrame, advanceTicksWithStatus, CALENDAR_TICKS_PER_MONTH, cloneJson,
  createFrameAccumulator, createWorld, dispatchCommand, isPaused, RESOURCE_IDS,
  setClockSpeed, setPauseReason, validateWorldState, previewWorldBreakthrough, stableHash, canonicalStringify,
  type Command, type CommandResult, type Disciple, type DomainEvent, type PauseReason, type PlayerCultivationCommand,
  type ProductionTransaction, type SimulationSpeed, type WorldBuilding, type WorldMap, type WorldState,
} from '../core/kernel';
import type { BuildCommand, BuildData, BuildStateFrame } from '../core/builds';
import type { CombatControllerState } from '../core/combat/ai';
import type { OfferState, EndRunSettlement, RouteNode, RunTalent } from '../core/expeditions/types';
import type { ExpeditionDepartureRequest, PlayerExpeditionCommand, WorldExpeditionPreview, WorldExpeditionProjection } from '../core/expeditions/world-types';
import { previewWorldExpedition, projectWorldExpedition } from '../core/expeditions/world-adapter';
import { REALM_RULES } from '../core/cultivation/rules';
import { cloneWorldWithSharedHistory, lookupCommandReceipt, lookupProduction, recentWorldEvents } from '../core/world/history-access';
import type { BreakthroughAttempt, BreakthroughPreparation, BreakthroughPreview, Cultivator, DeathCause } from '../core/cultivation/types';
import type { SectEconomyCommand, SectEconomyState } from '../core/sect-economy/types';
import { matchesWorkPlanGuard, type WorkPlanEditGuard } from './work-plan-contract';
import { measureWorldSaveBytes, SAVE_FILE_LIMIT_BYTES } from '../core/save-budget';
import { previewWorldAutomaticWork } from '../core/world/automatic-work-bridge';
import { lookupLiveProduction } from '../core/economy/automatic-production';
import type { ProductionWork } from '../core/economy/automatic-types';
import { matchesInventoryDiscardGuard, type InventoryDiscardRequest, type InventoryDiscardGuard, type InventoryDiscardCommandResult } from './inventory-contract';

export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type Selection = { kind: 'disciple' | 'building'; id: string } | null;
export type SessionCommand = Pick<Extract<Command, { kind: 'production.start' }>, 'kind' | 'payload'> | Pick<Extract<Command, { kind: 'production.cancel' }>, 'kind' | 'payload'>;
type WithoutCommandId<T> = T extends unknown ? Omit<T, 'commandId'> : never;
export type CultivationRequest = WithoutCommandId<PlayerCultivationCommand>;
export type BuildRequest = WithoutCommandId<BuildCommand>;
export type ExpeditionRequest = WithoutCommandId<PlayerExpeditionCommand>;
export interface DepartureProposal { request: ExpeditionDepartureRequest; preview: DeepReadonly<WorldExpeditionPreview>; basisStamp: string; sessionEpoch: number }
export type OfferProjection = Pick<OfferState, 'offerId' | 'revision' | 'candidateDefinitionIds' | 'eligibleHolderIdsByCard' | 'remainingRerolls' | 'diagnostics' | 'supplyFallback'>;
export interface ExpeditionProjection extends Omit<WorldExpeditionProjection, 'battle' | 'currentOffer' | 'talentInstances'> {
  currentOffer: OfferProjection | null;
  talentInstances: RunTalent[];
  route: RouteNode[];
  members: Array<{ discipleId: string; alive: boolean; health: number; spirit: number; injury: number; durability: number }>;
  settlement: Pick<EndRunSettlement, 'reason' | 'returnMonths' | 'returnProgress' | 'loot' | 'lostLoot' | 'unusedSupplies' | 'committed'> | null;
  lastEncounterOutcome: 'victory' | 'emergencyRetreat' | 'defeat' | null;
  encounterDefinitionId: string | null;
  encounterId: string | null;
  preparationCandidates: Array<{ discipleId: string; available: boolean; remainingLifespanMonths: number; injury: number }>;
}
export interface BreakthroughProposal { preview: BreakthroughPreview; resourceStamp: string; sessionEpoch: number }
export type AttemptProjection = Pick<BreakthroughAttempt, 'attemptId' | 'phase' | 'preview' | 'completedMonths' | 'blockedMonths' | 'blockedReason' | 'outcome'>;
export interface SelectedCultivationProjection extends Pick<Cultivator, 'discipleId' | 'realm' | 'cultivation' | 'understanding' | 'foundation' | 'mindset' | 'injury' | 'lifeState' | 'trainingMode' | 'heirId'> {
  requiredCultivation: number; remainingLifespanMonths: number; relicCount: number; activityLocked: boolean;
  activeAttempt: AttemptProjection | null;
  pendingDeath: { deathId: string; cause: DeathCause; month: number } | null;
  deathRecord: { cause: DeathCause; month: number; beneficiaryId: string | null; transferredRelicCount: number } | null;
  lastOutcome: BreakthroughAttempt['outcome'];
  heirChoices: string[];
  teaching: Cultivator['teaching'];
  learning: { teacherId: string; knowledgeId: string; completedMonths: number; requiredMonths: number } | null;
  teachingChoices: Array<{ knowledgeId: string; studentIds: string[] }>;
  totalTeachableKnowledge: number;
}
export interface CultivationProjection {
  revision: number; resourceStamp: string;
  selected: SelectedCultivationProjection | null;
  summaries: Array<Pick<Cultivator, 'discipleId' | 'realm' | 'lifeState' | 'trainingMode' | 'activeAttemptId'> & { teaching: boolean; learning: boolean; away: boolean }>;
  decisions: Array<{ discipleId: string; kind: 'death' | 'breakthrough' }>;
}

export const DISPLAY_PRODUCTION_PHASES = ['WaitingForStation', 'TravellingToWork', 'Working', 'TravellingToStorage', 'AwaitingDelivery', 'Done', 'Cancelled'] as const;
export type ProductionPhaseView = typeof DISPLAY_PRODUCTION_PHASES[number];
export type ProductionBlockView = 'CAPACITY_EXCEEDED' | 'WAITING_FOR_STATION' | 'WORKER_UNAVAILABLE' | 'WORKSTATION_UNAVAILABLE' | 'STORAGE_UNAVAILABLE' | 'PATH_BLOCKED';
export interface ProductionProjection extends Pick<ProductionTransaction, 'transactionId' | 'recipeId' | 'workerId' | 'state' | 'activeTicks' | 'requiredTicks'> {
  phase: ProductionPhaseView | null;
  blockedReason: ProductionBlockView | null;
}
export interface EventProjection {
  eventId: string; kind: DomainEvent['kind']; tick: number;
  transactionId: string | null; workerId: string | null; recipeId: string | null; reason: string | null;
  discipleId: string | null;
  resourceId: typeof RESOURCE_IDS[number] | null; quantity: number | null;
}
export interface SessionProjection {
  revision: number;
  sessionEpoch: number;
  worldRevision: number;
  seed: string;
  clock: WorldState['clock'];
  calendar: { year: number; month: number; progress: number };
  map: WorldMap;
  disciples: Disciple[];
  buildings: WorldBuilding[];
  resources: Array<WorldState['inventory'][typeof RESOURCE_IDS[number]] & { available: number }>;
  /** Active assignments plus transactions referenced by the bounded visible journal. */
  transactions: ProductionProjection[];
  recentEvents: EventProjection[];
  cultivation: CultivationProjection;
  sectEconomy: SectEconomyState;
  expedition: ExpeditionProjection;
  selection: Selection;
  lastCommand: CommandResult | null;
  paused: boolean;
  capacityStop: 'SAVE_CAPACITY_EXCEEDED' | 'SAVE_OBLIGATION_UNBOUNDED' | null;
}

export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Owns the only authoritative world. Consumers receive detached, immutable DTOs. */
export class ApplicationSession {
  private world: WorldState;
  private listeners = new Set<() => void>();
  private selection: Selection = null;
  private lastCommand: CommandResult | null = null;
  private revision = 0;
  private worldRevision = 0;
  private sessionEpoch = 0;
  private sequence = 0;
  private baseline: number | null = null;
  private accumulator = createFrameAccumulator();
  private foreground = { visible: true, focused: true };
  private storageReadOnly = false;
  private overlayPaused = false;
  private invariantStopped = false;
  private readonly ephemeralPauses = new Set<PauseReason>();
  private capacityStop: 'SAVE_CAPACITY_EXCEEDED' | 'SAVE_OBLIGATION_UNBOUNDED' | null = null;
  private snapshot: DeepReadonly<SessionProjection>;
  private automaticQuerySource: WorldState | null = null;
  private automaticQuery: DeepReadonly<ReturnType<typeof previewWorldAutomaticWork>> | null = null;
  private buildQuerySource: BuildData | null = null;
  private buildQuery: BuildStateFrame | null = null;

  constructor(world = createWorld()) {
    this.world = this.ownWorld(world);
    this.selection = this.world.disciples[1] ? { kind: 'disciple', id: this.world.disciples[1].id } : null;
    this.sequence = this.nextSequence();
    this.snapshot = this.project();
  }

  private ownWorld(world: WorldState): WorldState {
    const errors = validateWorldState(world);
    if (errors.length) throw new TypeError('Invalid session world');
    return cloneWorldWithSharedHistory(world);
  }

  private nextSequence(start = 0): number {
    // Receipt IDs are untrusted save content; do not turn a huge numeric suffix into Infinity.
    const pending = new Set(this.world.pendingCommands.map((command) => command.commandId));
    let next = start;
    while (pending.has(`app-command.${next}`) || lookupCommandReceipt(this.world, `app-command.${next}`)) {
      if (next >= Number.MAX_SAFE_INTEGER) throw new RangeError('Application command sequence exhausted');
      next += 1;
    }
    return next;
  }

  private cultivationProjection(): CultivationProjection {
    const state = this.world.cultivation;
    const receiving = new Map(state.disciples.filter((profile) => profile.teaching).map((profile) => [profile.teaching!.studentId, profile]));
    const profile = this.selection?.kind === 'disciple' ? state.disciples.find((entry) => entry.discipleId === this.selection!.id) : undefined;
    let selected: SelectedCultivationProjection | null = null;
    if (profile) {
      const attempt = profile.activeAttemptId ? state.attempts.find((entry) => entry.attemptId === profile.activeAttemptId) : undefined;
      const pending = profile.pendingDeathId ? state.pendingDeaths.find((entry) => entry.deathId === profile.pendingDeathId) : undefined;
      const death = profile.deathId ? state.deaths.find((entry) => entry.deathId === profile.deathId) : undefined;
      const latest = state.attempts.findLast((entry) => entry.discipleId === profile.discipleId && entry.outcome !== null);
      const teacher = receiving.get(profile.discipleId);
      const canTeach = profile.lifeState === 'alive' && !profile.activityOwner && !profile.activeAttemptId && !profile.teaching && !teacher;
      const students = canTeach ? state.disciples.filter((entry) => entry.discipleId !== profile.discipleId && entry.lifeState === 'alive' && !entry.activityOwner && !entry.activeAttemptId && !entry.teaching && !receiving.has(entry.discipleId)) : [];
      const choices = canTeach ? profile.knowledge.map((knowledge) => ({ knowledgeId: knowledge.knowledgeId, studentIds: students.filter((entry) => !entry.knowledge.some((known) => known.knowledgeId === knowledge.knowledgeId)).map((entry) => entry.discipleId) })).filter((entry) => entry.studentIds.length > 0) : [];
      selected = {
        discipleId: profile.discipleId, realm: profile.realm, cultivation: profile.cultivation,
        understanding: profile.understanding, foundation: profile.foundation, mindset: profile.mindset, injury: profile.injury,
        lifeState: profile.lifeState, trainingMode: profile.trainingMode, heirId: profile.heirId,
        requiredCultivation: REALM_RULES[profile.realm].cultivationRequired, activityLocked: profile.activityOwner !== null,
        remainingLifespanMonths: Math.max(0, profile.lifespanMonths - profile.ageMonths), relicCount: profile.relicIds.length,
        activeAttempt: attempt ? { attemptId: attempt.attemptId, phase: attempt.phase, preview: attempt.preview, completedMonths: attempt.completedMonths, blockedMonths: attempt.blockedMonths, blockedReason: attempt.blockedReason, outcome: attempt.outcome } : null,
        pendingDeath: pending ? { deathId: pending.deathId, cause: pending.cause, month: pending.month } : null,
        deathRecord: death ? { cause: death.cause, month: death.month, beneficiaryId: death.beneficiaryId, transferredRelicCount: death.transferredRelicIds.length } : null,
        lastOutcome: latest?.outcome ?? null,
        heirChoices: state.disciples.filter((entry) => entry.discipleId !== profile.discipleId && entry.lifeState === 'alive').map((entry) => entry.discipleId),
        teaching: profile.teaching,
        learning: teacher?.teaching ? { teacherId: teacher.discipleId, knowledgeId: teacher.teaching.knowledgeId, completedMonths: teacher.teaching.completedMonths, requiredMonths: teacher.teaching.requiredMonths } : null,
        teachingChoices: choices.slice(0, 64), totalTeachableKnowledge: choices.length,
      };
    }
    return {
      revision: state.revision, resourceStamp: stableHash(this.world.inventory), selected,
      summaries: state.disciples.map((entry) => ({ discipleId: entry.discipleId, realm: entry.realm, lifeState: entry.lifeState, trainingMode: entry.trainingMode, activeAttemptId: entry.activeAttemptId, teaching: entry.teaching !== null, learning: receiving.has(entry.discipleId), away: entry.activityOwner !== null })),
      decisions: [...state.pendingDeaths.map((entry) => ({ discipleId: entry.discipleId, kind: 'death' as const })), ...state.disciples.filter((entry) => entry.activeAttemptId && state.attempts.some((attempt) => attempt.attemptId === entry.activeAttemptId && attempt.phase === 'DecisionReady')).map((entry) => ({ discipleId: entry.discipleId, kind: 'breakthrough' as const }))],
    };
  }

  private expeditionProjection(): DeepReadonly<ExpeditionProjection> {
    const source = projectWorldExpedition(this.world);
    const { battle: _battle, currentOffer: offer, ...summary } = source;
    const run = this.world.expedition.run;
    const settlement = run?.settlement;
    return deepFreeze(cloneJson({
      ...summary,
      currentOffer: offer ? { offerId: offer.offerId, revision: offer.revision, candidateDefinitionIds: offer.candidateDefinitionIds, eligibleHolderIdsByCard: offer.eligibleHolderIdsByCard, remainingRerolls: offer.remainingRerolls, diagnostics: offer.diagnostics, supplyFallback: offer.supplyFallback } : null,
      route: run?.route ?? [],
      members: run?.members.map((member) => ({ discipleId: member.discipleId, alive: member.alive, health: member.health, spirit: member.spirit, injury: member.injury, durability: member.durability })) ?? [],
      settlement: settlement ? { reason: settlement.reason, returnMonths: settlement.returnMonths, returnProgress: settlement.returnProgress, loot: settlement.loot, lostLoot: settlement.lostLoot, unusedSupplies: settlement.unusedSupplies, committed: settlement.committed } : null,
      lastEncounterOutcome: run?.encounterResults.at(-1)?.outcome ?? null,
      encounterDefinitionId: this.world.expedition.battle?.definitionId ?? null,
      encounterId: this.world.expedition.battle?.encounterId ?? null,
      preparationCandidates: this.world.cultivation.disciples.map((profile) => {
        const build = this.world.builds.disciples.find((entry) => entry.discipleId === profile.discipleId);
        return { discipleId: profile.discipleId, injury: profile.injury, remainingLifespanMonths: Math.max(0, profile.lifespanMonths - profile.ageMonths), available: profile.lifeState === 'alive' && !profile.activityOwner && !profile.activeAttemptId && !profile.teaching && !this.world.cultivation.disciples.some((teacher) => teacher.teaching?.studentId === profile.discipleId) && !!build && !build.lock };
      }),
    }));
  }

  private project(): DeepReadonly<SessionProjection> {
    const elapsedMonths = Math.floor(this.world.clock.calendarTick / CALENDAR_TICKS_PER_MONTH);
    const recentEvents = recentWorldEvents(this.world, 5).reverse();
    // Historical transaction receipts stay in World for idempotency, not in every UI frame.
    const visibleTransactionIds = new Set<string>();
    for (const disciple of this.world.disciples) if (disciple.assignmentTransactionId) visibleTransactionIds.add(disciple.assignmentTransactionId);
    for (const event of recentEvents) if (typeof event.payload.transactionId === 'string') visibleTransactionIds.add(event.payload.transactionId);
    const visibleTransactions = [...visibleTransactionIds].map((id) => lookupLiveProduction(this.world, id)?.transaction ?? lookupProduction(this.world, id)).filter((transaction): transaction is ProductionWork => transaction !== undefined);
    let displayClock = this.capacityStop ? setPauseReason(this.world.clock, 'save-capacity', true) : this.world.clock;
    if (this.invariantStopped) displayClock = setPauseReason(displayClock, 'error', true);
    for (const reason of this.ephemeralPauses) displayClock = setPauseReason(displayClock, reason, true);
    return deepFreeze(cloneJson({
      revision: this.revision, sessionEpoch: this.sessionEpoch, worldRevision: this.worldRevision, seed: this.world.seed,
      clock: this.overlayPaused ? setPauseReason(this.storageReadOnly ? setPauseReason(displayClock, 'danger', true) : displayClock, 'choice', true) : this.storageReadOnly ? setPauseReason(displayClock, 'danger', true) : displayClock,
      calendar: { year: Math.floor(elapsedMonths / 12) + 1, month: elapsedMonths % 12 + 1, progress: (this.world.clock.calendarTick % CALENDAR_TICKS_PER_MONTH) / CALENDAR_TICKS_PER_MONTH },
      map: this.world.map, disciples: this.world.disciples, buildings: this.world.buildings,
      resources: RESOURCE_IDS.map((id) => ({ ...this.world.inventory[id], available: this.world.inventory[id].owned - this.world.inventory[id].reserved })),
      transactions: visibleTransactions.map((transaction): ProductionProjection => ({
        transactionId: transaction.transactionId, recipeId: transaction.recipeId, workerId: transaction.workerId,
        state: transaction.state, activeTicks: transaction.activeTicks, requiredTicks: transaction.requiredTicks,
        phase: 'phase' in transaction && DISPLAY_PRODUCTION_PHASES.includes(transaction.phase as ProductionPhaseView) ? transaction.phase as ProductionPhaseView : null,
        blockedReason: transaction.blockedReason,
      })),
      recentEvents: recentEvents.map((event): EventProjection => ({
        eventId: event.eventId, kind: event.kind, tick: event.tick,
        transactionId: typeof event.payload.transactionId === 'string' ? event.payload.transactionId : null,
        workerId: typeof event.payload.workerId === 'string' ? event.payload.workerId : null,
        recipeId: typeof event.payload.recipeId === 'string' ? event.payload.recipeId : null,
        reason: typeof event.payload.reason === 'string' ? event.payload.reason : null,
        discipleId: typeof event.payload.discipleId === 'string' ? event.payload.discipleId : null,
        resourceId: RESOURCE_IDS.includes(event.payload.resourceId as typeof RESOURCE_IDS[number]) ? event.payload.resourceId as typeof RESOURCE_IDS[number] : null,
        quantity: typeof event.payload.quantity === 'number' ? event.payload.quantity : null,
      })),
      cultivation: this.cultivationProjection(), sectEconomy: this.world.sectEconomy, expedition: this.expeditionProjection(),
      selection: this.selection, lastCommand: this.lastCommand, paused: isPaused(this.world.clock) || this.storageReadOnly || this.overlayPaused || this.capacityStop !== null || this.ephemeralPauses.size > 0 || this.invariantStopped, capacityStop: this.capacityStop,
    }));
  }

  private publish(worldChanged = true): void {
    this.revision += 1;
    if (worldChanged) this.worldRevision += 1;
    this.snapshot = this.project();
    for (const listener of [...this.listeners]) listener();
  }

  /** Stable identity until the next publication: safe for useSyncExternalStore. */
  readonly getSnapshot = (): DeepReadonly<SessionProjection> => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Mutable gameplay is detached; immutable authenticated history can safely share its pages. */
  exportWorld(): WorldState { return cloneWorldWithSharedHistory(this.world); }

  /** Separate stable readonly query: controller audit/event trees are not copied into UI DTOs. */
  readonly getBattleController = (): CombatControllerState | null => {
    const controller = this.world.expedition.battle?.controller;
    // Engine transitions are immutable; imported/drafted branches are sealed before exposure.
    return controller ? deepFreeze(controller) : null;
  };

  /** Full semantic build frame is queried only when its authority branch changes, never per tick. */
  readonly getBuildFrame = (): BuildStateFrame => {
    if (this.buildQuerySource !== this.world.builds || !this.buildQuery) {
      this.buildQuerySource = this.world.builds;
      this.buildQuery = deepFreeze({ builds: this.world.builds, sequences: { ...this.world.sequences } });
    }
    return this.buildQuery;
  };

  select(selection: Selection): void {
    if (selection && !(selection.kind === 'disciple' ? this.world.disciples : this.world.buildings).some((entity) => entity.id === selection.id)) return;
    if (selection?.kind === this.selection?.kind && selection?.id === this.selection?.id) return;
    this.selection = selection ? { ...selection } : null;
    this.publish(false);
  }

  private submit(create: (commandId: string, sequence: number, issuedTick: number) => Command): DeepReadonly<CommandResult> {
    const sequence = this.nextSequence(this.sequence);
    this.sequence = sequence + 1;
    const commandId = `app-command.${sequence}`;
    if (this.storageReadOnly || this.overlayPaused || this.invariantStopped) {
      this.lastCommand = { commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code: 'CORE_PAUSED_ERROR' } };
      this.publish(false);
      return deepFreeze(cloneJson(this.lastCommand));
    }
    const wasPaused = isPaused(this.world.clock);
    const outcome = dispatchCommand(this.world, create(commandId, sequence, this.world.clock.simulationTick));
    this.world = outcome.world;
    this.lastCommand = outcome.result;
    if (outcome.result.status === 'accepted' && !outcome.world.clock.pauseReasons.includes('save-capacity')) this.capacityStop = null;
    // A domain decision may remove its own pause. Never charge the paused interval to the next frame.
    if (wasPaused !== isPaused(this.world.clock)) this.resetFrameBaseline();
    this.publish();
    return deepFreeze(cloneJson(outcome.result));
  }

  dispatch(request: SessionCommand): DeepReadonly<CommandResult> {
    return this.submit((commandId, sequence, issuedTick) => ({ ...cloneJson(request), commandId, sequence, issuedTick } as Command));
  }

  dispatchCultivation(request: CultivationRequest): DeepReadonly<CommandResult> {
    return this.submit((commandId, sequence, issuedTick) => ({
      commandId, sequence, issuedTick, kind: 'cultivation.command',
      payload: { command: { ...cloneJson(request), commandId } as PlayerCultivationCommand },
    }));
  }

  dispatchBuild(request: BuildRequest): DeepReadonly<CommandResult> {
    return this.submit((commandId, sequence, issuedTick) => ({ commandId, sequence, issuedTick, kind: 'build.command', payload: { command: { ...cloneJson(request), commandId } as BuildCommand } }));
  }

  /** Requested only by the work-plan inspector; never part of the universal frame projection. */
  getAutomaticWorkPreview(): DeepReadonly<ReturnType<typeof previewWorldAutomaticWork>> {
    if (this.automaticQuerySource !== this.world || !this.automaticQuery) {
      this.automaticQuerySource = this.world;
      this.automaticQuery = deepFreeze(cloneJson(previewWorldAutomaticWork(this.world)));
    }
    return this.automaticQuery;
  }

  dispatchInventoryDiscard(request: InventoryDiscardRequest, guard: InventoryDiscardGuard): InventoryDiscardCommandResult {
    if (!matchesInventoryDiscardGuard(this.world.inventory, this.sessionEpoch, request, guard)) return { ok: false, code: 'STALE_INVENTORY' };
    const result = this.submit((commandId, sequence, issuedTick) => ({ commandId, sequence, issuedTick, kind: 'inventory.discard', payload: cloneJson(request) }));
    return result.status === 'accepted' ? { ok: true } : { ok: false, code: result.rejection?.code ?? 'INVALID_COMMAND' };
  }

  dispatchSectEconomy(request: SectEconomyCommand, guard: WorkPlanEditGuard): { ok: boolean } {
    if (!matchesWorkPlanGuard(this.world.sectEconomy, this.sessionEpoch, request, guard)) return { ok: false };
    const result = this.submit((commandId, sequence, issuedTick) => ({ commandId, sequence, issuedTick, kind: 'sect-economy.command', payload: { command: cloneJson(request) } }));
    return { ok: result.status === 'accepted' };
  }

  dispatchExpedition(request: ExpeditionRequest): DeepReadonly<CommandResult> {
    return this.submit((commandId, sequence, issuedTick) => ({ commandId, sequence, issuedTick, kind: 'expedition.command', payload: { command: { ...cloneJson(request), commandId } as PlayerExpeditionCommand } }));
  }

  private departureBasis(): string {
    return stableHash({ epoch: this.sessionEpoch, cultivation: this.world.cultivation.revision, builds: this.world.builds.revision, inventory: this.world.inventory, run: this.world.expedition.run?.runId ?? null, phase: this.world.expedition.run?.phase ?? 'none', mode: this.world.clock.mode });
  }

  prepareExpedition(request: ExpeditionDepartureRequest): DeepReadonly<DepartureProposal> {
    return deepFreeze(cloneJson({ request, preview: previewWorldExpedition(this.world, request), basisStamp: this.departureBasis(), sessionEpoch: this.sessionEpoch }));
  }

  isDepartureProposalCurrent(proposal: DeepReadonly<DepartureProposal>): boolean { return proposal.sessionEpoch === this.sessionEpoch && proposal.basisStamp === this.departureBasis(); }

  confirmDeparture(proposal: DeepReadonly<DepartureProposal>): DeepReadonly<CommandResult> {
    let matchesDisplayedPreview = false;
    if (this.isDepartureProposalCurrent(proposal)) {
      try { matchesDisplayedPreview = canonicalStringify(previewWorldExpedition(this.world, cloneJson(proposal.request) as ExpeditionDepartureRequest)) === canonicalStringify(proposal.preview); }
      catch { /* Invalid copied proposals are rejected without entering the authority dispatcher. */ }
    }
    if (!matchesDisplayedPreview) {
      const sequence = this.nextSequence(this.sequence); this.sequence = sequence + 1;
      this.lastCommand = { commandId: `app-command.${sequence}`, status: 'rejected', transactionId: null, eventIds: [], rejection: this.storageReadOnly ? { code: 'CORE_PAUSED_ERROR' } : { code: 'EXPEDITION_REJECTED', expeditionCode: 'INVALID_STATE' } };
      this.publish(false); return deepFreeze(cloneJson(this.lastCommand));
    }
    return this.dispatchExpedition({ kind: 'expedition.depart', request: cloneJson(proposal.request) as ExpeditionDepartureRequest });
  }

  prepareBreakthrough(discipleId: string, preparation: BreakthroughPreparation = { method: 'standard', arraySupport: 0 }): DeepReadonly<BreakthroughProposal> {
    return deepFreeze(cloneJson({ preview: previewWorldBreakthrough(this.world, discipleId, preparation), resourceStamp: stableHash(this.world.inventory), sessionEpoch: this.sessionEpoch }));
  }

  isBreakthroughProposalCurrent(proposal: DeepReadonly<BreakthroughProposal>): boolean {
    return proposal.sessionEpoch === this.sessionEpoch && proposal.preview.stateRevision === this.world.cultivation.revision && proposal.resourceStamp === stableHash(this.world.inventory);
  }

  confirmBreakthrough(proposal: DeepReadonly<BreakthroughProposal>): DeepReadonly<CommandResult> {
    // An imported world can have the same revision/hash but is a different confirmation context.
    if (!this.isBreakthroughProposalCurrent(proposal)) {
      const sequence = this.nextSequence(this.sequence);
      this.sequence = sequence + 1;
      this.lastCommand = { commandId: `app-command.${sequence}`, status: 'rejected', transactionId: null, eventIds: [],
        rejection: this.storageReadOnly ? { code: 'CORE_PAUSED_ERROR' } : { code: 'CULTIVATION_REJECTED', cultivationCode: 'PREVIEW_STALE' } };
      this.publish(false);
      return deepFreeze(cloneJson(this.lastCommand));
    }
    // The reducer verifies the complete preview again. No UI-only risk number is trusted.
    return this.dispatchCultivation({ kind: 'breakthrough.confirm', expectedRevision: proposal.preview.stateRevision, preview: cloneJson(proposal.preview) as BreakthroughPreview });
  }

  setSpeed(speed: SimulationSpeed): void {
    if (this.storageReadOnly || this.overlayPaused || this.invariantStopped) return;
    if (this.world.clock.speed === speed) return;
    this.world = { ...this.world, clock: setClockSpeed(this.world.clock, speed) };
    this.resetFrameBaseline();
    this.publish();
  }

  /** A UI pause must not push a valid imported save past its byte ceiling. */
  private withSafePause(world: WorldState, reason: PauseReason, paused: boolean): WorldState {
    this.ephemeralPauses.delete(reason);
    const candidate = { ...world, clock: setPauseReason(world.clock, reason, paused) };
    if (!paused || measureWorldSaveBytes(candidate, { saveVersion: 7 }) <= SAVE_FILE_LIMIT_BYTES) return candidate;
    this.ephemeralPauses.add(reason);
    return world;
  }

  setPaused(reason: PauseReason, paused: boolean): void {
    if (reason === 'player' && (this.storageReadOnly || this.overlayPaused || this.invariantStopped)) return;
    if ((this.world.clock.pauseReasons.includes(reason) || this.ephemeralPauses.has(reason)) === paused) return;
    this.world = this.withSafePause(this.world, reason, paused);
    this.resetFrameBaseline();
    this.publish();
  }

  togglePlayerPause(): void { this.setPaused('player', !(this.world.clock.pauseReasons.includes('player') || this.ephemeralPauses.has('player'))); }

  setForeground(next: Partial<{ visible: boolean; focused: boolean }>): void {
    this.foreground = { ...this.foreground, ...next };
    this.resetFrameBaseline();
    this.setPaused('hidden', !this.foreground.visible || !this.foreground.focused);
  }

  /** A writer-lease pause belongs to this browser session and must not poison an exported campaign. */
  setStorageReadOnly(readOnly: boolean): void {
    if (this.storageReadOnly === readOnly) return;
    this.storageReadOnly = readOnly;
    this.resetFrameBaseline();
    this.publish(false);
  }

  /** App owns one overlay hold. It never becomes campaign authority or persisted save data. */
  setOverlayPaused(paused: boolean): void {
    if (this.overlayPaused === paused) return;
    this.overlayPaused = paused;
    this.resetFrameBaseline();
    this.publish(false);
  }

  resetFrameBaseline(): void { this.baseline = null; }

  /** Timestamp comes only from the platform adapter, never from Phaser or the core. */
  frame(timestamp: number): void {
    if (!Number.isFinite(timestamp)) return;
    if (isPaused(this.world.clock) || this.storageReadOnly || this.overlayPaused || this.capacityStop || this.ephemeralPauses.size > 0 || this.invariantStopped) { this.baseline = null; return; }
    if (this.baseline === null || timestamp < this.baseline) { this.baseline = timestamp; return; }
    const elapsed = timestamp - this.baseline;
    this.baseline = timestamp;
    const accumulated = accumulateFrame(this.accumulator, elapsed, this.world.clock, 20);
    this.accumulator = accumulated.accumulator;
    if (accumulated.ticks === 0) return;
    const result = advanceTicksWithStatus(this.world, accumulated.ticks);
    this.world = result.world;
    this.capacityStop = result.capacityStop;
    this.invariantStopped = result.invariantStop !== null;
    if (this.capacityStop || this.invariantStopped) this.resetFrameBaseline();
    this.publish();
  }

  /** Loading discards wall time, removes stale hidden state and preserves all safety pauses. */
  replaceWorld(world: WorldState): void {
    let owned = this.ownWorld(world);
    this.ephemeralPauses.clear();
    owned = this.withSafePause(owned, 'hidden', !this.foreground.visible || !this.foreground.focused);
    owned = this.withSafePause(owned, 'player', true);
    this.world = owned;
    this.sessionEpoch += 1;
    this.capacityStop = null;
    this.invariantStopped = false;
    this.sequence = this.nextSequence();
    this.lastCommand = null;
    this.selection = owned.disciples[1] ? { kind: 'disciple', id: owned.disciples[1].id } : null;
    this.accumulator = createFrameAccumulator();
    this.resetFrameBaseline();
    this.publish();
  }
}
