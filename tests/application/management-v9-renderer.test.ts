import { describe, expect, it, vi } from 'vitest';
import { ApplicationSession } from '../../src/application/session';
import { createManagementV9RendererSource, projectManagementV9Renderer, type ManagementV9RendererInput, type ManagementV9RendererPort } from '../../src/application/management-v9-renderer';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { projectRuntimeExpansionV9, projectRuntimeFrameV9 } from '../../src/core/world/runtime-views-v9';
import type { RuntimeExpansionJobV9, RuntimeExpansionViewV9, RuntimeFrameViewV9 } from '../../src/core/world/runtime-view-types-v9';
import { asSectRendererSource, createLegacySectRendererSource, projectLegacySectRenderer, sectPlacementCellAt, sectRenderEntityKey,
  sectVisualWorkProgress, subscribeSectRenderer, type LegacySectRendererSession, type SectPlacementRenderPreview, type SectRendererSelection } from '../../src/phaser/sect-renderer-contract';
import type { PhaserWorldProps } from '../../src/phaser/PhaserWorld';

// Synthetic bounded DTO scenarios test rendering only; they are never fed back into authority.
const fresh = createUnregisteredWorldV9('renderer-view-fixture');
const baseFrame = projectRuntimeFrameV9(fresh);
const baseExpansion = projectRuntimeExpansionV9(fresh);
function fixture(): { frame: RuntimeFrameViewV9; expansion: RuntimeExpansionViewV9; selection: SectRendererSelection; paused: boolean } {
  return { frame: structuredClone(baseFrame), expansion: structuredClone(baseExpansion), selection: null, paused: false };
}
const footprint = { cells: [{ x: 2, y: 3 }, { x: 3, y: 3 }, { x: 2, y: 4 }, { x: 3, y: 4 }], entrance: { x: 2, y: 5 } };
function blueprint(input: ReturnType<typeof fixture>, status: 'planned' | 'started' = 'planned'): void {
  input.expansion.blueprints.push({ definitionId: 'library.v9', anchor: { x: 2, y: 3 }, rotation: 0,
    blueprintId: 'blueprint:1', status, jobId: status === 'started' ? 'job:1' : null, footprint: structuredClone(footprint) });
}
function construction(input: ReturnType<typeof fixture>): Extract<RuntimeExpansionJobV9, { domain: 'construction' }> {
  return { domain: 'construction', jobId: 'job:1', blueprintId: 'blueprint:1', workerId: input.frame.disciples[0]!.id,
    phase: 'working', activeTicks: 10, requiredTicks: 40, blocked: null };
}
function portFor(initial: ManagementV9RendererInput) {
  let input = initial;
  const observers = new Set<() => void>();
  const select = vi.fn();
  const stops = vi.fn();
  const port: ManagementV9RendererPort = {
    getSnapshot: () => input, select,
    subscribe: listener => { observers.add(listener); return () => { stops(); observers.delete(listener); }; },
  };
  return { port, observers, select, stops, publish: (next: ManagementV9RendererInput) => { input = next; for (const notify of observers) notify(); } };
}

