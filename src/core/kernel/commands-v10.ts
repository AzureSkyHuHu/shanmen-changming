import { copy } from '../expeditions/shared';
import { managementV10BuildContext } from '../../content/sect-v10/world-content';
import { applyBuildCommandV2 } from '../builds/v2';
import { cancelProduction, startProduction } from '../economy/production';
import { discardAvailable } from '../economy/discard';
import { applySectEconomyCommand } from '../sect-economy/state';
import { isSectCareCommand } from '../sect-expansion/care-validation';
import { isConstructionCommand } from '../sect-expansion/construction-validation';
import { isSectProductionCommand } from '../sect-expansion/production-runtime';
import { isSectResearchCommand } from '../sect-expansion/research-validation';
import { ownSectFields } from '../sect-expansion/layout';
import { canonicalUtf8ByteLength } from '../save-budget';
import { lookupCommandReceipt, recordWorldReceipt, worldEventCursor, worldEventsSince } from '../world/history-access';
import { reconcilePreparedV10Cultivation } from '../world/v10-cultivation-bridge';
import { prepareValidatedV10CultivationCommand } from '../world/v10-cultivation-preparation';
import { applyV10SectStage, captureValidatedV10PreparationSource } from '../world/v10-sect-bridge';
import { v10WorkerAvailable, v10WorkOwners } from '../world/v10-sect-frame';
import { captureV10RecordData } from '../world/v10-sect-records';
import { isSectUpgradeCommandV10 } from '../sect-expansion/upgrade-validation';
import type { WorldStateV10 } from '../sect-expansion/upgrade-types';
import { isCommandV8 } from './command-shape-v8';
import type { CommandResult, RejectionCode } from './contracts';
import type { CommandV10, CommandResultV10 } from './contracts-v10';
import { appendEvent } from './events';
import { allocateId } from './ids';
import { isPaused } from './clock';
import { canonicalStringify, cloneJson } from './serialization';
import { inspectUnregisteredWorldV10Records } from './validation';

const rejected = (commandId: string, code: RejectionCode): CommandResult => ({ commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code } });
const special = (commandId: string, code: 'UNREGISTERED_COMMAND_FAMILY' | 'SECT_EXPANSION_REJECTED' | 'INVALID_WORLD_RECORDS', detail?: string): CommandResultV10 =>
  ({ commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code, ...(detail ? { detail } : {}) } });
export function isCommandV10(value: unknown): value is CommandV10 {
  try {
    canonicalUtf8ByteLength(value);
    if (isCommandV8(value)) return true;
    if (!ownSectFields(value, ['commandId', 'sequence', 'issuedTick', 'kind', 'payload']) || value.kind !== 'sect.command'
      || typeof value.commandId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.commandId) || ['__proto__', 'constructor', 'prototype'].includes(value.commandId)
      || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 || !Number.isSafeInteger(value.issuedTick) || (value.issuedTick as number) < 0
      || !ownSectFields(value.payload, ['domain', 'command'])) return false;
    const payload = value.payload;
    const checked = payload.domain === 'construction' ? isConstructionCommand(payload.command)
      : payload.domain === 'production' ? isSectProductionCommand(payload.command) : payload.domain === 'research' ? isSectResearchCommand(payload.command)
        : payload.domain === 'care' ? isSectCareCommand(payload.command)
          : payload.domain === 'upgrade' && isSectUpgradeCommandV10(payload.command);
    return checked && (payload.command as { commandId: string }).commandId === value.commandId;
  } catch { return false; }
}
/** INTERNAL root-owned-source candidate preparation. The captured source and complete
 * result pass fixed v10 records; no save-envelope, future capacity, runtime publication,
 * queue, Session, codec or application admission is claimed by this function. */
