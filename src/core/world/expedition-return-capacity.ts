import { getWorldContent, getWorldRunContent } from './content-access';
import { RESOURCE_IDS, type ResourceLine, type ResourceId } from '../economy/types';
import { checkedAdd } from '../kernel/numeric';
import { FALLBACK_SUPPLIES, MAX_COMMANDS } from '../expeditions/shared';
import type { ExpeditionDepartureRequestV8 } from '../expeditions/v8-world-types';
import type { WorldStateV8 } from './v8-types';
import { pendingCommandByteBudget, canonicalUtf8ByteLength } from '../save-budget';
import { retainedRecordBytes } from '../save-budget/bounds';
import type { CommandV8 } from '../kernel/contracts-v8';
import type { CommandReceipt } from '../kernel/contracts';

const quantity = (lines: readonly Readonly<ResourceLine>[], resourceId: ResourceId) => lines.find(line => line.resourceId === resourceId)?.quantity ?? 0;
interface EncounterRewardView { readonly securedLoot: readonly Readonly<ResourceLine>[]; readonly unsecuredLoot: readonly Readonly<ResourceLine>[] }
const rewards = (encounter: EncounterRewardView, resourceId: ResourceId) => checkedAdd(quantity(encounter.securedLoot, resourceId), quantity(encounter.unsecuredLoot, resourceId));
export interface ReturnInventoryCapacity {
  /** A conservative per-resource credit ceiling, independent of occupied stock.
   * Owned stock can be discarded; an incoming amount above capacity cannot. */
  creditCeilings: ResourceLine[]; impossibleResources: ResourceId[]; fits: boolean;
}
function assessment(world: WorldStateV8, credits: ResourceLine[]): ReturnInventoryCapacity {
  const impossibleResources = credits.filter(line => line.quantity > world.inventory[line.resourceId].capacity).map(line => line.resourceId);
  return { creditCeilings: credits.filter(line => line.quantity > 0), impossibleResources, fits: impossibleResources.length === 0 };
}
/** Covers all generated node choices in a registered route. First-month food is
 * prepaid before departure publishes; subsequent deaths cannot refund it. Future
 * meal costs are ignored, making the bound safe even after early roster losses. */
export function assessDepartureReturnInventory(world: WorldStateV8, request: ExpeditionDepartureRequestV8): ReturnInventoryCapacity {
  const content = getWorldContent(world); const route = content.routes.find(entry => entry.id === request.routeId)?.specification;
  if (!route || !request.squadIds.length || request.squadIds.length > 6) throw new TypeError('Unknown bounded departure');
  const find = (id: string) => { const encounter = content.encounters.find(entry => entry.id === id); if (!encounter) throw new TypeError('Missing registered encounter'); return encounter; };
  const regular = route.regularEncounterIds.map(find); const boss = find(route.bossEncounterId);
  const totalMonths = route.encounterCount * route.maximumTravelMonths + route.returnMonths;
  const cargo = request.supplies ?? [{ resourceId: 'meal', quantity: totalMonths * request.squadIds.length }];
  return assessment(world, RESOURCE_IDS.map(resourceId => {
    const maximumRegular = Math.max(...regular.map(encounter => rewards(encounter, resourceId)));
    const maximumLoot = checkedAdd(maximumRegular * (route.encounterCount - 1), rewards(boss, resourceId));
    const fallback = quantity(FALLBACK_SUPPLIES, resourceId) * (route.encounterCount - 1);
    const prepaid = resourceId === 'meal' && route.minimumTravelMonths > 0 ? request.squadIds.length : 0;
    return { resourceId, quantity: checkedAdd(Math.max(0, quantity(cargo, resourceId) - prepaid), checkedAdd(maximumLoot, fallback)) };
  }));
}
/** After a run is admitted its actual chosen nodes replace the preflight maxima. */
export function assessRunReturnInventory(world: WorldStateV8): ReturnInventoryCapacity {
  const run = world.expedition.run; if (!run || run.phase === 'Ended') return assessment(world, []);
  if (run.settlement) return assessment(world, RESOURCE_IDS.map(resourceId => ({ resourceId,
    quantity: checkedAdd(quantity(run.settlement!.loot, resourceId), quantity(run.settlement!.unusedSupplies, resourceId)) })));
  const content = getWorldRunContent(world);
  const unresolved = run.route.filter(node => !run.encounterResults.some(result => result.encounterId === `${node.nodeVisitId}/encounter`));
  const pendingRewards = run.offers.filter(offer => offer.resolution === 'pending').length + unresolved.filter(node => node.reward).length;
  return assessment(world, RESOURCE_IDS.map(resourceId => {
    let maximum = checkedAdd(quantity(run.supplies, resourceId), checkedAdd(quantity(run.securedLoot, resourceId), quantity(run.unsecuredLoot, resourceId)));
    for (const node of unresolved) {
      const encounter = content.encounters.find(entry => entry.id === node.encounterDefinitionId); if (!encounter) throw new TypeError('Unknown admitted encounter');
      maximum = checkedAdd(maximum, rewards(encounter, resourceId));
    }
    return { resourceId, quantity: checkedAdd(maximum, quantity(FALLBACK_SUPPLIES, resourceId) * pendingRewards) };
  }));
}

