import { CONSTRUCTION_LIMITS } from './construction-types';
import { SECT_PRODUCTION_LIMITS } from './production-types';
import { SECT_RESEARCH_LIMITS } from './research-types';
import { SECT_MAINTENANCE_LIMITS } from './maintenance-types';

/** Eager, acyclic descriptor arithmetic. These four limit modules have no runtime
 * dependencies. Never derive these constants through a validator/history/World
 * module: those functions form composition cycles under different entry points.
 * The existing public validators re-export the same exact bounds from this leaf. */
/** Descriptor nodes count each primitive/object/array once, excluding property names.
 * These bounds intentionally sum mutually exclusive record fields at their independent maxima.
 * A generic R-resource claim is ≤17+18R nodes (three line arrays, two checkpoints, settlement
 * outputs); a paired claim adds its object and three scalar identity/policy fields. A job's
 * ≤1079 non-route nodes include BOTH visits, all 320 spans, full navigation metadata AND the
 * largest terminal (two 9-line tagged arrays). Only the ≤36 active jobs may hold route cells.
 * This is a local structural bound, never the future whole-World 4 MiB/reader admission proof.
 */
const MAX_MAP_CELLS = 256 * 256;
const genericClaimNodes = (resources: number): number => 17 + 18 * resources;
const pairedClaimNodes = 4 + genericClaimNodes(6) + genericClaimNodes(3);
const terminalNodes = 1 + 3 + 3 + 1 + 2 * (1 + 9 * 4) + 1;
const jobNonRouteNodes = 1 + 13 + 3 + 2 * 5 + (1 + 320 * 3) + 8 + terminalNodes;
export const CONSTRUCTION_DESCRIPTOR_NODE_BOUND =
  10 // Frame object, five scalar fields and the catalog identity record.
  + (7 + MAX_MAP_CELLS * 5) // Map metadata, tiles array, maximum tile records.
  + (1 + 8 * 6) // Legacy station records.
  + (1 + 36 * 11) // Projected people, including each nested position.
  + (46 + CONSTRUCTION_LIMITS.records * 3 * pairedClaimNodes) // Both inventories and all paired claims.
  + (1 + CONSTRUCTION_LIMITS.records * 12) // Ungated public blueprint history.
  + (1 + CONSTRUCTION_LIMITS.records * jobNonRouteNodes)
  + CONSTRUCTION_LIMITS.activeJobs * MAX_MAP_CELLS * 3 // Live path cell records.
  + (1 + (CONSTRUCTION_LIMITS.buildings - 8) * 13) // Completed building evidence.
  + (1 + CONSTRUCTION_LIMITS.receipts * 13); // Largest full-body receipt (place).
/** Local research schema adds precisely the optional reference object and its two scalars. */
export const CONSTRUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND = CONSTRUCTION_DESCRIPTOR_NODE_BOUND + CONSTRUCTION_LIMITS.records * 3;

/** Construction's bound already covers the single map/people/both ledgers and every claim.
 * Each ungated production record allows all 240 disjoint five-node spans, fixed proof/terminal fields,
 * and its navigation header. Only 36 live jobs may retain 65,536 three-node route cells.
 * Conservative independent maxima ensure adding any admitted cancellation cannot exceed this
 * reader gate. This is a LOCAL structural bound, never the eventual whole-World save budget.
 */
export const SECT_PRODUCTION_DESCRIPTOR_NODE_BOUND = CONSTRUCTION_DESCRIPTOR_NODE_BOUND
  + 16 + SECT_PRODUCTION_LIMITS.records * (256 + SECT_PRODUCTION_LIMITS.maximumWorkTicks * 5)
  + SECT_PRODUCTION_LIMITS.activeJobs * 65536 * 3 + SECT_PRODUCTION_LIMITS.receipts * 12;
/** Only the combined research root permits the additional blueprint and production references.
 * Preserve the exact standalone reader cutoff, including its first rejection for hostile input. */
export const SECT_PRODUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND = SECT_PRODUCTION_DESCRIPTOR_NODE_BOUND
  + (CONSTRUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND - CONSTRUCTION_DESCRIPTOR_NODE_BOUND) + SECT_PRODUCTION_LIMITS.records * 3;

/** Independent maxima, including all visits/spans, terminal/cancel receipts and the one live
 * research route. The production bound includes construction's single shared authority/book.
 * This is a local descriptor gate, not an archive or whole-World save-capacity certificate. */
export const SECT_RESEARCH_DESCRIPTOR_NODE_BOUND = SECT_PRODUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND + 16
  + SECT_RESEARCH_LIMITS.records * (256 + SECT_RESEARCH_LIMITS.maximumWorkTicks * 6 + SECT_RESEARCH_LIMITS.visits * 6)
  + 65536 * 3 + SECT_RESEARCH_LIMITS.receipts * 12;

/** The research bound already budgets all 384 paired ledger claims. Add the domain object,
 * next-ID scalar and payments array, then one object plus nine scalar leaves per payment.
 * No receipt duplicates, navigation paths or per-tick failure records are persisted here. */
export const SECT_MAINTENANCE_DESCRIPTOR_NODE_BOUND = SECT_RESEARCH_DESCRIPTOR_NODE_BOUND + 3 + SECT_MAINTENANCE_LIMITS.payments * 10;
