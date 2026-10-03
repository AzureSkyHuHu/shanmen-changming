import { RELOCATION_OWNER_PHASES, type RelocationOwnerBoundary, type RelocationOwnerPhase } from './types';

export type RelocationHistoryDomain = 'construction' | 'relocation' | 'research';
/** A domain receipt revision orders only that domain's commands. All external
 * commands run after the complete tick; unrelated command revisions are incomparable. */
export interface RelocationHistoryEdge {
  readonly tick: number;
  readonly stage: number;
  readonly domain: RelocationHistoryDomain;
  readonly revision: number;
}
export interface RelocationHistoryInterval {
  readonly start: RelocationHistoryEdge;
  readonly end: RelocationHistoryEdge | null;
}
export const relocationHistoryCommandEdge = (tick: number, domain: RelocationHistoryDomain, revision: number): RelocationHistoryEdge =>
  ({ tick, stage: RELOCATION_OWNER_PHASES.length, domain, revision });
export const relocationHistoryCompletionEdge = (tick: number, domain: RelocationHistoryDomain, revision = 0): RelocationHistoryEdge =>
  ({ tick, stage: RELOCATION_OWNER_PHASES.indexOf(domain), domain, revision });
export function compareRelocationHistoryEdges(a: RelocationHistoryEdge, b: RelocationHistoryEdge): number | null {
  if (a.tick !== b.tick) return a.tick < b.tick ? -1 : 1;
  if (a.stage !== b.stage) return a.stage < b.stage ? -1 : 1;
  if (a.domain !== b.domain) return null;
  return a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0;
}
/** Half-open endpoints require actual phases/receipts. A same-tick cancellation
 * and another domain's start never manufacture a zero-length free interval. */
export function relocationHistoryIntersection(a: RelocationHistoryInterval, b: RelocationHistoryInterval): 'none' | 'overlap' | 'ambiguous' {
  const left = a.end === null ? 1 : compareRelocationHistoryEdges(a.end, b.start);
  const right = b.end === null ? 1 : compareRelocationHistoryEdges(b.end, a.start);
  if (left !== null && left <= 0 || right !== null && right <= 0) return 'none';
  return left === null || right === null ? 'ambiguous' : 'overlap';
}
export function relocationHistoryPhasePassed(tick: number, phase: RelocationOwnerPhase, boundary: RelocationOwnerBoundary): boolean {
  return tick < boundary.tick || tick === boundary.tick && (RELOCATION_OWNER_PHASES.indexOf(phase) < RELOCATION_OWNER_PHASES.indexOf(boundary.phase)
    || phase === boundary.phase && boundary.side === 'after');
}
