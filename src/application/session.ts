import {
  accumulateFrame, advanceTicks, CALENDAR_TICKS_PER_MONTH, cloneJson,
  createFrameAccumulator, createWorld, dispatchCommand, isPaused, RESOURCE_IDS,
  setClockSpeed, setPauseReason, validateWorldState,
  type Command, type CommandResult, type Disciple, type DomainEvent, type PauseReason,
  type ProductionTransaction, type SimulationSpeed, type WorldBuilding, type WorldMap, type WorldState,
} from '../core/kernel';

export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type Selection = { kind: 'disciple' | 'building'; id: string } | null;
export type SessionCommand = Pick<Extract<Command, { kind: 'production.start' }>, 'kind' | 'payload'> | Pick<Extract<Command, { kind: 'production.cancel' }>, 'kind' | 'payload'>;
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
}
export interface SessionProjection {
  revision: number;
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
  selection: Selection;
  lastCommand: CommandResult | null;
  paused: boolean;
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
  private sequence = 0;
  private baseline: number | null = null;
  private accumulator = createFrameAccumulator();
  private foreground = { visible: true, focused: true };
  private storageReadOnly = false;
  private snapshot: DeepReadonly<SessionProjection>;

  constructor(world = createWorld()) {
    this.world = this.ownWorld(world);
    this.selection = this.world.disciples[1] ? { kind: 'disciple', id: this.world.disciples[1].id } : null;
    this.sequence = this.nextSequence();
    this.snapshot = this.project();
  }

  private ownWorld(world: WorldState): WorldState {
    const errors = validateWorldState(world);
    if (errors.length) throw new TypeError('Invalid session world');
    return cloneJson(world);
  }

  private nextSequence(start = 0): number {
    // Receipt IDs are untrusted save content; do not turn a huge numeric suffix into Infinity.
    const occupied = new Set([...Object.keys(this.world.commandReceipts), ...this.world.pendingCommands.map((command) => command.commandId)]);
    let next = start;
    while (occupied.has(`app-command.${next}`)) next += 1;
    return next;
  }

  private project(): DeepReadonly<SessionProjection> {
    const elapsedMonths = Math.floor(this.world.clock.calendarTick / CALENDAR_TICKS_PER_MONTH);
    const recentEvents = this.world.events.slice(-5).reverse();
    // Historical transaction receipts stay in World for idempotency, not in every UI frame.
    const visibleTransactionIds = new Set<string>();
    for (const disciple of this.world.disciples) if (disciple.assignmentTransactionId) visibleTransactionIds.add(disciple.assignmentTransactionId);
    for (const event of recentEvents) if (typeof event.payload.transactionId === 'string') visibleTransactionIds.add(event.payload.transactionId);
    const visibleTransactions = [...visibleTransactionIds].map((id) => this.world.transactions[id]).filter((transaction): transaction is ProductionTransaction => transaction !== undefined);
    return deepFreeze(cloneJson({
      revision: this.revision, worldRevision: this.worldRevision, seed: this.world.seed,
      clock: this.storageReadOnly ? setPauseReason(this.world.clock, 'danger', true) : this.world.clock,
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
      })),
      selection: this.selection, lastCommand: this.lastCommand, paused: isPaused(this.world.clock) || this.storageReadOnly,
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

  exportWorld(): WorldState { return cloneJson(this.world); }

  select(selection: Selection): void {
    if (selection && !(selection.kind === 'disciple' ? this.world.disciples : this.world.buildings).some((entity) => entity.id === selection.id)) return;
    if (selection?.kind === this.selection?.kind && selection?.id === this.selection?.id) return;
    this.selection = selection ? { ...selection } : null;
    this.publish(false);
  }

  dispatch(request: SessionCommand): DeepReadonly<CommandResult> {
    const sequence = this.nextSequence(this.sequence);
    this.sequence = sequence + 1;
    if (this.storageReadOnly) {
      this.lastCommand = { commandId: `app-command.${sequence}`, status: 'rejected', transactionId: null, eventIds: [], rejection: { code: 'CORE_PAUSED_ERROR' } };
      this.publish(false);
      return deepFreeze(cloneJson(this.lastCommand));
    }
    const command = { ...cloneJson(request), commandId: `app-command.${sequence}`, sequence, issuedTick: this.world.clock.simulationTick } as Command;
    const outcome = dispatchCommand(this.world, command);
    this.world = outcome.world;
    this.lastCommand = outcome.result;
    this.publish();
    return deepFreeze(cloneJson(outcome.result));
  }

  setSpeed(speed: SimulationSpeed): void {
    if (this.world.clock.speed === speed) return;
    this.world = { ...this.world, clock: setClockSpeed(this.world.clock, speed) };
    this.resetFrameBaseline();
    this.publish();
  }

  setPaused(reason: PauseReason, paused: boolean): void {
    if (this.world.clock.pauseReasons.includes(reason) === paused) return;
    this.world = { ...this.world, clock: setPauseReason(this.world.clock, reason, paused) };
    this.resetFrameBaseline();
    this.publish();
  }

  togglePlayerPause(): void { this.setPaused('player', !this.world.clock.pauseReasons.includes('player')); }

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

  resetFrameBaseline(): void { this.baseline = null; }

  /** Timestamp comes only from the platform adapter, never from Phaser or the core. */
  frame(timestamp: number): void {
    if (!Number.isFinite(timestamp)) return;
    if (isPaused(this.world.clock) || this.storageReadOnly) { this.baseline = null; return; }
    if (this.baseline === null || timestamp < this.baseline) { this.baseline = timestamp; return; }
    const elapsed = timestamp - this.baseline;
    this.baseline = timestamp;
    const accumulated = accumulateFrame(this.accumulator, elapsed, this.world.clock, 20);
    this.accumulator = accumulated.accumulator;
    if (accumulated.ticks === 0) return;
    this.world = advanceTicks(this.world, accumulated.ticks);
    this.publish();
  }

  /** Loading discards wall time, removes stale hidden state and preserves all safety pauses. */
  replaceWorld(world: WorldState): void {
    const owned = this.ownWorld(world);
    owned.clock = setPauseReason(owned.clock, 'player', true);
    owned.clock = setPauseReason(owned.clock, 'hidden', !this.foreground.visible || !this.foreground.focused);
    this.world = owned;
    this.sequence = this.nextSequence();
    this.lastCommand = null;
    this.selection = owned.disciples[1] ? { kind: 'disciple', id: owned.disciples[1].id } : null;
    this.accumulator = createFrameAccumulator();
    this.resetFrameBaseline();
    this.publish();
  }
}
