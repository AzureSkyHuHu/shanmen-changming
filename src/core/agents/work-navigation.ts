import { BLOCKED_PATH_RETRY_TICKS, cardinalDistance, emptyNavigation, findCardinalPath, isWalkable,
  MAX_PATH_REQUESTS_PER_TICK, MOVEMENT_TICKS_PER_CELL, sameCell, type JobNavigation } from './navigation';
import { checkedAdd, isNonNegativeInteger } from '../kernel/numeric';
import type { GridPosition, WorldMap } from '../world/types';

/** The owning World bridge supplies its validated effective map and real worker position. */
export interface WorkNavigationInput {
  map: WorldMap;
  position: GridPosition;
  target: GridPosition;
  navigation: JobNavigation;
  simulationTick: number;
}

export interface WorkNavigationEffect {
  status: 'moving' | 'arrived' | 'path-blocked' | 'path-budget-exhausted';
  navigation: JobNavigation;
  /** Null means remain in the current cell, including a same-cell arrival. */
  position: GridPosition | null;
  traveling: boolean;
  pathRequestsUsed: 0 | 1;
}

function integerPosition(value: GridPosition | null | undefined): value is GridPosition {
  return value !== null && value !== undefined && Number.isSafeInteger(value.x) && Number.isSafeInteger(value.y);
}

function assertInput(input: WorkNavigationInput, pathRequestsRemaining: number): void {
  if (!input || typeof input !== 'object') throw new RangeError('Invalid work navigation input');
  const { map, navigation } = input;
  if (!isNonNegativeInteger(input.simulationTick) || !isNonNegativeInteger(pathRequestsRemaining)
    || pathRequestsRemaining > MAX_PATH_REQUESTS_PER_TICK || !map || !isNonNegativeInteger(map.navVersion)
    || !Number.isSafeInteger(map.width) || map.width < 1 || map.width > 256
    || !Number.isSafeInteger(map.height) || map.height < 1 || map.height > 256 || !Array.isArray(map.tiles) || map.tiles.length > map.width * map.height
    || !integerPosition(input.position) || !integerPosition(input.target) || !navigation
    || !Array.isArray(navigation.path) || navigation.path.length > map.width * map.height
    || Array.from(navigation.path).some(cell => !integerPosition(cell)) || !(navigation.target === null || integerPosition(navigation.target))
    || !(navigation.routeVersion === null || isNonNegativeInteger(navigation.routeVersion))
    || !isNonNegativeInteger(navigation.movementTicks) || navigation.movementTicks >= MOVEMENT_TICKS_PER_CELL
    || !isNonNegativeInteger(navigation.retryAtTick)) throw new RangeError('Invalid work navigation input');
}

/**
 * One pure travel tick, using the existing north/east/south/west path finder.
 * Arrival is a full movement boundary: this port never awards productive work,
 * acquires a seat, changes a job phase, or authorizes a World action.
 * The versioned bridge retains those decisions and applies these explicit effects.
 */
export function advanceWorkNavigation(input: WorkNavigationInput, pathRequestsRemaining: number): WorkNavigationEffect {
  assertInput(input, pathRequestsRemaining);
  const { map, position: origin, target, simulationTick } = input;
  let navigation = { ...input.navigation, path: input.navigation.path.map(cell => ({ ...cell })),
    target: input.navigation.target === null ? null : { ...input.navigation.target } };
  const targetChanged = navigation.target === null || !sameCell(navigation.target, target);
  const versionChanged = navigation.routeVersion !== map.navVersion;
  const first = navigation.path[0];
  const invalidStep = first !== undefined && (!isWalkable(map, first) || cardinalDistance(origin, first) !== 1);
  if (targetChanged || versionChanged || invalidStep) navigation = { ...emptyNavigation(), target: { x: target.x, y: target.y } };
  if (!isWalkable(map, origin) || !isWalkable(map, target)) {
    return { status: 'path-blocked', navigation: { ...navigation, path: [], routeVersion: map.navVersion,
      movementTicks: 0, retryAtTick: checkedAdd(simulationTick, BLOCKED_PATH_RETRY_TICKS) },
    position: null, traveling: false, pathRequestsUsed: 0 };
  }
  if (sameCell(origin, target)) {
    return { status: 'arrived', navigation: emptyNavigation(), position: null, traveling: false, pathRequestsUsed: 0 };
  }
  let pathRequestsUsed: 0 | 1 = 0;
  if (navigation.path.length === 0) {
    if (simulationTick < navigation.retryAtTick) return { status: 'path-blocked', navigation, position: null, traveling: false, pathRequestsUsed };
    if (pathRequestsRemaining === 0) return { status: 'path-budget-exhausted', navigation, position: null, traveling: false, pathRequestsUsed };
    pathRequestsUsed = 1;
    const path = findCardinalPath(map, origin, target);
    navigation = { ...navigation, target: { x: target.x, y: target.y }, routeVersion: map.navVersion,
      path: path ?? [], movementTicks: 0, retryAtTick: path ? 0 : checkedAdd(simulationTick, BLOCKED_PATH_RETRY_TICKS) };
    if (!path) return { status: 'path-blocked', navigation, position: null, traveling: false, pathRequestsUsed };
  }
  const movementTicks = navigation.movementTicks + 1;
  if (movementTicks < MOVEMENT_TICKS_PER_CELL) {
    return { status: 'moving', navigation: { ...navigation, movementTicks }, position: null, traveling: true, pathRequestsUsed };
  }
  const position = navigation.path[0]!;
  const path = navigation.path.slice(1);
  const arrived = sameCell(position, target);
  return { status: arrived ? 'arrived' : 'moving', navigation: arrived ? emptyNavigation() : { ...navigation, path, movementTicks: 0 },
    position, traveling: !arrived, pathRequestsUsed };
}

/**
 * Ephemeral, non-serialized budget owned by the internal management-tick
 * orchestrator. Create once per tick and share it across all work modules in
 * their explicit order. It cannot be replenished, carried into another tick,
 * or used as evidence that a worker/job/action is authorized.
 */
class TickPathBudget {
  readonly #simulationTick: number;
  #remaining = MAX_PATH_REQUESTS_PER_TICK;

  constructor(simulationTick: number) {
    if (!isNonNegativeInteger(simulationTick)) throw new RangeError('Invalid path budget tick');
    this.#simulationTick = simulationTick;
    Object.freeze(this);
  }

  get simulationTick(): number { return this.#simulationTick; }
  get remaining(): number { return this.#remaining; }

  static advance(input: WorkNavigationInput, budget: TickPathBudget): WorkNavigationEffect {
    if (!budget || typeof budget !== 'object' || !(#remaining in budget)) throw new RangeError('Invalid path budget');
    if (!input || input.simulationTick !== budget.#simulationTick) throw new RangeError('Path budget belongs to another tick');
    const effect = advanceWorkNavigation(input, budget.#remaining);
    budget.#remaining -= effect.pathRequestsUsed;
    return effect;
  }
}

export type WorkPathBudget = TickPathBudget;
export function createWorkPathBudget(simulationTick: number): WorkPathBudget { return new TickPathBudget(simulationTick); }
/** Only factory-created budgets are accepted; no caller-supplied callback can author movement. */
export function advanceWorkNavigationWithBudget(input: WorkNavigationInput, budget: WorkPathBudget): WorkNavigationEffect {
  return TickPathBudget.advance(input, budget);
}
