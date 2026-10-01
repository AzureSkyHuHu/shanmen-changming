import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contentIdentity, LEGACY_V7_CONTENT, RELEASE_V8_CANDIDATE } from '../../src/content/registry';
import { migrateWorldV7ToV8 } from '../../src/core/kernel/migrate-v7';
import { validateLegacyWorldStateV7, validateWorldStateV8 } from '../../src/core/kernel/validation';
import { getWorldContent, getWorldRunContent } from '../../src/core/world/content-access';
import { cloneJson } from '../../src/core/kernel/serialization';
import type { LegacyWorldStateV7 } from '../../src/core/world/legacy-types';

function source(filename: string) {
  const text = readFileSync(new URL(`./fixtures/${filename}`, import.meta.url), 'utf8');
  return { text, world: (JSON.parse(text) as { payload: LegacyWorldStateV7 }).payload };
}
describe('additive frozen v7 to World v8 structural migration', () => {
  it.each(['save-v7-active-automatic.json', 'save-v7-active-battle.json', 'save-v7-awaiting-choice.json', 'save-v7-ended-clear.json'])(
    'preserves source %s and every current simulation resource/ID/RNG/auto boundary', filename => {
      const fixture = source(filename); const before = cloneJson(fixture.world);
      expect(validateLegacyWorldStateV7(fixture.world)).toEqual([]);
      const world = migrateWorldV7ToV8(fixture.world);
      expect(validateWorldStateV8(world)).toEqual([]);
      expect(world.simulationVersion).toBe('0.8.0'); expect(world.contentIdentity).toEqual(contentIdentity(RELEASE_V8_CANDIDATE));
      for (const key of ['clock', 'randomStreams', 'sequences', 'inventory', 'reservations', 'transactions', 'activeProductionTransactionIds', 'automaticProduction',
        'sectEconomy', 'events', 'history', 'commandReceipts', 'pendingCommands', 'map', 'buildings'] as const) expect(world[key]).toEqual(before[key]);
      expect(world.builds.disciples).toEqual(before.builds.disciples); expect(world.builds.receipts).toEqual(before.builds.receipts);
      expect(world.builds.history).toEqual(before.builds.history); expect(world.builds.origin).toEqual(before.builds.origin);
      expect(world.expedition.run).toEqual(before.expedition.run); expect(world.expedition.battle).toEqual(before.expedition.battle);
      expect(world.expedition.travel).toEqual(before.expedition.travel);
      expect(world.disciples.map(member => member.presentationId)).toEqual(['disciple-0', 'disciple-1', 'disciple-2', 'disciple-3']);
      expect(getWorldContent(world)).toBe(RELEASE_V8_CANDIDATE);
      if (before.expedition.run) expect(getWorldRunContent(world)).toBe(LEGACY_V7_CONTENT);
      expect(validateWorldStateV8(JSON.parse(JSON.stringify(world)))).toEqual([]);
      expect(fixture.world).toEqual(before); expect(readFileSync(new URL(`./fixtures/${filename}`, import.meta.url), 'utf8')).toBe(fixture.text);
    });

  it('imports only a complete genuine Ended clear, retaining its unique proof after normalization', () => {
    const world = migrateWorldV7ToV8(source('save-v7-ended-clear.json').world);
    expect(world.campaign.progress.clears).toHaveLength(1); expect(world.campaign.clearEvidence).toHaveLength(1);
    expect(world.campaign.progress.clears[0]!.routeId).toBe('route.qingfeng-trial');
    expect(world.campaign.clearEvidence[0]!.expedition.run).toEqual(world.expedition.run);
    expect(world.campaign.progress.claims).toEqual([]); expect(world.campaign.progress.mode).toBe('standard');
    const summaryOnly = source('save-v7-active-automatic.json').world;
    summaryOnly.unlocks.push('region.qingfeng.cleared'); expect(validateLegacyWorldStateV7(summaryOnly)).toEqual([]);
    expect(migrateWorldV7ToV8(summaryOnly).campaign.progress.clears).toEqual([]);
    const pending = migrateWorldV7ToV8(source('save-v7-awaiting-choice.json').world);
    expect(pending.campaign.progress.clears).toEqual([]); expect(pending.campaign.clearEvidence).toEqual([]);
  });

  it('captures legacy appearance once even if roster order previously differed', () => {
    const previous = source('save-v7-active-automatic.json').world;
    previous.disciples.reverse(); previous.cultivation.disciples.reverse();
    expect(validateLegacyWorldStateV7(previous)).toEqual([]);
    const world = migrateWorldV7ToV8(previous);
    const assigned = new Map(world.disciples.map(member => [member.id, member.presentationId]));
    world.disciples.reverse(); world.cultivation.disciples.reverse();
    expect(validateWorldStateV8(world)).toEqual([]);
    expect(world.disciples.every(member => member.presentationId === assigned.get(member.id))).toBe(true);
  });

  it('rejects mixed identities, forged first-clear evidence and unproven authority while preserving the candidate', () => {
    const valid = migrateWorldV7ToV8(source('save-v7-ended-clear.json').world);
    const badIdentity = { ...valid, contentIdentity: { ...valid.contentIdentity, registryId: 'content.future' } };
    expect(validateWorldStateV8(badIdentity)).toContain('Unsupported World content identity');
    const badRun = cloneJson(valid); badRun.expedition.contentIdentity = cloneJson(valid.contentIdentity);
    expect(validateWorldStateV8(badRun).length).toBeGreaterThan(0);
    const badProof = cloneJson(valid);
    const proof = badProof.campaign.clearEvidence[0]!;
    proof.routeId = 'route.everbright-finale';
    expect(validateWorldStateV8(badProof).length).toBeGreaterThan(0);
    const orphan = cloneJson(valid); orphan.campaign.clearEvidence = [];
    expect(validateWorldStateV8(orphan)).toContain('Campaign clear proof count differs');
    const before = cloneJson(valid); expect(validateWorldStateV8(valid)).toEqual([]); expect(valid).toEqual(before);
    expect(() => migrateWorldV7ToV8({ ...source('save-v7-ended-clear.json').world, simulationVersion: '0.9.0' })).toThrow();
  });
});
