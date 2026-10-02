import { SECT_V9_CANDIDATE_IDENTITY } from '../../content/sect-v9/catalog';
import type { WorkPathBudget } from '../agents/work-navigation';
import { cloneJson } from '../kernel/serialization';
import { ownSectFields } from './layout';
import type { SectPlacementRequest } from './types';
import type { ConstructionCommand, ConstructionContext, ConstructionFrame, ConstructionRejection, ConstructionResult, ConstructionSeed } from './construction-types';
import { isConstructionCommand, validateConstructionContext, validateConstructionFrame } from './construction-validation';
import { applyValidatedConstructionCommand, previewValidatedConstructionPlacement, tickValidatedConstruction } from './construction-runtime';
export { constructionClaims, constructionEffectiveMap } from './construction-runtime';

const MAX = Number.MAX_SAFE_INTEGER;
const rejected = (frame: ConstructionFrame, code: ConstructionRejection): ConstructionResult => ({ ok: false, frame, code });
const accepted = (frame: ConstructionFrame, relatedId: string | null = null, repeated = false): ConstructionResult => ({ ok: true, frame, relatedId, repeated });
function current(frame: ConstructionFrame, context: ConstructionContext): ConstructionRejection | null {
  if (validateConstructionFrame(frame).length) return 'INVALID_FRAME';
  if (!validateConstructionContext(context)) return 'INVALID_CONTEXT';
  if (context.simulationTick !== frame.lastSimulationTick || context.calendarTick !== frame.lastCalendarTick) return 'STALE_CLOCK';
  return null;
}
function publish(source: ConstructionFrame, candidate: ConstructionFrame, relatedId: string | null): ConstructionResult {
  // Each outstanding blueprint has one real cancellation command left. Tick/command publication
  // may spend this headroom only if its own actual terminal evidence discharges an obligation.
  const cancellations = candidate.blueprints.filter(bp => bp.status === 'planned' || bp.status === 'started').length;
  if (candidate.revision > MAX - cancellations) return rejected(source, 'CAPACITY_EXCEEDED');
  if (validateConstructionFrame(candidate).length) return rejected(source, 'INVALID_FRAME');
  return accepted(cloneJson(candidate), relatedId);
}
export function createConstructionFrame(seed: ConstructionSeed): ConstructionFrame {
  if (!ownSectFields(seed, ['map', 'legacyStations', 'people', 'ledger', 'simulationTick', 'calendarTick'])) throw new RangeError('Invalid construction seed');
  const frame: ConstructionFrame = { schemaVersion: 1, catalogIdentity: SECT_V9_CANDIDATE_IDENTITY, revision: 0, nextId: 1,
    lastSimulationTick: seed.simulationTick, lastCalendarTick: seed.calendarTick, map: seed.map, legacyStations: seed.legacyStations,
    people: seed.people, ledger: seed.ledger, blueprints: [], jobs: [], buildings: [], receipts: [] };
  if (validateConstructionFrame(frame).length) throw new RangeError('Invalid construction seed');
  return cloneJson(frame);
}
/** Prediction only. Neither this result nor any command can certify research, money or completed work. */
export function previewConstructionPlacement(frame: ConstructionFrame, context: ConstructionContext, request: SectPlacementRequest): ConstructionResult {
  const problem = current(frame, context);
  if (problem) return rejected(frame, problem);
  return previewValidatedConstructionPlacement(frame, context, request);
}
/** Public command admission remains strict, ungated and independent of future research authority. */
export function applyConstructionCommand(frame: ConstructionFrame, context: ConstructionContext, command: ConstructionCommand): ConstructionResult {
  const problem = current(frame, context);
  if (problem) return rejected(frame, problem);
  if (!isConstructionCommand(command)) return rejected(frame, 'INVALID_COMMAND');
  const result = applyValidatedConstructionCommand(frame, context, command);
  if (!result.ok || result.repeated) return result;
  return publish(frame, result.frame, result.relatedId);
}
/** One true management boundary. The caller creates ONE budget per tick shared with all work domains. */
export function tickConstruction(frame: ConstructionFrame, context: ConstructionContext, budget: WorkPathBudget): ConstructionResult {
  if (validateConstructionFrame(frame).length) return rejected(frame, 'INVALID_FRAME');
  if (!validateConstructionContext(context)) return rejected(frame, 'INVALID_CONTEXT');
  if (context.simulationTick === frame.lastSimulationTick && context.calendarTick === frame.lastCalendarTick) return accepted(frame, null, true);
  if (context.paused || context.simulationTick <= frame.lastSimulationTick || context.calendarTick < frame.lastCalendarTick) return rejected(frame, 'STALE_CLOCK');
  if (context.simulationTick !== frame.lastSimulationTick + 1 || context.calendarTick !== frame.lastCalendarTick + (context.mode === 'management' ? 1 : 0)) return rejected(frame, 'CLOCK_GAP');
  if (!budget || budget.simulationTick !== context.simulationTick) return rejected(frame, 'INVALID_CONTEXT');
  const result = tickValidatedConstruction(frame, context, budget);
  if (!result.ok) return result;
  return publish(frame, result.frame, result.relatedId);
}