/** Maximum indispensable remaining domain rows. Extra rerolls/tactics are optional
 * and cannot spend this reservation. World commands and archive rows are separate. */
export function remainingRunCommandReserve(world: WorldStateV8) {
  const run = world.expedition.run;
  if (!run || run.phase === 'Ended') return { current: run?.commandLog.length ?? 0, reserved: 0, fits: true, limit: MAX_COMMANDS };
  const living = run.members.filter(member => member.alive).length;
  // Per uncompleted node: month admit+commit, begin+resolve, reward choice.
  const uncompleted = run.route.filter(node => !run.encounterResults.some(result => result.encounterId === `${node.nodeVisitId}/encounter`));
  const travel = uncompleted.reduce((sum, node) => sum + 2 * node.travelMonths, 0);
  const encounters = uncompleted.length * 2;
  const choices = uncompleted.filter(node => node.reward).length + (run.phase === 'RewardPending' ? 1 : 0);
  const returnMonths = run.settlement ? Math.max(0, run.settlement.returnMonths - run.settlement.returnProgress) : run.origin.route.returnMonths;
  // One members.died row per possible remaining natural death, one terminal
  // settlement and one emergency resolve alternative (deliberately overcounted).
  const reserved = travel + encounters + choices + 2 * returnMonths + living + 2;
  return { current: run.commandLog.length, reserved, fits: run.commandLog.length + reserved <= MAX_COMMANDS, limit: MAX_COMMANDS };
}

export interface ReturnClearanceReservation {
  bytes: number; archiveRows: { commandReceipts: number; events: number };
  archiveDecodedCharacters: number; archiveDecodedNodes: number;
  /** Sources listed for review; these totals cover no battle/run/proof clone. */
  maximumDiscardOperations: 6; maximumPlayerContinuationOperations: number;
}
/** Six complete all-available discards suffice once incoming itself fits each
 * resource capacity. No automatic starts may refill the blocked return window. */
export function returnClearanceReservation(world: WorldStateV8): ReturnClearanceReservation {
  const max = Number.MAX_SAFE_INTEGER; const id = 'c'.repeat(128);
  const discards: CommandV8[] = RESOURCE_IDS.map(resourceId => ({ commandId: id, sequence: max, issuedTick: max, kind: 'inventory.discard', payload: { resourceId, quantity: max } }));
  const discardBytes = pendingCommandByteBudget(discards, world.map).bytes;
  const continued = remainingRunCommandReserve(world).reserved;
  const receipt: CommandReceipt = { commandId: id, fingerprint: '', result: { commandId: id, status: 'accepted', transactionId: null,
    eventIds: [], rejection: null, expeditionResult: { kind: 'expedition.emergency-retreat', runId: `run:${max}`, phase: 'RewardPending', relatedId: 'r'.repeat(120) } } };
  const command = { kind: 'expedition.command', payload: { command: { commandId: id, kind: 'expedition.choose', offerId: 'o'.repeat(120), offerRevision: max, definitionId: 'd'.repeat(120), holderId: 'h'.repeat(120) } } };
  // JSON.stringify is the actual canonical fingerprint's same-width upper bound
  // for this fixed ASCII shape (property order changes no serialized byte length).
  receipt.fingerprint = JSON.stringify(command);
  const receiptBytes = retainedRecordBytes(receipt, id, [receipt.fingerprint]);
  const bytes = checkedAdd(discardBytes, continued * receiptBytes);
  const rows = { commandReceipts: 6 + continued, events: 6 };
  // UTF-8 bytes conservatively dominate decoded UTF-16 text and value counts;
  // the archive surcharge is charged once for every possible future row.
  return { bytes, archiveRows: rows, archiveDecodedCharacters: bytes,
    archiveDecodedNodes: checkedAdd(bytes, 32 * (rows.commandReceipts + rows.events)), maximumDiscardOperations: 6,
    maximumPlayerContinuationOperations: continued };
}