describe('bounded v9 renderer mapping', () => {
  it('extracts only the actual terrain, live actors, legacy stations, clock, selection and work', () => {
    const input = fixture();
    Object.defineProperty(input.frame, 'resources', { get: () => { throw new Error('Not renderer data'); } });
    Object.defineProperty(input.expansion, 'recentTerminals', { get: () => { throw new Error('Not renderer data'); } });
    const view = projectManagementV9Renderer(input);
    expect(Object.keys(view).sort()).toEqual(['buildings', 'clock', 'disciples', 'expansion', 'map', 'paused', 'placement', 'selection']);
    expect(view.map.tiles).toEqual(input.frame.map.tiles);
    expect(view.disciples.map(row => row.id)).toEqual(input.frame.disciples.map(row => row.id));
    expect(view.buildings).toHaveLength(8);
    expect(view.clock).toEqual({ simulationTick: input.frame.clock.simulationTick });
    expect(view.disciples[0]).not.toHaveProperty('assignmentTransactionId');
    expect(view).not.toHaveProperty('transactions');
    expect(view).not.toHaveProperty('sectEconomy');
  });

  it('copies and freezes its own output without freezing or mutating the bounded input', () => {
    const input = fixture(); blueprint(input);
    input.selection = { kind: 'blueprint', id: 'blueprint:1' };
    const before = structuredClone(input);
    const view = projectManagementV9Renderer(input);
    expect(input).toEqual(before);
    expect(Object.isFrozen(input.frame)).toBe(false);
    expect(Object.isFrozen(input.expansion.blueprints[0]!.footprint.cells)).toBe(false);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.map.tiles[0])).toBe(true);
    expect(Object.isFrozen(view.expansion[0]!.footprint.entrance)).toBe(true);
    input.frame.disciples[0]!.position.x += 4;
    (input.expansion.blueprints[0]!.footprint.cells as { x: number; y: number }[])[0] = { x: 8, y: 8 };
    expect(view.disciples[0]!.position).toEqual(before.frame.disciples[0]!.position);
    expect(view.expansion[0]!.footprint.cells).toEqual(before.expansion.blueprints[0]!.footprint.cells);
    expect(() => { (view.disciples[0]!.position as { x: number }).x = 8; }).toThrow();
  });

  it('keeps saved presentation IDs and authoritative positions when the roster order changes', () => {
    const input = fixture(); input.frame.disciples.reverse();
    const view = projectManagementV9Renderer(input);
    expect(view.disciples.map(row => row.presentationId)).toEqual(input.frame.disciples.map(row => row.presentationId));
    expect(view.disciples.map(row => row.position)).toEqual(input.frame.disciples.map(row => row.position));
  });

  it.each(['construction', 'sect-production', 'research', 'care'] as const)('uses the actual %s owner and actor instead of legacy assignment IDs', kind => {
    const input = fixture(); const actor = input.frame.disciples[0]!;
    const common = { jobId: 'sect-job:1', activeTicks: 10, blocked: null };
    const job: RuntimeExpansionJobV9 = kind === 'construction' ? { ...common, domain: 'construction', blueprintId: 'blueprint:1', workerId: actor.id, phase: 'working', requiredTicks: 40 }
      : kind === 'sect-production' ? { ...common, domain: 'production', recipeId: 'gather.stone.v9', workerId: actor.id, phase: 'Working', requiredTicks: 100 }
        : kind === 'research' ? { ...common, domain: 'research', researchId: 'basic-medicine.v9', workerId: actor.id, phase: 'working', requiredTicks: 200 }
          : { ...common, domain: 'care', patientId: actor.id, phase: 'working', requiredTicks: 40 };
    input.expansion.jobs.push(job);
    input.expansion.workOwners.push({ kind, id: job.jobId, workerId: actor.id });
    actor.assignmentTransactionId = null;
    const before = structuredClone(input);
    const view = projectManagementV9Renderer(input);
    expect(view.disciples[0]!.work).toEqual({ kind, ownerId: job.jobId, activeTicks: 10, requiredTicks: job.requiredTicks, blocked: false });
    expect(view.disciples[1]!.work).toBeNull();
    expect(input).toEqual(before);
    expect(actor.assignmentTransactionId).toBeNull();
  });

  it('requires an explicit legacy owner and matching worker, even if an assignment ID is present', () => {
    const input = fixture(); const actor = input.frame.disciples[0]!;
    actor.assignmentTransactionId = 'legacy:1';
    input.frame.transactions.push({ transactionId: 'legacy:1', workerId: actor.id, recipeId: 'gather.wood', state: 'Blocked',
      activeTicks: 7, requiredTicks: 40, phase: 'Working', blockedReason: 'PATH_BLOCKED' });
    expect(projectManagementV9Renderer(input).disciples[0]!.work).toBeNull();
    input.expansion.workOwners.push({ kind: 'legacy-production', id: 'legacy:1', workerId: actor.id });
    expect(projectManagementV9Renderer(input).disciples[0]!.work).toEqual({ kind: 'legacy-production', ownerId: 'legacy:1', activeTicks: 7, requiredTicks: 40, blocked: true });
    input.frame.transactions[0]!.workerId = input.frame.disciples[1]!.id;
    expect(projectManagementV9Renderer(input).disciples[0]!.work).toBeNull();
  });

  it('does not invent progress for missing, ambiguous, terminal, or wrong-domain owners', () => {
    const input = fixture(); const job = construction(input); input.expansion.jobs.push(job);
    const actor = input.frame.disciples[0]!;
    expect(projectManagementV9Renderer(input).disciples[0]!.work).toBeNull();
    input.expansion.workOwners.push({ kind: 'research', id: job.jobId, workerId: actor.id });
    expect(projectManagementV9Renderer(input).disciples[0]!.work).toBeNull();
    input.expansion.workOwners[0]!.kind = 'construction';
    expect(projectManagementV9Renderer(input).disciples[0]!.work?.ownerId).toBe(job.jobId);
    input.expansion.workOwners.push({ kind: 'care', id: 'another', workerId: actor.id });
    expect(projectManagementV9Renderer(input).disciples[0]!.work).toBeNull();
    input.expansion.workOwners.pop(); input.expansion.jobs[0] = { ...job, phase: 'completed' };
    expect(projectManagementV9Renderer(input).disciples[0]!.work).toBeNull();
  });

  it('derives planned, active construction and completed overlays from their distinct real view rows', () => {
    const input = fixture(); blueprint(input);
    let view = projectManagementV9Renderer(input);
    expect(view.expansion[0]).toMatchObject({ kind: 'blueprint', status: 'planned', work: null, footprint });
    input.expansion.blueprints[0]!.status = 'started'; input.expansion.blueprints[0]!.jobId = 'job:1';
    const job = construction(input); input.expansion.jobs.push(job);
    input.expansion.workOwners.push({ kind: 'construction', id: job.jobId, workerId: input.frame.disciples[0]!.id });
    view = projectManagementV9Renderer(input);
    expect(view.expansion[0]).toMatchObject({ kind: 'blueprint', status: 'started', work: { ownerId: 'job:1', activeTicks: 10, requiredTicks: 40 } });
    input.expansion.blueprints = []; input.expansion.jobs = []; input.expansion.workOwners = [];
    for (const definitionId of ['library.v9', 'alchemy.v9'] as const) input.expansion.buildings.push({ definitionId,
      buildingId: definitionId, anchor: { x: 2, y: 3 }, rotation: 90, level: definitionId === 'alchemy.v9' ? 2 : 1,
      footprint: structuredClone(footprint), maintenance: { buildingId: definitionId, operational: definitionId === 'library.v9', dueCalendarTick: 1200, deficits: [], renewalBlock: null } });
    view = projectManagementV9Renderer(input);
    expect(view.expansion.map(row => row.kind)).toEqual(['sect-building', 'sect-building']);
    expect(view.expansion[1]).toMatchObject({ definitionId: 'alchemy.v9', level: 2, operational: false });
    expect(view.buildings).toHaveLength(8);
    expect(view.buildings.some(row => row.blueprintId.endsWith('.v9'))).toBe(false);
    expect(view.map.tiles).toEqual(baseFrame.map.tiles);
  });

  it('cannot borrow another construction job progress for a blueprint', () => {
    const input = fixture(); blueprint(input, 'started');
    const job = construction(input); input.expansion.jobs.push({ ...job, blueprintId: 'other-blueprint' });
    input.expansion.workOwners.push({ kind: 'construction', id: job.jobId, workerId: input.frame.disciples[0]!.id });
    expect(projectManagementV9Renderer(input).expansion[0]).toMatchObject({ work: null });
  });

  it('keeps effective Session pause and authoritative clock pause without changing ticks', () => {
    const input = fixture(); input.frame.clock.simulationTick = 19;
    input.paused = true;
    expect(projectManagementV9Renderer(input)).toMatchObject({ clock: { simulationTick: 19 }, paused: true });
    input.paused = false; input.frame.clock.pauseReasons = ['hidden'];
    expect(projectManagementV9Renderer(input).paused).toBe(true);
    input.frame.clock.pauseReasons = [];
    expect(projectManagementV9Renderer(input).paused).toBe(false);
  });
});