export function prepareUnregisteredCommandCandidateV10(original: WorldStateV10, input: unknown): { world: WorldStateV10; result: CommandResultV10 } {
  let world: WorldStateV10;
  try { world = captureValidatedV10PreparationSource(original); }
  catch { return { world: original, result: special('', 'INVALID_WORLD_RECORDS', 'Invalid internal v10 source records') }; }
  try { input = captureV10RecordData(input); }
  catch { return { world: original, result: rejected('', 'INVALID_COMMAND') }; }
  if (!isCommandV10(input)) return { world: original, result: rejected('', 'INVALID_COMMAND') };
  const command = input;
  if (command.kind === 'expedition.command' || command.kind === 'campaign.command') return { world: original, result: special(command.commandId, 'UNREGISTERED_COMMAND_FAMILY', 'v10 expedition and campaign admission is closed') };
  const fingerprint = canonicalStringify({ kind: command.kind, payload: command.payload });
  const existing = lookupCommandReceipt(world, command.commandId);
  if (existing) return { world: original, result: existing.fingerprint === fingerprint ? existing.result : rejected(command.commandId, 'COMMAND_CONFLICT') };
  const sectReceipts = [...world.sectExpansion.construction.receipts, ...world.sectExpansion.production.receipts, ...world.sectExpansion.research.receipts, ...world.sectExpansion.care.receipts, ...world.sectExpansion.upgrade.receipts];
  const previousSect = sectReceipts.find(receipt => receipt.command.commandId === command.commandId);
  if (previousSect && (command.kind !== 'sect.command' || canonicalStringify(previousSect.command) !== canonicalStringify(command.payload.command))) return { world: original, result: rejected(command.commandId, 'COMMAND_CONFLICT') };
  if (!previousSect && command.issuedTick > world.clock.simulationTick) return { world: original, result: rejected(command.commandId, 'COMMAND_NOT_DUE') };
  if (!previousSect && world.clock.pauseReasons.includes('error')) return { world: original, result: rejected(command.commandId, 'CORE_PAUSED_ERROR') };
  try {
    let next = world; let result: CommandResultV10;
    if (command.kind === 'sect.command') {
      const stage = applyV10SectStage(world, command.payload);
      if ('code' in stage) return { world: original, result: special(command.commandId, 'SECT_EXPANSION_REJECTED', stage.code) };
      if (stage.repeated) return { world: original, result: { commandId: command.commandId, status: 'accepted', transactionId: stage.relatedId, eventIds: [], rejection: null,
        sectResult: { domain: command.payload.domain, relatedId: stage.relatedId, repeated: command.payload.domain !== 'care' } } };
      next = stage.world; result = { commandId: command.commandId, status: 'accepted', transactionId: stage.relatedId, eventIds: [], rejection: null,
        sectResult: { domain: command.payload.domain, relatedId: stage.relatedId, repeated: false } };
    } else {
      let legacyResult: CommandResult;
      if (command.kind === 'production.start' || command.kind === 'production.cancel') {
        const operation = command.kind === 'production.start'
          ? (!v10WorkerAvailable(world, command.payload.workerId) || isPaused(world.clock) || v10WorkOwners(world).length >= 36
            ? { ok: false as const, rejection: { code: 'WORKER_UNAVAILABLE' as const } }
            : startProduction(world, command.commandId, command.payload.recipeId, command.payload.workerId))
          : cancelProduction(world, command.payload.transactionId, { commandId: command.commandId });
        legacyResult = operation.ok ? { commandId: command.commandId, status: 'accepted', transactionId: operation.transactionId, eventIds: operation.eventIds, rejection: null }
          : { ...rejected(command.commandId, operation.rejection.code), rejection: operation.rejection };
        if (operation.ok) next = operation.world;
      } else if (command.kind === 'inventory.discard') {
        const discarded = discardAvailable(world.inventory, command.payload.resourceId, command.payload.quantity);
        if (!discarded.ok) legacyResult = rejected(command.commandId, discarded.code);
        else {
          const action = allocateId(world.sequences, 'action');
          const emitted = appendEvent({ ...world, inventory: discarded.inventory, sequences: action.sequences }, { kind: 'inventory.discarded', rootActionId: action.id, parentEventId: null,
            payload: { commandId: command.commandId, ...discarded.discarded } });
          next = emitted.world; legacyResult = { commandId: command.commandId, status: 'accepted', transactionId: null, eventIds: [emitted.event.eventId], rejection: null, discardResult: discarded.discarded };
        }
      } else if (command.kind === 'sect-economy.command') {
        const applied = applySectEconomyCommand(world.sectEconomy, command.payload.command, world.disciples.map(actor => actor.id));
        if (!applied.ok) legacyResult = { ...rejected(command.commandId, 'SECT_ECONOMY_REJECTED'), rejection: { code: 'SECT_ECONOMY_REJECTED', economyCode: applied.code } };
        else {
          next = { ...world, sectEconomy: applied.state, automaticProduction: command.payload.command.kind === 'enabled.set' ? { ...world.automaticProduction, activationReviewRequired: false } : world.automaticProduction };
          legacyResult = { commandId: command.commandId, status: 'accepted', transactionId: null, eventIds: [], rejection: null,
            economyResult: { kind: command.payload.command.kind, workerId: command.payload.command.kind === 'plan.set' ? command.payload.command.plan.workerId : null } };
        }
      } else if (command.kind === 'build.command') {
        const inner = command.payload.command;
        const profile = world.cultivation.disciples.find(profile => profile.discipleId === inner.discipleId);
        const applied = profile?.lifeState === 'alive' && !world.sectExpansion.care.jobs.some(job => job.patientId === inner.discipleId && !job.terminal) ? applyBuildCommandV2({ builds: world.builds, sequences: world.sequences }, inner, managementV10BuildContext(world.contentIdentity)) : null;
        if (!applied?.ok) legacyResult = { ...rejected(command.commandId, 'BUILD_REJECTED'), rejection: { code: 'BUILD_REJECTED', buildCode: applied?.code ?? 'INVALID_STATE' } };
        else {
          next = { ...world, builds: copy(applied.frame.builds), sequences: cloneJson(applied.frame.sequences) };
          legacyResult = { commandId: command.commandId, status: 'accepted', transactionId: null, eventIds: [], rejection: null,
            buildResult: { commandId: inner.commandId, kind: inner.kind, revision: applied.receipt.revision, resultId: applied.receipt.resultId } };
        }
      } else {
        const inner = command.payload.command;
        const targets = inner.kind === 'teaching.begin' ? [inner.discipleId, inner.studentId]
          : inner.kind === 'breakthrough.confirm' ? [inner.preview.discipleId]
            : inner.kind === 'training.set' && inner.mode !== 'duty' ? [inner.discipleId] : [];
        // Care can continue resting, but no command may introduce concurrent training.
        const careTrainingConflict = inner.kind === 'training.set' && inner.mode === 'training'
          && world.sectExpansion.care.jobs.some(job => job.patientId === inner.discipleId && !job.terminal);
        const busy = careTrainingConflict || targets.some(id => v10WorkOwners(world).some(owner => owner.workerId === id
          && !(owner.kind === 'care' && inner.kind === 'training.set' && inner.mode === 'rest')));
        const preparation = busy ? null : prepareValidatedV10CultivationCommand(world, inner);
        const applied = preparation?.transition;
        if (!applied?.ok) legacyResult = { ...rejected(command.commandId, 'CULTIVATION_REJECTED'), rejection: { code: 'CULTIVATION_REJECTED', cultivationCode: applied?.code ?? 'DISCIPLE_UNAVAILABLE' } };
        else {
          next = applied.replayed ? world : reconcilePreparedV10Cultivation(world, preparation!, { commandId: command.commandId });
          legacyResult = { commandId: command.commandId, status: 'accepted', transactionId: null, eventIds: worldEventsSince(next, worldEventCursor(world)).map(event => event.eventId), rejection: null, cultivationResult: applied.result };
        }
      }
      next = recordWorldReceipt(next, { commandId: command.commandId, fingerprint, result: cloneJson(legacyResult) }); result = legacyResult;
    }
    const errors = inspectUnregisteredWorldV10Records(next);
    if (errors.length) return { world: original, result: special(command.commandId, 'INVALID_WORLD_RECORDS', errors[0]) };
    return { world: next, result };
  } catch (error) {
    if (error instanceof RangeError) return { world: original, result: rejected(command.commandId, 'CAPACITY_EXCEEDED') };
    return { world: original, result: special(command.commandId, 'INVALID_WORLD_RECORDS', 'Invalid internal v10 candidate records') };
  }
}
