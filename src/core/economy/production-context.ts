import { cardinalDistance, emptyNavigation, isWalkable, sameCell, type JobNavigation } from '../agents/navigation';
import { advanceWorkNavigationWithBudget, createWorkPathBudget, type WorkPathBudget } from '../agents/work-navigation';
import { compareStable } from '../kernel/serialization';
import type { GridPosition, WorldMap } from '../world/types';
import type { ProductionBlockedReason, ProductionPhase, TransactionState } from './types';

/** Progress only: no inventory, reservation, recipe cost, origin or terminal proof. */
export interface ProductionProgress {
  transactionId: string;
  recipeId: string;
  workerId: string;
  state: TransactionState;
  activeTicks: number;
  requiredTicks: number;
  startedTick: number;
  blockedReason: ProductionBlockedReason | null;
  phase: ProductionPhase;
  worksiteId: string | null;
  storageId: string | null;
  navigation: JobNavigation;
}

export interface ProductionWorker {
  position: GridPosition;
  lifeState: 'alive' | 'pendingDeath' | 'dead';
  canWork: boolean;
  assignmentTransactionId: string | null;
}

/** The usable external position, never an entity's footprint/anchor by implication. */
export interface ProductionSite {
  id: string;
  position: GridPosition;
  ownerTransactionId: string | null;
}
export interface ProductionRecipe { workstation: string }
export type ProductionSettlement<State> = { ok: true; world: State } | { ok: false; rejection: { code: string } };

/**
 * Trusted internal, fixed adapter binding; never supplied by a command, content
 * record or save. Every read takes the current candidate, including after an
 * earlier job releases a seat or settles. The owning version alone authorizes
 * admission, canonical recipes/jobs, eligible sites, receipts and settlement.
 * This port is deliberately absent from player commands and kernel exports.
 */
export interface ProductionContext<State, Job extends ProductionProgress> {
  view(state: State): { simulationTick: number; management: boolean; paused: boolean; map: WorldMap; activeTransactionIds: readonly string[] };
  job(state: State, transactionId: string): Job;
  recipe(state: State, recipeId: string): ProductionRecipe | undefined;
  worker(state: State, workerId: string): ProductionWorker | undefined;
  workSites(state: State, recipe: ProductionRecipe): readonly ProductionSite[];
  storageSites(state: State): readonly ProductionSite[];
  writeProgress(state: State, job: Job, traveling?: boolean, position?: GridPosition): State;
  claimSite(state: State, siteId: string, transactionId: string): State;
  releaseSites(state: State, transactionId: string): State;
  /** Emits only the version's notice; the runner applies the blocked progress. */
  blockedNotice(state: State, job: Job, reason: ProductionBlockedReason): State;
  cancel(state: State, transactionId: string): ProductionSettlement<State>;
  complete(state: State, transactionId: string): ProductionSettlement<State>;
}

function running<Job extends ProductionProgress>(job: Job): Job { return { ...job, state: 'Running', blockedReason: null }; }
function candidates(sites: readonly ProductionSite[], position: GridPosition): ProductionSite[] {
  return [...sites].sort((left, right) => cardinalDistance(position, left.position) - cardinalDistance(position, right.position) || compareStable(left.id, right.id));
}
function block<State, Job extends ProductionProgress>(state: State, job: Job, reason: ProductionBlockedReason, context: ProductionContext<State, Job>): State {
  const next = job.blockedReason !== reason ? context.blockedNotice(state, job, reason) : state;
  return context.writeProgress(next, { ...job, state: 'Blocked', blockedReason: reason });
}
/** Arrival is a full movement boundary and never awards work in the same tick. */
function travel<State, Job extends ProductionProgress>(state: State, job: Job, target: GridPosition, budget: WorkPathBudget, context: ProductionContext<State, Job>): State {
  const worker = context.worker(state, job.workerId)!;
  const view = context.view(state);
  const effect = advanceWorkNavigationWithBudget({ map: view.map, position: worker.position, target,
    navigation: job.navigation, simulationTick: view.simulationTick }, budget);
  if (effect.status === 'path-blocked') return block(state, { ...job, navigation: effect.navigation }, 'PATH_BLOCKED', context);
  if (effect.status === 'path-budget-exhausted') {
    return context.writeProgress(state, { ...(job.blockedReason === 'PATH_BLOCKED' ? job : running(job)), navigation: effect.navigation });
  }
  return context.writeProgress(state, { ...running(job),
    phase: effect.status === 'arrived' ? job.phase === 'TravellingToWork' ? 'Working' : 'AwaitingDelivery' : job.phase,
    navigation: effect.navigation }, effect.traveling, effect.position ?? undefined);
}

