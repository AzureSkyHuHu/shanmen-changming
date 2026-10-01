import type { ProductionBlockedReason, ProductionTransaction, Reservation } from './types';

/** Disjoint from all legacy player command IDs and manual instance IDs. */
export type AutomaticJobId = `auto-job/${number}`;
export interface AutomaticTransaction extends Omit<ProductionTransaction, 'commandId' | 'transactionId'> {
  transactionId: AutomaticJobId;
  origin: { kind: 'sect-plan'; cycle: number };
}
export interface AutomaticLiveJob { transaction: AutomaticTransaction; reservation: Reservation }
export interface AutomaticTerminalPin {
  cycle: number;
  state: 'Committed' | 'Cancelled';
  workerId: string;
  recipeId: string;
  rootActionId: string;
  completedTick: number;
  resultEventId: string | null;
  retention: 'pending-command' | 'exact-receipt';
}
export interface AutomaticProductionNotice {
  eventId: string;
  tick: number;
  cycle: number;
  workerId: string;
  recipeId: string;
  kind: 'started' | 'blocked' | 'committed' | 'cancelled';
  reason: ProductionBlockedReason | null;
}
export interface AutomaticProductionState {
  schemaVersion: 1;
  nextCycle: number;
  activationReviewRequired: boolean;
  live: Record<AutomaticJobId, AutomaticLiveJob>;
  journal: AutomaticProductionNotice[];
  pins: Record<AutomaticJobId, AutomaticTerminalPin>;
}
export type ProductionOrigin = { kind: 'command'; commandId: string } | { kind: 'sect-plan'; cycle: number };
export type ProductionWork = ProductionTransaction | AutomaticTransaction;
export interface ProductionReceiptContext { commandId: string }
