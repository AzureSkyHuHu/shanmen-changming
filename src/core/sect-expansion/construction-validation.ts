import type { ConstructionValidationIssue } from './construction-types';
import { validateUngatedConstructionRecords } from './construction-record-validation';
export { CONSTRUCTION_DESCRIPTOR_NODE_BOUND, isConstructionCommand, validateConstructionContext } from './construction-record-validation';

/** Strict public boundary. No caller can supply research authority to this entry point. */
export function validateConstructionFrame(input: unknown): readonly ConstructionValidationIssue[] {
  return validateUngatedConstructionRecords(input);
}
