import { describe, expect, it } from 'vitest';
import { ApplicationSession } from '../../src/application/session';
import { contentIdentity, LEGACY_V7_CONTENT, RELEASE_V8_CANDIDATE } from '../../src/content/registry';
import { getWorldContent, getWorldRunContent, getWorldBuildContentContext, getWorldRunEncounter, type WorldContentView } from '../../src/core/world/content-access';

const legacy = (): WorldContentView => ({ simulationVersion: '0.7.0', contentVersion: LEGACY_V7_CONTENT.worldContentVersion,
  expedition: { run: null } });
const release = (): WorldContentView => ({ simulationVersion: '0.8.0', contentVersion: RELEASE_V8_CANDIDATE.worldContentVersion,
  contentIdentity: contentIdentity(RELEASE_V8_CANDIDATE), expedition: { run: null, contentIdentity: null } });

describe('World and run content views', () => {
  it('preserves deliberate v7 selection without inventing build-v2 identity', () => {
    const view = legacy();
    expect(getWorldContent(view)).toBe(LEGACY_V7_CONTENT);
    expect(getWorldBuildContentContext(view)).toBeNull();
    expect(getWorldRunContent({ ...view, expedition: { run: { runId: 'old' } } })).toBe(LEGACY_V7_CONTENT);
  });
  it('selects current World definitions while an unfinished run stays on its frozen catalog', () => {
    const view = release(); view.expedition = { run: { runId: 'old' }, contentIdentity: contentIdentity(LEGACY_V7_CONTENT) };
    expect(getWorldContent(view)).toBe(RELEASE_V8_CANDIDATE);
    expect(getWorldRunContent(view)).toBe(LEGACY_V7_CONTENT);
    expect(getWorldBuildContentContext(view)?.catalog).toBe(RELEASE_V8_CANDIDATE.combat);
    expect(getWorldRunEncounter(view, LEGACY_V7_CONTENT.encounters[0]!.id)).toBe(LEGACY_V7_CONTENT.encounters[0]);
    expect(() => getWorldRunEncounter(view, 'encounter.not-registered')).toThrow();
  });
  it('uses current content when no run exists and accepts only explicitly pinned current runs', () => {
    const view = release();
    expect(getWorldRunContent(view)).toBe(RELEASE_V8_CANDIDATE);
    view.expedition = { run: { runId: 'new' }, contentIdentity: contentIdentity(RELEASE_V8_CANDIDATE) };
    expect(getWorldRunContent(view)).toBe(RELEASE_V8_CANDIDATE);
    expect(contentIdentity(RELEASE_V8_CANDIDATE)).toBe(contentIdentity(RELEASE_V8_CANDIDATE));
    expect(Object.isFrozen(getWorldRunContent(view))).toBe(true);
  });
  it('fails closed for missing, unknown, mismatched and rewritten identities', () => {
    expect(() => getWorldContent({ ...legacy(), simulationVersion: '0.8.0' })).toThrow();
    expect(() => getWorldContent({ ...release(), contentVersion: 'future' })).toThrow();
    expect(() => getWorldContent({ ...release(), contentIdentity: { ...contentIdentity(RELEASE_V8_CANDIDATE), compositeFingerprint: 'rewritten' } })).toThrow();
    expect(() => getWorldRunContent({ ...release(), expedition: { run: { runId: 'old' } } })).toThrow();
    expect(() => getWorldRunContent({ ...release(), expedition: { run: { runId: 'old' }, contentIdentity: { ...contentIdentity(LEGACY_V7_CONTENT), registryId: 'unknown' } } })).toThrow();
  });
  it('Session queries return immutable definitions without changing simulation or command sequence', () => {
    const session = new ApplicationSession(); const before = session.exportWorld();
    const catalog = session.getCombatCatalog(); const content = session.getRunContent();
    expect(catalog).toBe(content.combat); expect(Object.isFrozen(catalog)).toBe(true);
    session.getBuildContentContext(); session.getRunContent();
    expect(session.exportWorld()).toEqual(before);
  });
});
