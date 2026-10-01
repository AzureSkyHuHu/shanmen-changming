import { readFileSync } from 'node:fs';
import { IDBFactory as FakeIDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { SAVE_VERSION, SIMULATION_VERSION, stableHash } from '../../src/core/kernel';
import { parseSaveFile } from '../../src/platform/files/save-files';
import {
  openSaveRepository, type IndexedDbSaveRepository, type SlotManifest, type SnapshotRecord,
} from '../../src/platform/persistence';

// Frozen from the real 0.1.1 core before the navigation/schema upgrade, not a downgraded v2 world.
const legacyText = readFileSync(new URL('./fixtures/save-v1-in-progress.json', import.meta.url), 'utf8');
const legacy = JSON.parse(legacyText) as {
  checksum: string;
  savedAt: string;
  buildId: string;
  seed: string;
  payload: { randomStreams: unknown; sequences: { nextEntity: number; nextAction: number; nextEvent: number; nextInstance: number }; inventory: unknown; commandReceipts: unknown };
};
const slotId = 'campaign-1' as const;
const legacyId = 'campaign-1:7';
const repositories: IndexedDbSaveRepository[] = [];

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
async function createStorage() {
  const factory = new FakeIDBFactory();
  const databaseName = 'migration-preservation';
  const repository = await openSaveRepository({ indexedDB: factory, databaseName, now: () => 1000 });
  repositories.push(repository);
  const raw = await request(factory.open(databaseName));
  return { repository, raw };
}
async function seedLegacy(raw: IDBDatabase, text = legacyText) {
  const snapshot: SnapshotRecord = { recordVersion: 1, id: legacyId, slotId, revision: 7, kind: 'auto', text };
  const slot: SlotManifest = {
    recordVersion: 1, slotId, revision: 7, currentSnapshotId: legacyId,
    autoSnapshotIds: [legacyId], manualSnapshotId: null, checkpointSnapshotId: null, savedAt: legacy.savedAt,
  };
  const transaction = raw.transaction(['slots', 'snapshots'], 'readwrite');
  const done = completion(transaction);
  await request(transaction.objectStore('snapshots').put(snapshot));
  await request(transaction.objectStore('slots').put(slot));
  await done;
}
async function inspect(raw: IDBDatabase) {
  const transaction = raw.transaction(['slots', 'snapshots', 'leases'], 'readonly');
  const done = completion(transaction);
  const values = await Promise.all(['slots', 'snapshots', 'leases'].map((name) => request<unknown[]>(transaction.objectStore(name).getAll())));
  await done;
  return values;
}
function withVersions(saveVersion: number, simulationVersion = SIMULATION_VERSION): string {
  const { checksum: _checksum, ...body } = JSON.parse(legacyText) as Record<string, unknown>;
  body.saveVersion = saveVersion;
  body.simulationVersion = simulationVersion;
  (body.payload as Record<string, unknown>).simulationVersion = simulationVersion;
  return JSON.stringify({ ...body, checksum: stableHash(body) });
}

afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });

