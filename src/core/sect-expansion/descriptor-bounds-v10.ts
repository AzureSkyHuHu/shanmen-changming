import { SECT_MAINTENANCE_DESCRIPTOR_NODE_BOUND } from './descriptor-bounds';

/** Independent added-record arithmetic. A visit is 6 nodes; a span 6; checkpoint 8;
 * fixed job/site/gate/nav/terminal/cost records are bounded by 192. Existing construction
 * budget already contains all 384 paired claims. Only 36 live routes may retain cells.
 * Care adds its own finite 41 visits/40 spans plus fixed records and 36 routes. L2 payment
 * tags and production proofs are counted separately. This is NOT whole-save headroom. */
export const SECT_UPGRADE_DESCRIPTOR_NODE_BOUND_V10 = SECT_MAINTENANCE_DESCRIPTOR_NODE_BOUND
  + 32 + 128 * (192 + 401 * 6 + 400 * 6 + 2 * 8) + 256 * 10 + 36 * 65536 * 3
  + 16 + 128 * (256 + 41 * 6 + 40 * 4) + 256 * 10 + 36 * 65536 * 3
  + 128 * 4 + 128 * 4;
