import { copy } from '../expeditions/shared';
import { managementV9BuildContext } from '../../content/sect-v9/world-content';
import { applyBuildCommandV2 } from '../builds/v2';
import { applyCultivationCommandV3 } from '../cultivation/v3';
import { cancelProduction, startProduction } from '../economy/production';
import { discardAvailable } from '../economy/discard';
import { applySectEconomyCommand } from '../sect-economy/state';
import { isConstructionCommand } from '../sect-expansion/construction-validation';
import { isSectProductionCommand } from '../sect-expansion/production-runtime';
import { isSectResearchCommand } from '../sect-expansion/research-validation';
import { ownSectFields } from '../sect-expansion/layout';
import { canonicalUtf8ByteLength } from '../save-budget';
import { cultivationFrameOf } from '../world/cultivation-preparation';
import { lookupCommandReceipt, recordWorldReceipt, worldEventCursor, worldEventsSince } from '../world/history-access';
import { composeV9CultivationFrame } from '../world/v9-cultivation-bridge';
import { inspectV9KnownRecordHeadroom } from '../world/v9-record-headroom';
import { applyV9SectStage, v9WorkerAvailable, v9WorkOwners } from '../world/v9-sect-bridge';
import type { WorldStateV9 } from '../world/v9-types';
import { isCommandV8 } from './command-shape-v8';
import type { CommandResult, RejectionCode } from './contracts';
import type { CommandV9, CommandResultV9 } from './contracts-v9';
import { appendEvent } from './events';
import { allocateId } from './ids';
import { isPaused } from './clock';
import { canonicalStringify, cloneJson } from './serialization';
import { inspectUnregisteredWorldV9Records } from './validation';

const rejected = (commandId: string, code: RejectionCode): CommandResult => ({ commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code } });
const special = (commandId: string, code: 'UNREGISTERED_COMMAND_FAMILY' | 'SECT_EXPANSION_REJECTED' | 'INVALID_WORLD_RECORDS', detail?: string): CommandResultV9 =>
  ({ commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code, ...(detail ? { detail } : {}) } });
export function isCommandV9(value: unknown): value is CommandV9 {
  try {
    canonicalUtf8ByteLength(value);
    if (isCommandV8(value)) return true;
    if (!ownSectFields(value, ['commandId', 'sequence', 'issuedTick', 'kind', 'payload']) || value.kind !== 'sect.command'
      || typeof value.commandId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.commandId) || ['__proto__', 'constructor', 'prototype'].includes(value.commandId)
      || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 || !Number.isSafeInteger(value.issuedTick) || (value.issuedTick as number) < 0
      || !ownSectFields(value.payload, ['domain', 'command'])) return false;
    const payload = value.payload;
    const checked = payload.domain === 'construction' ? isConstructionCommand(payload.command)
      : payload.domain === 'production' ? isSectProductionCommand(payload.command) : payload.domain === 'research' && isSectResearchCommand(payload.command);
    return checked && (payload.command as { commandId: string }).commandId === value.commandId;
  } catch { return false; }
}
/** Complete runtime RECORD boundary, still unregistered. Whole-save/capacity admission is a
 * separate milestone, so no caller may route this through an application engine or codec. */