/** Shared phase logic only; no resource meaning, command admission or terminal authority. */
export function runProductionPhases<State, Job extends ProductionProgress>(state: State, context: ProductionContext<State, Job>, sharedPathBudget?: WorkPathBudget): State {
  const view = context.view(state);
  if (!view.management || view.paused) return state;
  let next = state;
  const budget = sharedPathBudget ?? createWorkPathBudget(view.simulationTick);
  if (budget.simulationTick !== view.simulationTick) throw new RangeError('Path budget belongs to another tick');
  const ids = [...view.activeTransactionIds].sort((left, right) => context.job(state, left).startedTick - context.job(state, right).startedTick || compareStable(left, right));
  for (const id of ids) {
    let job = context.job(next, id);
    if (job.state !== 'Running' && job.state !== 'Blocked') continue;
    const worker = context.worker(next, job.workerId);
    const recipe = context.recipe(next, job.recipeId);
    if (!recipe) throw new Error('Production references a missing recipe');
    if (!worker || worker.lifeState === 'dead') {
      const cancelled = context.cancel(next, id);
      if (!cancelled.ok) throw new Error('Cannot release unavailable worker reservation');
      next = cancelled.world;
      continue;
    }
    if (worker.assignmentTransactionId !== id) throw new Error('Production worker assignment mismatch');
    if (!worker.canWork) {
      next = context.releaseSites(next, id);
      job = { ...job, phase: job.activeTicks === job.requiredTicks ? 'TravellingToStorage' : 'WaitingForStation', worksiteId: null, navigation: emptyNavigation() };
      next = block(next, job, 'WORKER_UNAVAILABLE', context);
      continue;
    }
    if (job.activeTicks === job.requiredTicks && job.phase !== 'TravellingToStorage' && job.phase !== 'AwaitingDelivery') {
      next = context.releaseSites(next, id);
      job = { ...running(job), phase: 'TravellingToStorage', navigation: emptyNavigation() };
    }
    if (job.phase === 'WaitingForStation') {
      const sites = candidates(context.workSites(next, recipe), worker.position);
      const station = sites.find(site => site.ownerTransactionId === null || site.ownerTransactionId === id);
      if (!station) { next = block(next, job, sites.length ? 'WAITING_FOR_STATION' : 'WORKSTATION_UNAVAILABLE', context); continue; }
      next = context.claimSite(next, station.id, id);
      job = { ...running(job), phase: 'TravellingToWork', worksiteId: station.id, navigation: emptyNavigation() };
    }
    if (job.phase === 'TravellingToWork' || job.phase === 'Working') {
      const station = context.workSites(next, recipe).find(site => site.id === job.worksiteId && site.ownerTransactionId === id);
      if (!station) {
        next = context.releaseSites(next, id);
        next = block(next, { ...job, phase: 'WaitingForStation', worksiteId: null, navigation: emptyNavigation() }, 'WORKSTATION_UNAVAILABLE', context);
        continue;
      }
      if (job.phase === 'TravellingToWork' || !sameCell(worker.position, station.position) || !isWalkable(context.view(next).map, station.position)) {
        next = travel(next, { ...job, phase: 'TravellingToWork' }, station.position, budget, context);
        continue;
      }
      const activeTicks = Math.min(job.activeTicks + 1, job.requiredTicks);
      job = { ...running(job), activeTicks };
      if (activeTicks === job.requiredTicks) {
        next = context.releaseSites(next, id);
        job = { ...job, phase: 'TravellingToStorage', navigation: emptyNavigation() };
      }
      next = context.writeProgress(next, job);
      continue;
    }
    if (job.phase === 'TravellingToStorage' || job.phase === 'AwaitingDelivery') {
      const sites = context.storageSites(next);
      const storage = sites.find(site => site.id === job.storageId) ?? candidates(sites, worker.position)[0];
      if (!storage) { next = block(next, { ...job, phase: 'TravellingToStorage', storageId: null, navigation: emptyNavigation() }, 'STORAGE_UNAVAILABLE', context); continue; }
      const changedStorage = job.storageId !== storage.id;
      job = { ...job, storageId: storage.id, ...(changedStorage ? { phase: 'TravellingToStorage' as const, navigation: emptyNavigation() } : {}) };
      if (job.phase === 'TravellingToStorage' || !sameCell(worker.position, storage.position) || !isWalkable(context.view(next).map, storage.position)) {
        next = travel(next, { ...job, phase: 'TravellingToStorage' }, storage.position, budget, context);
        continue;
      }
      next = context.writeProgress(next, job);
      const completion = context.complete(next, id);
      if (completion.ok) next = completion.world;
      else if (completion.rejection.code === 'CAPACITY_EXCEEDED') next = block(next, job, 'CAPACITY_EXCEEDED', context);
      else throw new Error(`Cannot commit production: ${completion.rejection.code}`);
    }
  }
  return next;
}