describe('renderer source compatibility, selection and cleanup', () => {
  it('still accepts a real legacy Session with unchanged source and React props signatures', () => {
    const session = new ApplicationSession(); const legacy: LegacySectRendererSession = session;
    const props: PhaserWorldProps = { session, locale: 'zh-CN' }; expect(props.session).toBe(session);
    const source = asSectRendererSource(legacy);
    const original = session.getSnapshot(); const view = source.getSnapshot();
    expect(source.getSnapshot()).toBe(view);
    expect(view).toEqual(projectLegacySectRenderer(original));
    expect(view.expansion).toEqual([]); expect(view.placement).toBeNull();
    source.select({ kind: 'building', id: original.buildings[0]!.id });
    expect(session.getSnapshot().selection).toEqual({ kind: 'building', id: original.buildings[0]!.id });
    expect(source.getSnapshot()).not.toBe(view);
    source.select({ kind: 'sect-building', id: 'new-kind' });
    expect(session.getSnapshot().selection).toEqual({ kind: 'building', id: original.buildings[0]!.id });
    source.select(null); expect(session.getSnapshot().selection).toBeNull();
  });

  it('retains legacy production progress via its original assignment lookup', () => {
    const session = new ApplicationSession();
    const id = session.getSnapshot().disciples.find(row => row.canWork)!.id;
    const result = session.dispatch({ kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: id } });
    const source = createLegacySectRendererSource(session);
    const original = session.getSnapshot(); const transaction = original.transactions.find(row => row.transactionId === result.transactionId)!;
    expect(source.getSnapshot().disciples.find(row => row.id === id)!.work).toEqual({ kind: 'legacy-production', ownerId: transaction.transactionId,
      activeTicks: transaction.activeTicks, requiredTicks: transaction.requiredTicks, blocked: transaction.state === 'Blocked' });
  });

  it('accepts only the bounded v9 Session port, forwards selection, and caches unchanged views', () => {
    const input = fixture(); const fake = portFor(input);
    Object.defineProperty(fake.port, 'snapshot', { get: () => { throw new Error('No full World snapshot access'); } });
    Object.defineProperty(fake.port, 'exportWorld', { get: () => { throw new Error('No export access'); } });
    const source = createManagementV9RendererSource(fake.port);
    expect(asSectRendererSource(source)).toBe(source);
    const snapshot = source.getSnapshot(); expect(source.getSnapshot()).toBe(snapshot);
    fake.publish({ ...input }); expect(source.getSnapshot()).toBe(snapshot);
    for (const kind of ['disciple', 'building', 'blueprint', 'sect-building'] as const) {
      const selection = { kind, id: 'same-id' }; source.select(selection);
      expect(fake.select).toHaveBeenLastCalledWith(selection);
      fake.publish({ ...input, selection }); expect(source.getSnapshot().selection).toEqual(selection);
    }
    expect(sectRenderEntityKey({ kind: 'building', id: 'same-id' })).not.toBe(sectRenderEntityKey({ kind: 'sect-building', id: 'same-id' }));
  });

  it('unsubscribes once and ignores an already queued publication after disposal', () => {
    const fake = portFor(fixture()); const source = createManagementV9RendererSource(fake.port); const update = vi.fn();
    const stop = subscribeSectRenderer(source, update);
    const queued = [...fake.observers][0]!;
    queued(); expect(update).toHaveBeenCalledTimes(1);
    stop(); stop(); queued();
    expect(fake.stops).toHaveBeenCalledTimes(1); expect(fake.observers.size).toBe(0);
    expect(update).toHaveBeenCalledTimes(1);
    source.setPlacementPreview({ anchor: { x: 2, y: 3 }, footprint, allowed: true });
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe('read-only placement overlay', () => {
  it('copies the advisory footprint, deduplicates equivalent updates, and never changes terrain or selection', () => {
    const input = fixture(); const fake = portFor(input); const click = vi.fn();
    const source = createManagementV9RendererSource(fake.port, { onPlacementCell: click });
    const update = vi.fn(); const stop = source.subscribe(update); const before = structuredClone(input);
    const preview: SectPlacementRenderPreview = { anchor: { x: 2, y: 3 }, footprint: structuredClone(footprint), allowed: true };
    source.setPlacementPreview(preview); source.setPlacementPreview(structuredClone(preview));
    expect(update).toHaveBeenCalledTimes(1);
    expect(source.getSnapshot().placement).toEqual(preview);
    expect(source.getSnapshot().placement).not.toBe(preview);
    expect(Object.isFrozen(preview.footprint)).toBe(false);
    source.onPlacementCell?.({ x: 4, y: 2 });
    expect(click).toHaveBeenCalledTimes(1); expect(click).toHaveBeenCalledWith({ x: 4, y: 2 });
    expect(fake.select).not.toHaveBeenCalled(); expect(input).toEqual(before);
    expect(source.getSnapshot().map.tiles).toEqual(before.frame.map.tiles);
    source.setPlacementPreview(null); source.onPlacementCell?.({ x: 5, y: 2 });
    expect(click).toHaveBeenCalledTimes(1); expect(source.getSnapshot().placement).toBeNull();
    stop(); source.setPlacementPreview(preview); expect(update).toHaveBeenCalledTimes(2);
  });

  it('shows geometry-less rejection and bounds the preview to the four actual footprint cells', () => {
    const source = createManagementV9RendererSource(portFor(fixture()).port);
    source.setPlacementPreview({ anchor: { x: -1, y: 3 }, footprint: null, allowed: false });
    expect(source.getSnapshot().placement).toEqual({ anchor: { x: -1, y: 3 }, footprint: null, allowed: false });
    expect(() => source.setPlacementPreview({ anchor: { x: 0, y: 0 }, footprint: { ...footprint, cells: [...footprint.cells, { x: 9, y: 9 }] }, allowed: true })).toThrow(RangeError);
    expect(() => source.setPlacementPreview({ anchor: { x: NaN, y: 0 }, footprint: null, allowed: false })).toThrow(TypeError);
  });

  it('maps only in-map camera-world coordinates while placement is active', () => {
    const source = createManagementV9RendererSource(portFor(fixture()).port); const origin = { x: 128, y: 68 };
    expect(sectPlacementCellAt(source.getSnapshot(), 129, 69, origin, 64)).toBeNull();
    source.setPlacementPreview({ anchor: { x: 2, y: 3 }, footprint, allowed: true });
    const view = source.getSnapshot();
    expect(sectPlacementCellAt(view, 128 + 2 * 64 + 63, 68 + 3 * 64, origin, 64)).toEqual({ x: 2, y: 3 });
    for (const [x, y] of [[127, 69], [129, 67], [128 + view.map.width * 64, 69], [129, 68 + view.map.height * 64], [NaN, 69]]) {
      expect(sectPlacementCellAt(view, x!, y!, origin, 64)).toBeNull();
    }
  });

  it('uses a bounded visual fraction, with no synthetic elapsed or predicted work', () => {
    expect(sectVisualWorkProgress(null)).toBeNull();
    const work = { kind: 'construction' as const, ownerId: 'job:1', activeTicks: 10, requiredTicks: 40, blocked: false };
    expect(sectVisualWorkProgress(work)).toBe(0.25);
    expect(sectVisualWorkProgress({ ...work, requiredTicks: 0 })).toBeNull();
    expect(sectVisualWorkProgress({ ...work, activeTicks: Infinity })).toBeNull();
    expect(sectVisualWorkProgress({ ...work, activeTicks: 50 })).toBe(1);
  });
});
