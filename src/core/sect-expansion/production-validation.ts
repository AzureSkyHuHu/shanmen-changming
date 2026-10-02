import { SECT_PRODUCTION_DESCRIPTOR_NODE_BOUND, SECT_PRODUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND } from './descriptor-bounds';
export { SECT_PRODUCTION_DESCRIPTOR_NODE_BOUND, SECT_PRODUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND } from './descriptor-bounds';
import { isLedgerDataArray, isLedgerDataRecord } from '../economy/ledger-operations';
import { validateConstructionFrame } from './construction-validation';
import { ownSectFields } from './layout';
import type { SectProductionFrame, SectProductionValidationIssue } from './production-types';
import { validateUngatedSectProductionRecords, validateSectProductionReceipts } from './production-runtime';
export { isSectProductionCommand, sectProductionSites } from './production-runtime';
const fields = ownSectFields;
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
  const local = validateUngatedSectProductionRecords(frame);
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
