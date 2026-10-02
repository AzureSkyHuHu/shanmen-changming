import { beforeAll, describe, expect, it } from 'vitest';
import { lookupArchivedCommandReceipt } from '../../src/core/history';
import type { CommandReceipt } from '../../src/core/kernel/contracts';
import { canonicalStringify, cloneJson, type JsonValue } from '../../src/core/kernel/serialization';
import { inspectUnregisteredWorldV9Records } from '../../src/core/kernel/validation';
import { assessManagementCapacityV9 } from '../../src/core/world/management-capacity-v9';
import { projectV9SectFrame } from '../../src/core/world/v9-sect-bridge';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { validateSectProductionReceipts } from '../../src/core/sect-expansion/production-runtime';
import { fixtureApply, fixtureCommand, fixtureSectCommand, fundedRuntimeFixture } from './fixtures/v9-runtime';

const archivedId = 'archive.reuse.history.000';
let source: WorldStateV9;
beforeAll(() => {
  let world = fundedRuntimeFixture();
  // Every receipt has a real accepted command source. Sixty-five commands put
  // the first receipt beyond the fixed 64-entry World tail.
  for (let index = 0; index < 65; index++) {
    const commandId = `archive.reuse.history.${String(index).padStart(3, '0')}`;
    world = fixtureApply(world, fixtureCommand(world, { kind: 'cultivation.command', payload: { command: {
      kind: 'training.set', commandId, expectedRevision: world.cultivation.revision, discipleId: 'entity:2', mode: 'duty',
    } } }, commandId));
  }
  source = fixtureApply(world, fixtureSectCommand(world, { domain: 'production', command: {
    kind: 'production.start', commandId: 'archive.reuse.sect', expectedRevision: world.sectExpansion.production.revision,
    recipeId: 'gather.stone.v9', workerId: 'entity:2',
  } }));
  expect(source.commandReceipts[archivedId]).toBeUndefined();
  expect(source.history.commandReceipts.count).toBe(1);
  expect(lookupArchivedCommandReceipt(source.history, archivedId)?.commandId).toBe(archivedId);
});

describe('synchronous v9 closure reuses only its authenticated archive', () => {
  it('accepts raw and owned archives without replacing, mutating or freezing the caller source', () => {
    const raw = cloneJson(source); const before = canonicalStringify(raw);
    const history = raw.history; const table = history.commandReceipts; const row = table.pages[0]![0]!;
    expect(inspectUnregisteredWorldV9Records(source)).toEqual([]);
    expect(inspectUnregisteredWorldV9Records(raw)).toEqual([]);
    expect(assessManagementCapacityV9(raw).supported).toBe(true);
    expect(canonicalStringify(raw)).toBe(before); expect(canonicalStringify(source)).toBe(before);
    expect(raw.history).toBe(history); expect(raw.history.commandReceipts).toBe(table);
    expect(raw.history.commandReceipts.pages[0]![0]).toBe(row);
    for (const value of [raw, history, history.strings, table, table.pages, table.pages[0], row, row[2]]) {
      expect(Object.isFrozen(value)).toBe(false);
    }
  });

  for (const representation of ['owned', 'raw'] as const) it(`rejects an archived World/sect command collision with ${representation} history`, () => {
    const base = representation === 'raw' ? cloneJson(source) : source;
    const domain = base.sectExpansion.production;
    const collision: WorldStateV9 = { ...base, sectExpansion: { ...base.sectExpansion, production: { ...domain,
      receipts: domain.receipts.map(receipt => ({ ...receipt, command: { ...receipt.command, commandId: archivedId } })),
    } } };
    // The local receipt remains well-formed and tied to its real job. Only the
    // complete World owner union detects the competing archived command owner.
    expect(validateSectProductionReceipts(projectV9SectFrame(collision))).toEqual([]);
    expect(collision.commandReceipts[archivedId]).toBeUndefined();
    expect(inspectUnregisteredWorldV9Records(collision)).toEqual(['V9 command identity has multiple owners']);
    const assessed = assessManagementCapacityV9(collision);
    expect(assessed.supported).toBe(false);
    expect(assessed.sourceRecordIssues).toContain('V9 command identity has multiple owners');
  });

  it('reauthenticates mutations to the same raw archive and nested receipt after a successful call', () => {
    const raw = cloneJson(source); const history = raw.history; const row = history.commandReceipts.pages[0]![0]!;
    expect(row[0]).toBe(1); // Cultivation results use the codec's exact raw-record fallback.
    const receipt = row[2] as unknown as CommandReceipt; const original = receipt.fingerprint;
    expect(inspectUnregisteredWorldV9Records(raw)).toEqual([]);
    receipt.fingerprint = `${original} `;
    expect(raw.history).toBe(history); expect(raw.history.commandReceipts.pages[0]![0]).toBe(row);
    expect(inspectUnregisteredWorldV9Records(raw).length).toBeGreaterThan(0);
    expect(assessManagementCapacityV9(raw).supported).toBe(false);
    receipt.fingerprint = original;
    expect(inspectUnregisteredWorldV9Records(raw)).toEqual([]);
    expect(assessManagementCapacityV9(raw).supported).toBe(true);
  });

  it('rejects malformed archive row counts after prior successful validation', () => {
    const raw = cloneJson(source);
    expect(inspectUnregisteredWorldV9Records(raw)).toEqual([]);
    Object.defineProperty(raw.history.commandReceipts, 'count', { value: 2, enumerable: true, writable: true, configurable: true });
    expect(inspectUnregisteredWorldV9Records(raw)).toEqual(['Invalid history archive']);
    expect(assessManagementCapacityV9(raw).supported).toBe(false);
  });

  it('rejects malformed packed row tags without publishing an authenticated source', () => {
    const raw = cloneJson(source); const row = raw.history.commandReceipts.pages[0]![0]! as JsonValue[];
    row[0] = 99;
    expect(inspectUnregisteredWorldV9Records(raw)).toEqual(['Invalid history archive']);
    expect(assessManagementCapacityV9(raw).supported).toBe(false);
    expect(row[0]).toBe(99); expect(Object.isFrozen(row)).toBe(false);
  });

  it('rejects a raw archive accessor before invoking it, even after earlier successful validation', () => {
    const raw = cloneJson(source); const row = raw.history.commandReceipts.pages[0]![0]!;
    expect(inspectUnregisteredWorldV9Records(raw)).toEqual([]);
    let reads = 0;
    Object.defineProperty(row, '2', { enumerable: true, configurable: true, get() { reads++; throw new Error('must not execute'); } });
    expect(inspectUnregisteredWorldV9Records(raw).length).toBeGreaterThan(0);
    expect(assessManagementCapacityV9(raw).supported).toBe(false);
    expect(reads).toBe(0);
  });
});