export function dispatchUnregisteredCommandV9(world: WorldStateV9, input: unknown): { world: WorldStateV9; result: CommandResultV9 } {
  let sourceErrors: string[];
  try { canonicalUtf8ByteLength(world); sourceErrors = inspectUnregisteredWorldV9Records(world); }
  catch (error) { sourceErrors = [error instanceof Error ? error.message : 'Invalid source']; }
  if (sourceErrors.length) return { world, result: special('', 'INVALID_WORLD_RECORDS', sourceErrors[0]) };
  if (!isCommandV9(input)) return { world, result: rejected('', 'INVALID_COMMAND') };
  const command = input;
  if (command.kind === 'expedition.command' || command.kind === 'campaign.command') return { world, result: special(command.commandId, 'UNREGISTERED_COMMAND_FAMILY', 'v9 expedition and campaign admission is closed') };
  const fingerprint = canonicalStringify({ kind: command.kind, payload: command.payload });
  const existing = lookupCommandReceipt(world, command.commandId);
  if (existing) return { world, result: existing.fingerprint === fingerprint ? existing.result : rejected(command.commandId, 'COMMAND_CONFLICT') };
  const sectReceipts = [...world.sectExpansion.construction.receipts, ...world.sectExpansion.production.receipts, ...world.sectExpansion.research.receipts];
  const previousSect = sectReceipts.find(receipt => receipt.command.commandId === command.commandId);
  if (previousSect && (command.kind !== 'sect.command' || canonicalStringify(previousSect.command) !== canonicalStringify(command.payload.command))) return { world, result: rejected(command.commandId, 'COMMAND_CONFLICT') };
  if (!previousSect && command.issuedTick > world.clock.simulationTick) return { world, result: rejected(command.commandId, 'COMMAND_NOT_DUE') };
  if (!previousSect && world.clock.pauseReasons.includes('error')) return { world, result: rejected(command.commandId, 'CORE_PAUSED_ERROR') };
  try {
    let next = world; let result: CommandResultV9;
    if (command.kind === 'sect.command') {
      const stage = applyV9SectStage(world, command.payload);
      if ('code' in stage) return { world, result: special(command.commandId, 'SECT_EXPANSION_REJECTED', stage.code) };
      if (stage.repeated) return { world, result: { commandId: command.commandId, status: 'accepted', transactionId: stage.relatedId, eventIds: [], rejection: null,
        sectResult: { domain: command.payload.domain, relatedId: stage.relatedId, repeated: true } } };
      next = stage.world; result = { commandId: command.commandId, status: 'accepted', transactionId: stage.relatedId, eventIds: [], rejection: null,
        sectResult: { domain: command.payload.domain, relatedId: stage.relatedId, repeated: false } };
    } else {
      let legacyResult: CommandResult;
      if (command.kind === 'production.start' || command.kind === 'production.cancel') {
        const operation = command.kind === 'production.start'
          ? (!v9WorkerAvailable(world, command.payload.workerId) || isPaused(world.clock) || v9WorkOwners(world).length >= 36
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
        const applied = profile?.lifeState === 'alive' ? applyBuildCommandV2({ builds: world.builds, sequences: world.sequences }, inner, managementV9BuildContext(world.contentIdentity)) : null;
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
        const busy = targets.some(id => v9WorkOwners(world).some(owner => owner.workerId === id));
        const applied = busy ? null : applyCultivationCommandV3(cultivationFrameOf(world), inner);
        if (!applied?.ok) legacyResult = { ...rejected(command.commandId, 'CULTIVATION_REJECTED'), rejection: { code: 'CULTIVATION_REJECTED', cultivationCode: applied?.code ?? 'DISCIPLE_UNAVAILABLE' } };
        else {
          next = composeV9CultivationFrame(world, applied.frame, { commandId: command.commandId });
          legacyResult = { commandId: command.commandId, status: 'accepted', transactionId: null, eventIds: worldEventsSince(next, worldEventCursor(world)).map(event => event.eventId), rejection: null, cultivationResult: applied.result };
        }
      }
      next = recordWorldReceipt(next, { commandId: command.commandId, fingerprint, result: cloneJson(legacyResult) }); result = legacyResult;
    }
    const errors = inspectUnregisteredWorldV9Records(next);
    if (errors.length) return { world, result: special(command.commandId, 'INVALID_WORLD_RECORDS', errors[0]) };
    const headroom = inspectV9KnownRecordHeadroom(next);
    if (headroom.length) return { world, result: rejected(command.commandId, 'CAPACITY_EXCEEDED') };
    return { world: next, result };
  } catch (error) {
    if (error instanceof RangeError) return { world, result: rejected(command.commandId, 'CAPACITY_EXCEEDED') };
    return { world, result: special(command.commandId, 'INVALID_WORLD_RECORDS', error instanceof Error ? error.message : 'Invalid candidate') };
  }
}
