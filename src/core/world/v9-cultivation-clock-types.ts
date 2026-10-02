/** Fresh .3 only. One row per real month/birthday revision, never per disciple.
 * 8,192 synchronized months cover 682 years, beyond the 600-year final realm.
 * Off-month birthdays share the same finite budget. No history is evicted. */
export const V9_CULTIVATION_CLOCK_LIMIT = 8_192;
export interface V9CultivationClockTransition {
  kind: 'month' | 'age-sync';
  tick: number;
  beforeRevision: number;
  rootActionId: string;
}
export interface V9CultivationClockRecords {
  transitions: V9CultivationClockTransition[];
}
