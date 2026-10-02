import { isLedgerDataArray, isLedgerDataRecord } from '../economy/ledger-operations';
import { CONSTRUCTION_DESCRIPTOR_NODE_BOUND, validateConstructionFrame } from './construction-validation';
import { ownSectFields } from './layout';
import { SECT_PRODUCTION_LIMITS, type SectProductionFrame, type SectProductionValidationIssue } from './production-types';
import { validateSectProductionRecords, validateSectProductionReceipts } from './production-runtime';
export { isSectProductionCommand, sectProductionSites } from './production-runtime';
const fields = ownSectFields;
/** Construction's bound already covers the single map/people/both ledgers and every claim.
 * Each production record allows all 240 disjoint five-node spans, fixed proof/terminal fields,
 * and its navigation header. Only 36 live jobs may retain 65,536 three-node route cells.
 * Conservative independent maxima ensure adding any admitted cancellation cannot exceed this
 * reader gate. This is a LOCAL structural bound, never the eventual whole-World save budget.
 */
export const SECT_PRODUCTION_DESCRIPTOR_NODE_BOUND = CONSTRUCTION_DESCRIPTOR_NODE_BOUND
  + 16 + SECT_PRODUCTION_LIMITS.records * (256 + SECT_PRODUCTION_LIMITS.maximumWorkTicks * 5)
  + SECT_PRODUCTION_LIMITS.activeJobs * 65536 * 3 + SECT_PRODUCTION_LIMITS.receipts * 12;
function plainTree(value: unknown, depth = 0, budget = { left: SECT_PRODUCTION_DESCRIPTOR_NODE_BOUND }): boolean {
  if (--budget.left < 0 || depth > 24) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value === 'string') return value.length <= 256;
  if (Array.isArray(value)) return isLedgerDataArray(value) && value.length <= 65536 && value.every(child => plainTree(child, depth + 1, budget));
  return isLedgerDataRecord(value) && Object.values(value as Record<string, unknown>).every(child => plainTree(child, depth + 1, budget));
}
/** Strict public two-domain validator. Research reservations are deliberately rejected. */
export function validateSectProductionFrame(input: unknown): readonly SectProductionValidationIssue[] {
  const fail = (code: string, path: string): readonly SectProductionValidationIssue[] => [{ code, path }];
  if (!plainTree(input) || !fields(input, ['schemaVersion', 'construction', 'production']) || input.schemaVersion !== 1) return fail('INVALID_SHAPE', 'frame');
  const frame = input as unknown as SectProductionFrame;
  const constructionIssues = validateConstructionFrame(frame.construction);
  if (constructionIssues.length) return constructionIssues.map(issue => ({ ...issue, path: `construction.${issue.path}` }));
  const local = validateSectProductionRecords(frame);
  if (local.length) return local;
  const authority = frame.construction; const domain = frame.production;
  // This slice has exactly two new-domain reservation owners. Legacy reservations stay only in
  // the existing base aggregate and must be authenticated by a future World projection.
  for (const claim of authority.ledger.reservations) {
    const owners = authority.jobs.filter(job => job.jobId === claim.ownerTransactionId && job.reservationId === claim.reservationId).length
      + domain.jobs.filter(job => job.transactionId === claim.ownerTransactionId && job.reservationId === claim.reservationId).length;
    if (owners !== 1) return fail('ORPHAN_RESERVATION', claim.reservationId);
  }
  return validateSectProductionReceipts(frame);
}