describe('stored v1 migration and source preservation', () => {
  it('loads genuine v1 in-progress production into current v4 memory without rewriting any stored record', async () => {
    const { repository, raw } = await createStorage();
    try {
      await seedLegacy(raw);
      const before = await inspect(raw);
      const loaded = await repository.loadSlot(slotId);
      expect(SAVE_VERSION).toBe(7);
      expect(loaded.envelope.saveVersion).toBe(7);
      expect(loaded.envelope.simulationVersion).toBe(SIMULATION_VERSION);
      expect(loaded.migration).toEqual({ sourceSaveVersion: 1, sourceSimulationVersion: '0.1.1', sourceChecksum: legacy.checksum });
      expect(loaded.envelope.checksum).not.toBe(legacy.checksum);
      expect(loaded.snapshot.text).toBe(legacyText);
      expect(loaded.slot.revision).toBe(7);
      expect(loaded.slot.currentSnapshotId).toBe(legacyId);
      expect(loaded.recovered).toBe(false);
      expect(loaded.issues).toEqual([]);
      expect(loaded.envelope.savedAt).toBe(legacy.savedAt);
      expect(loaded.envelope.buildId).toBe(legacy.buildId);
      expect(loaded.world.seed).toBe(legacy.seed);
      expect(loaded.world.randomStreams).toEqual(legacy.payload.randomStreams);
      expect(loaded.world.sequences).toEqual({ ...legacy.payload.sequences, nextEntity: legacy.payload.sequences.nextEntity + 1, nextInstance: legacy.payload.sequences.nextInstance + 36 });
      expect(loaded.world.inventory).toEqual(legacy.payload.inventory);
      expect(loaded.world.commandReceipts).toEqual(legacy.payload.commandReceipts);
      expect(loaded.world.transactions['instance:1']?.activeTicks).toBe(47);
      expect(await inspect(raw)).toEqual(before);
      // File export deliberately returns the original v1 source, not the normalized envelope.
      const exported = await repository.exportSlot(slotId);
      expect(exported.text).toBe(legacyText);
      expect(JSON.parse(exported.text).saveVersion).toBe(1);
      expect(await repository.exportRawSnapshot(slotId, legacyId)).toBe(legacyText);
      expect(await inspect(raw)).toEqual(before);
    } finally { raw.close(); }
  });

  it('creates a separate v4 generation only after an explicit save and retains the original source', async () => {
    const { repository, raw } = await createStorage();
    try {
      await seedLegacy(raw);
      const loaded = await repository.loadSlot(slotId);
      const lease = await repository.acquireLease(slotId, 'upgrading-tab');
      const committed = await repository.saveWorld(slotId, loaded.world, {
        buildId: 'v4-explicit-save', savedAt: '2026-10-01T08:00:00Z',
      }, { expectedRevision: loaded.slot.revision, lease });
      expect(committed.slot.revision).toBe(8);
      expect(committed.slot.currentSnapshotId).toBe('campaign-1:8');
      expect(committed.slot.autoSnapshotIds).toEqual(['campaign-1:8', legacyId]);
      expect(JSON.parse(committed.snapshot.text).saveVersion).toBe(7);
      expect(await repository.exportRawSnapshot(slotId, legacyId)).toBe(legacyText);
      const current = await repository.loadSlot(slotId);
      expect(current.migration).toBeNull();
      expect(current.world).toEqual(loaded.world);
      expect((await inspect(raw))[1]).toHaveLength(2);
    } finally { raw.close(); }
  });

  it('imports supported v1 source text unchanged and exposes migration on subsequent load', async () => {
    const { repository, raw } = await createStorage();
    try {
      const parsed = parseSaveFile(legacyText);
      expect(parsed.ok && parsed.migration?.sourceSaveVersion).toBe(1);
      const imported = await repository.importSave(legacyText, { ownerId: 'importing-tab' });
      expect(imported.snapshot.text).toBe(legacyText);
      expect(JSON.parse(imported.snapshot.text).saveVersion).toBe(1);
      expect((await repository.loadSlot(imported.slot.slotId)).migration?.sourceChecksum).toBe(legacy.checksum);
      expect((await repository.exportSlot(imported.slot.slotId)).text).toBe(legacyText);
    } finally { raw.close(); }
  });

  it('validates original v1 checksum before migration and leaves a corrupt source untouched', async () => {
    const { repository, raw } = await createStorage();
    try {
      const damaged = legacyText.replace(legacy.checksum, '00000000');
      await seedLegacy(raw, damaged);
      const before = await inspect(raw);
      await expect(repository.loadSlot(slotId)).rejects.toMatchObject({
        code: 'NO_VALID_SNAPSHOT', issues: [{ snapshotId: legacyId, code: 'CHECKSUM_MISMATCH' }],
      });
      expect(await repository.exportRawSnapshot(slotId, legacyId)).toBe(damaged);
      expect(await inspect(raw)).toEqual(before);
    } finally { raw.close(); }
  });

  it('rejects future schema imports and loads while preserving their exact stored source', async () => {
    const { repository, raw } = await createStorage();
    try {
      const future = withVersions(SAVE_VERSION + 1);
      await seedLegacy(raw, future);
      const before = await inspect(raw);
      await expect(repository.loadSlot(slotId)).rejects.toMatchObject({
        code: 'NO_VALID_SNAPSHOT', issues: [{ code: 'UNSUPPORTED_SAVE_VERSION' }],
      });
      await expect(repository.importSave(future, { ownerId: 'importing-tab' })).rejects.toMatchObject({
        code: 'INVALID_SAVE', saveErrorCode: 'UNSUPPORTED_SAVE_VERSION',
      });
      expect(await repository.exportRawSnapshot(slotId, legacyId)).toBe(future);
      expect(await inspect(raw)).toEqual(before);
    } finally { raw.close(); }
  });

  it('continues rejecting pre-fix simulation 0.1.0 without guessing a migration', async () => {
    const { repository, raw } = await createStorage();
    try {
      const unsupported = withVersions(1, '0.1.0');
      await seedLegacy(raw, unsupported);
      const before = await inspect(raw);
      await expect(repository.loadSlot(slotId)).rejects.toMatchObject({
        code: 'NO_VALID_SNAPSHOT', issues: [{ code: 'UNSUPPORTED_SIMULATION_VERSION' }],
      });
      expect(await repository.exportRawSnapshot(slotId, legacyId)).toBe(unsupported);
      expect(await inspect(raw)).toEqual(before);
    } finally { raw.close(); }
  });
});
