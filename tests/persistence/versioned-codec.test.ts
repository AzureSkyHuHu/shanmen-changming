import { readFileSync } from 'node:fs';
import { IDBFactory as FakeIDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { createSaveEnvelope, parseSave, serializeSave } from '../../src/core/kernel/save';
import { parseSaveV8 } from '../../src/core/kernel/save-v8';
import { stableHash } from '../../src/core/kernel/serialization';
import { createWorld } from '../../src/core/world/create-world';
import { createWorldV8 } from '../../src/core/world/create-world-v8';
import { exportWorldSave, parseSaveFile } from '../../src/platform/files/save-files';
import {
  createVersionedSaveEnvelope, MAX_SAVE_FILE_BYTES, parseVersionedSave, peekSaveVersion, serializeVersionedSave,
} from '../../src/platform/save-codec';
import {
  DATABASE_VERSION, openSaveRepository,
  type IndexedDbSaveRepository, type RepositoryOptions, type SnapshotRecord, type WriteStage,
} from '../../src/platform/persistence';

const metadata = { buildId: 'dual-codec-test', savedAt: '2026-10-01T17:00:00Z' };
const slotId = 'campaign-1' as const;
const legacyFixtures = [
  ['v1', './fixtures/save-v1-in-progress.json'],
  ['v2', '../integration/fixtures/save-v2-in-progress.json'],
  ['v3', '../integration/fixtures/save-v3-in-progress.json'],
  ['v4', '../integration/fixtures/save-v4-active-battle.json'],
  ['v5', '../integration/fixtures/save-v5-mixed-history.json'],
  ['v6', '../integration/fixtures/save-v6-before-automatic-work.json'],
  ['v7', '../integration/fixtures/save-v7-active-automatic.json'],
] as const;
const v7Text = readFileSync(new URL('../integration/fixtures/save-v7-active-automatic.json', import.meta.url), 'utf8');
const repositories: IndexedDbSaveRepository[] = [];

function v8Text(seed = 'dual-codec-v8'): string {
  return serializeVersionedSave(createVersionedSaveEnvelope(createWorldV8(seed), metadata));
}
function editEnvelope(text: string, edit: (value: Record<string, unknown>) => void, recompute = false): string {
  const value = JSON.parse(text) as Record<string, unknown>;
  edit(value);
  if (recompute) {
    const { checksum: _checksum, ...body } = value;
    value.checksum = stableHash(body);
  }
  return JSON.stringify(value);
}
function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}
function completion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}
async function harness(extra: Partial<RepositoryOptions> = {}) {
  const factory = new FakeIDBFactory();
  const databaseName = 'versioned-codec';
  const options = { indexedDB: factory, databaseName, now: () => 1000, ...extra };
  const open = async () => {
    const repository = await openSaveRepository(options);
    repositories.push(repository);
    return repository;
  };
  const repository = await open();
  const inspect = async () => {
    const raw = await request(factory.open(databaseName));
    try {
      const transaction = raw.transaction(['slots', 'snapshots', 'leases'], 'readonly');
      const done = completion(transaction);
      const [slots, snapshots, leases] = await Promise.all([
        request<unknown[]>(transaction.objectStore('slots').getAll()),
        request<SnapshotRecord[]>(transaction.objectStore('snapshots').getAll()),
        request<unknown[]>(transaction.objectStore('leases').getAll()),
      ]);
      await done;
      return { version: raw.version, slots, snapshots, leases };
    } finally { raw.close(); }
  };
  const replaceText = async (id: string, text: string) => {
    const raw = await request(factory.open(databaseName));
    try {
      const transaction = raw.transaction('snapshots', 'readwrite');
      const done = completion(transaction);
      const store = transaction.objectStore('snapshots');
      const value = await request<SnapshotRecord>(store.get(id));
      await request(store.put({ ...value, text }));
      await done;
    } finally { raw.close(); }
  };
  return { repository, open, inspect, replaceText };
}

afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });

describe('one bounded versioned platform codec', () => {
  it.each(legacyFixtures)('keeps authentic %s on the legacy path, with no automatic v8 migration', (_version, path) => {
    const text = readFileSync(new URL(path, import.meta.url), 'utf8');
    const legacy = parseSave(text);
    const parsed = parseVersionedSave(text);
    expect(legacy.ok).toBe(true);
    expect(parsed).toEqual(legacy);
    if (!parsed.ok) throw new Error(parsed.error.code);
    expect(parsed.envelope.saveVersion).toBe(7);
    expect(parsed.world.simulationVersion).toBe('0.7.0');
    expect('contentIdentity' in parsed.world).toBe(false);
    expect(parseSaveFile(text)).toEqual(parsed);
  });

  it('roundtrips a fresh v8 World through the selected strict codec and file export', () => {
    const world = createWorldV8('fresh-dual-codec');
    const envelope = createVersionedSaveEnvelope(world, metadata);
    expect(envelope.saveVersion).toBe(8);
    const text = serializeVersionedSave(envelope);
    const parsed = parseVersionedSave(text);
    expect(parsed).toEqual(parseSaveV8(text));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.code);
    expect(parsed.envelope.saveVersion).toBe(8);
    expect(parsed.migration).toBeNull();
    expect(stableHash(parsed.world)).toBe(stableHash(world));
    expect(serializeVersionedSave(parsed.envelope)).toBe(text);
    expect(exportWorldSave(world, metadata).text).toBe(text);
    // The frozen legacy codec remains v7-only; the platform router adds support.
    expect(parseSave(text)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION' } });
  });

  it('keeps v7 serialization identical to the original core', () => {
    const world = createWorld('legacy-codec-byte-identity');
    const original = serializeSave(createSaveEnvelope(world, metadata));
    expect(serializeVersionedSave(createVersionedSaveEnvelope(world, metadata))).toBe(original);
    expect(exportWorldSave(world, metadata).text).toBe(original);
  });

  it('does not retry malformed or relabeled v8 data using the permissive legacy route', () => {
    const relabeled = editEnvelope(v7Text, (value) => { value.saveVersion = 8; }, true);
    expect(parseVersionedSave(relabeled)).toEqual(parseSaveV8(relabeled));
    expect(parseVersionedSave(relabeled)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SIMULATION_VERSION' } });
    const current = v8Text();
    const invalidBodies = [
      editEnvelope(current, (value) => { value.checksum = '00000000'; }),
      editEnvelope(current, (value) => { value.unregisteredExtra = true; }, true),
      editEnvelope(current, (value) => { (value.payload as Record<string, unknown>).simulationVersion = '0.7.0'; }, true),
    ];
    for (const text of invalidBodies) {
      expect(parseVersionedSave(text)).toEqual(parseSaveV8(text));
      expect(parseVersionedSave(text).ok).toBe(false);
    }
  });

  it('rejects checksum-valid authentic v7 carrying reserved v8 content authority without demotion or stripping', () => {
    const identity = createWorldV8('mixed-authority-source').contentIdentity;
    for (const contentIdentity of [identity, null]) {
      const text = `\n ${editEnvelope(v7Text, (value) => {
        (value.payload as Record<string, unknown>).contentIdentity = contentIdentity;
      }, true)}\n`;
      // This proves the historical v7 validator is deliberately untouched and
      // that the new platform admission check closes its unknown-field gap.
      expect(parseSave(text).ok).toBe(true);
      expect(peekSaveVersion(text)).toEqual({ ok: true, saveVersion: 7 });
      expect(parseVersionedSave(text)).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
      expect(parseSaveFile(text)).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
      expect((JSON.parse(text) as { payload: { contentIdentity: unknown } }).payload.contentIdentity).toEqual(contentIdentity);
    }
  });

  it.each([0, -1, 9, 999, 7.5, '8', null])('rejects unregistered source version %s rather than guessing', (version) => {
    expect(parseVersionedSave(JSON.stringify({ saveVersion: version }))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION' } });
  });

  it('bounds UTF-8 bytes before even peeking JSON or version, including invalid JSON', () => {
    const oversized = `{"saveVersion":8,"padding":"${'界'.repeat(Math.floor(MAX_SAVE_FILE_BYTES / 3) + 1)}"}`;
    expect(oversized.length).toBeLessThan(MAX_SAVE_FILE_BYTES);
    expect(peekSaveVersion(oversized)).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
    expect(parseSaveFile(oversized)).toEqual(peekSaveVersion(oversized));
    expect(peekSaveVersion('界'.repeat(Math.floor(MAX_SAVE_FILE_BYTES / 3) + 1))).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
    expect(parseVersionedSave(' '.repeat(MAX_SAVE_FILE_BYTES + 1))).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
  });

  it.each(['{broken', 'null', '[]', '8', '{}'])('handles malformed or non-envelope JSON safely: %s', (text) => {
    expect(() => peekSaveVersion(text)).not.toThrow();
    expect(parseVersionedSave(text).ok).toBe(false);
  });

  it('never guesses a codec for unknown, conflicting or invalid World identities', () => {
    const unsupported = createWorld();
    unsupported.simulationVersion = '0.9.0';
    expect(() => createVersionedSaveEnvelope(unsupported, metadata)).toThrow();
    const mismatched = createWorldV8();
    mismatched.contentVersion = 'unregistered-content';
    expect(() => createVersionedSaveEnvelope(mismatched, metadata)).toThrow();
    const mixedIdentity = Object.assign(createWorld(), { contentIdentity: createWorldV8().contentIdentity });
    expect(() => createVersionedSaveEnvelope(mixedIdentity, metadata)).toThrow();
    const invalid = createWorldV8();
    invalid.inventory.wood.owned = -1;
    expect(() => createVersionedSaveEnvelope(invalid, metadata)).toThrow();
  });
});

describe('mixed-version IndexedDB generations', () => {
  it('imports authentic v7 without rewriting source bytes, then explicitly saves v7 again', async () => {
    const h = await harness();
    const imported = await h.repository.importSave(v7Text, { ownerId: 'legacy-tab' });
    const before = await h.inspect();
    const loaded = await h.repository.loadSlot(slotId);
    expect(loaded.envelope.saveVersion).toBe(7);
    expect(loaded.migration).toBeNull();
    expect(loaded.snapshot.text).toBe(v7Text);
    expect((await h.repository.exportSlot(slotId)).text).toBe(v7Text);
    expect(await h.inspect()).toEqual(before);
    const saved = await h.repository.saveWorld(slotId, loaded.world, metadata, { expectedRevision: 1, lease: imported.lease });
    expect(saved.slot.revision).toBe(2);
    expect(peekSaveVersion(saved.snapshot.text)).toEqual({ ok: true, saveVersion: 7 });
    expect(await h.repository.exportRawSnapshot(slotId, imported.snapshot.id)).toBe(v7Text);
    expect((await h.inspect()).version).toBe(DATABASE_VERSION);
  });

  it('preserves original bytes and pointers when importing or loading mixed-authority v7 data', async () => {
    const h = await harness();
    const imported = await h.repository.importSave(v7Text, { ownerId: 'legacy-tab' });
    const world = createWorldV8('mixed-authority-storage');
    await h.repository.saveWorld(slotId, world, metadata, { expectedRevision: 1, lease: imported.lease });
    const invalidText = `\n ${editEnvelope(v7Text, (value) => {
      (value.payload as Record<string, unknown>).contentIdentity = world.contentIdentity;
    }, true)}\n`;
    const before = await h.inspect();
    await expect(h.repository.importSave(invalidText, { ownerId: 'rejected-tab', slotId: 'campaign-2' }))
      .rejects.toMatchObject({ code: 'INVALID_SAVE', saveErrorCode: 'INVALID_WORLD' });
    await expect(h.repository.importSave(invalidText, { mode: 'overwrite', slotId, expectedRevision: 2, lease: imported.lease }))
      .rejects.toMatchObject({ code: 'INVALID_SAVE', saveErrorCode: 'INVALID_WORLD' });
    expect(await h.inspect()).toEqual(before);

    await h.replaceText('campaign-1:2', invalidText);
    const beforeLoad = await h.inspect();
    const loaded = await h.repository.loadSlot(slotId);
    expect(loaded.recovered).toBe(true);
    expect(loaded.envelope.saveVersion).toBe(7);
    expect(loaded.slot.currentSnapshotId).toBe('campaign-1:2');
    expect(loaded.snapshot.id).toBe(imported.snapshot.id);
    expect(loaded.snapshot.text).toBe(v7Text);
    expect(loaded.issues).toEqual([{ snapshotId: 'campaign-1:2', code: 'INVALID_WORLD' }]);
    expect((await h.repository.exportSlot(slotId)).text).toBe(v7Text);
    expect(await h.repository.exportRawSnapshot(slotId, 'campaign-1:2')).toBe(invalidText);
    await expect(h.repository.saveWorld(slotId, world, metadata, { expectedRevision: 2, lease: imported.lease }))
      .rejects.toMatchObject({ code: 'CURRENT_SNAPSHOT_INVALID' });
    expect(await h.inspect()).toEqual(beforeLoad);
  });

  it('preserves whitespace on v8 import/export and permits a second v8 save after reopen', async () => {
    const h = await harness();
    const text = `\n ${JSON.stringify(JSON.parse(v8Text()), null, 2)}\n`;
    const imported = await h.repository.importSave(text, { ownerId: 'v8-tab' });
    expect(imported.snapshot.text).toBe(text);
    h.repository.close();
    const repository = await h.open();
    const before = await h.inspect();
    const loaded = await repository.loadSlot(slotId);
    expect(loaded.envelope.saveVersion).toBe(8);
    expect(loaded.migration).toBeNull();
    expect(loaded.snapshot.text).toBe(text);
    expect((await repository.exportSlot(slotId)).text).toBe(text);
    expect(await h.inspect()).toEqual(before);
    const saved = await repository.saveWorld(slotId, loaded.world, metadata, { expectedRevision: 1, lease: imported.lease });
    expect(saved.slot.revision).toBe(2);
    expect((await repository.loadSlot(slotId)).envelope.saveVersion).toBe(8);
    expect(await repository.exportRawSnapshot(slotId, imported.snapshot.id)).toBe(text);
    expect((await h.inspect()).version).toBe(1);
  });

  it('retains mixed v7/v8 generations with independent automatic rotation and explicit replacement', async () => {
    const h = await harness();
    const imported = await h.repository.importSave(v7Text, { ownerId: 'mixed-tab' });
    const world = createWorldV8('mixed-generations');
    for (let revision = 1; revision <= 4; revision++) {
      await h.repository.saveWorld(slotId, world, metadata, { expectedRevision: revision, lease: imported.lease });
    }
    const loaded = await h.repository.loadSlot(slotId);
    expect(loaded.slot.autoSnapshotIds).toEqual(['campaign-1:5', 'campaign-1:4', 'campaign-1:3']);
    expect(loaded.slot.manualSnapshotId).toBe(imported.snapshot.id);
    expect(loaded.envelope.saveVersion).toBe(8);
    expect(await h.repository.exportRawSnapshot(slotId, imported.snapshot.id)).toBe(v7Text);
    // This is an explicit import of exact v7 bytes, never implicit v8 demotion.
    const overwritten = await h.repository.importSave(v7Text, { mode: 'overwrite', slotId, expectedRevision: 5, lease: imported.lease });
    expect(overwritten.slot.revision).toBe(6);
    expect((await h.inspect()).snapshots.map((record) => record.id)).toEqual(['campaign-1:6']);
    expect((await h.repository.loadSlot(slotId)).envelope.saveVersion).toBe(7);
  });

  it('falls back across v8/v7 corruption read-only without repairing pointers or bytes', async () => {
    const h = await harness();
    const imported = await h.repository.importSave(v7Text, { ownerId: 'mixed-tab' });
    await h.repository.saveWorld(slotId, createWorldV8(), metadata, { expectedRevision: 1, lease: imported.lease });
    const corrupt = '{broken v8 generation';
    await h.replaceText('campaign-1:2', corrupt);
    const before = await h.inspect();
    const loaded = await h.repository.loadSlot(slotId);
    expect(loaded.recovered).toBe(true);
    expect(loaded.envelope.saveVersion).toBe(7);
    expect(loaded.slot.currentSnapshotId).toBe('campaign-1:2');
    expect(loaded.snapshot.id).toBe(imported.snapshot.id);
    expect(loaded.issues).toEqual([{ snapshotId: 'campaign-1:2', code: 'INVALID_JSON' }]);
    expect((await h.repository.exportSlot(slotId)).text).toBe(v7Text);
    expect(await h.repository.exportRawSnapshot(slotId, 'campaign-1:2')).toBe(corrupt);
    await expect(h.repository.saveWorld(slotId, createWorldV8(), metadata, { expectedRevision: 2, lease: imported.lease }))
      .rejects.toMatchObject({ code: 'CURRENT_SNAPSHOT_INVALID' });
    expect(await h.inspect()).toEqual(before);
  });

  it.each(['current', 'retained'] as const)('protects future-version %s records from save and explicit overwrite', async (target) => {
    const h = await harness();
    const imported = await h.repository.importSave(v8Text(), { ownerId: 'v8-tab' });
    await h.repository.saveWorld(slotId, createWorldV8(), metadata, { expectedRevision: 1, lease: imported.lease });
    const future = editEnvelope(v8Text(), (value) => { value.saveVersion = 9; }, true);
    const targetId = target === 'current' ? 'campaign-1:2' : imported.snapshot.id;
    await h.replaceText(targetId, future);
    const before = await h.inspect();
    const loaded = await h.repository.loadSlot(slotId);
    expect(loaded.recovered).toBe(target === 'current');
    expect(loaded.envelope.saveVersion).toBe(8);
    if (target === 'current') expect(loaded.issues).toEqual([{ snapshotId: targetId, code: 'UNSUPPORTED_SAVE_VERSION' }]);
    expect(await h.repository.exportRawSnapshot(slotId, targetId)).toBe(future);
    await expect(h.repository.saveWorld(slotId, createWorldV8(), metadata, { expectedRevision: 2, lease: imported.lease }))
      .rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED', saveErrorCode: 'UNSUPPORTED_SAVE_VERSION' });
    await expect(h.repository.importSave(v7Text, { mode: 'overwrite', slotId, expectedRevision: 2, lease: imported.lease }))
      .rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED' });
    expect(await h.inspect()).toEqual(before);
  });

  it.each(['simulation', 'content', 'identity'] as const)('protects unsupported v8 %s before any replacement can rotate it away', async (kind) => {
    const h = await harness();
    const imported = await h.repository.importSave(v8Text(), { ownerId: 'v8-tab' });
    const unsupported = editEnvelope(imported.snapshot.text, (value) => {
      if (kind === 'simulation') value.simulationVersion = '0.9.0';
      else if (kind === 'content') value.contentVersion = 'future-content';
      else (value.payload as Record<string, unknown>).contentIdentity = { manifestId: 'future-manifest' };
    }, true);
    const code = kind === 'simulation' ? 'UNSUPPORTED_SIMULATION_VERSION' : 'UNSUPPORTED_CONTENT_VERSION';
    expect(parseVersionedSave(unsupported)).toMatchObject({ ok: false, error: { code } });
    await h.replaceText(imported.snapshot.id, unsupported);
    const before = await h.inspect();
    await expect(h.repository.saveWorld(slotId, createWorldV8(), metadata, { expectedRevision: 1, lease: imported.lease }))
      .rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED', saveErrorCode: code });
    await expect(h.repository.importSave(v7Text, { mode: 'overwrite', slotId, expectedRevision: 1, lease: imported.lease }))
      .rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED', saveErrorCode: code });
    expect(await h.repository.exportRawSnapshot(slotId, imported.snapshot.id)).toBe(unsupported);
    expect(await h.inspect()).toEqual(before);
  });

  it('rejects invalid v8 and oversized UTF-8 imports before acquiring a lease or creating records', async () => {
    const h = await harness();
    const invalid = editEnvelope(v8Text(), (value) => { value.checksum = '00000000'; });
    const oversized = '界'.repeat(Math.floor(MAX_SAVE_FILE_BYTES / 3) + 1);
    const before = await h.inspect();
    await expect(h.repository.importSave(invalid, { ownerId: 'rejected-tab' }))
      .rejects.toMatchObject({ code: 'INVALID_SAVE', saveErrorCode: 'CHECKSUM_MISMATCH' });
    await expect(h.repository.importSave(oversized, { ownerId: 'rejected-tab' }))
      .rejects.toMatchObject({ code: 'INVALID_SAVE', saveErrorCode: 'TOO_LARGE' });
    expect(await h.inspect()).toEqual(before);
  });

  it('fences stale revisions and stale v8 writers without changing stored snapshots', async () => {
    const h = await harness();
    const imported = await h.repository.importSave(v8Text(), { ownerId: 'first-tab' });
    const second = await h.open();
    const replacementLease = await second.acquireLease(slotId, 'second-tab', { takeover: true });
    const before = await h.inspect();
    await expect(h.repository.saveWorld(slotId, createWorldV8(), metadata, { expectedRevision: 1, lease: imported.lease }))
      .rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(second.saveWorld(slotId, createWorldV8(), metadata, { expectedRevision: 0, lease: replacementLease }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await h.inspect()).toEqual(before);
    await second.saveWorld(slotId, createWorldV8(), metadata, { expectedRevision: 1, lease: replacementLease });
    expect((await second.loadSlot(slotId)).slot.revision).toBe(2);
  });

  it('validates read-back v8 text before switching the current pointer', async () => {
    let tamper = false;
    const h = await harness({ faultInjector: (stage, transaction) => {
      if (tamper && stage === 'after-snapshot') {
        transaction.objectStore('snapshots').put({ recordVersion: 1, id: 'campaign-1:2', slotId, revision: 2, kind: 'auto', text: '{broken' });
      }
    } });
    const imported = await h.repository.importSave(v8Text(), { ownerId: 'v8-tab' });
    const before = await h.inspect();
    tamper = true;
    await expect(h.repository.saveWorld(slotId, createWorldV8(), metadata, { expectedRevision: 1, lease: imported.lease }))
      .rejects.toMatchObject({ code: 'INVALID_SAVE' });
    expect(await h.inspect()).toEqual(before);
  });

  it.each<WriteStage>(['before-snapshot', 'after-snapshot', 'before-pointer', 'after-pointer', 'after-prune'])(
    'rolls back mixed-version snapshots and pointers after transaction abort at %s', async (abortAt) => {
      let armed = false;
      const h = await harness({ faultInjector: (stage, transaction) => { if (armed && stage === abortAt) transaction.abort(); } });
      const imported = await h.repository.importSave(v7Text, { ownerId: 'mixed-tab' });
      await h.repository.saveWorld(slotId, createWorldV8(), metadata, { expectedRevision: 1, lease: imported.lease });
      const before = await h.inspect();
      armed = true;
      await expect(h.repository.saveWorld(slotId, createWorldV8(), metadata, { expectedRevision: 2, lease: imported.lease }))
        .rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
      expect(await h.inspect()).toEqual(before);
    },
  );
});
