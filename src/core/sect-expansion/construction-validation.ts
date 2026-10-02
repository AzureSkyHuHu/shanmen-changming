import type { ConstructionValidationIssue } from './construction-types';
import { validateConstructionRecords } from './construction-record-validation';
export { CONSTRUCTION_DESCRIPTOR_NODE_BOUND, isConstructionCommand, validateConstructionContext } from './construction-record-validation';

/** Strict public boundary. Local records still reject every research-gated definition. */
export function validateConstructionFrame(input: unknown): readonly ConstructionValidationIssue[] {
  return validateConstructionRecords(input);
}
