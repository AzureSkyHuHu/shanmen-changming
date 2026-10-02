import type { CultivationCommand } from '../cultivation/types';
import type { WorldStateV10 } from '../sect-expansion/upgrade-types';
import { canonicalCultivationCommandsFromRecords, cultivationMonthTransitionFromRecords,
  inspectCultivationClockSourceRecords } from './v9-cultivation-clock-records';
import type { V9CultivationClockTransition } from './v9-cultivation-clock-types';

/** Fixed v10 record stage. The owning lifecycle root checks identity and all domain
 * records first; this is the unchanged schema-3 clock/care chronology, not admission. */
export function inspectV10CultivationClockRecords(world: WorldStateV10): void {
  inspectCultivationClockSourceRecords(world);
}
export function v10CultivationMonthTransition(world: WorldStateV10, month: number): V9CultivationClockTransition | undefined {
  return cultivationMonthTransitionFromRecords(world, month);
}
export function v10CanonicalCultivationCommands(world: WorldStateV10): CultivationCommand[] {
  return canonicalCultivationCommandsFromRecords(world);
}
