import { captureV10RecordData } from './v10-sect-records';

/** INTERNAL immutable scratch data for the two complete v10 inspection roots.
 * Always run the unchanged bounded descriptor capture first, even for a frozen
 * caller. Only that fresh ordinary-data copy is frozen. This neither validates a
 * World nor restores/authenticates an archive or supplies measurement authority.
 * Existing counters must still inspect every descendant before caching sizes.
 * Do not replace general captureV10RecordData: its callers retain mutable copies. */
export function captureFrozenV10RecordData(input: unknown): unknown {
  const captured = captureV10RecordData(input);
  // Capture already rejected aliases, cycles, accessors and exotic prototypes,
  // and bounded depth/nodes/bytes. There are no caller objects or hooks here.
  function freeze(value: unknown): void {
    if (value === null || typeof value !== 'object') return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  freeze(captured);
  return captured;
}
