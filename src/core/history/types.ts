import type { ProductionTransaction, Reservation } from '../economy/types';
import type { CommandReceipt, DomainEvent } from '../kernel/contracts';
import type { JsonValue } from '../kernel/serialization';

export const HISTORY_PAGE_SIZE = 256;
export const HISTORY_STRING_POOL_SIZE = 256;
export const MAX_HISTORY_RECORDS_PER_TABLE = 100_000;
export const MAX_HISTORY_EXPANDED_CHARACTERS = 64 * 1024 * 1024;
export const MAX_HISTORY_EXPANDED_NODES = 4_000_000;

/** Versioned wire rows. Treat as opaque; use the archive queries to read records. */
export type PackedHistoryRow = readonly JsonValue[];
export interface HistoryTable {
  readonly count: number;
  readonly pages: readonly (readonly PackedHistoryRow[])[];
}
/** Independent archive schema; intended for World v6 integration, never implicit v5 migration. */
export interface HistoryArchive {
  readonly schemaVersion: 1;
  readonly codecVersion: 1;
  readonly strings: readonly string[];
  readonly production: HistoryTable;
  readonly commandReceipts: HistoryTable;
  readonly events: HistoryTable;
}
export interface ArchivedProduction {
  transaction: ProductionTransaction;
  reservation: Reservation;
}
export interface HistoryAppendBatch {
  readonly production?: readonly ArchivedProduction[];
  readonly commandReceipts?: readonly CommandReceipt[];
  readonly events?: readonly DomainEvent[];
}
export interface HistoryVisitors {
  production?(record: ArchivedProduction): void;
  commandReceipt?(record: CommandReceipt): void;
  event?(record: DomainEvent, ordinal: number): void;
}
