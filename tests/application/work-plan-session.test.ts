import { describe, expect, it } from 'vitest';
import { ApplicationSession } from '../../src/application/session';
import { workPlanSignature } from '../../src/application/work-plan-contract';
import { createWorld } from '../../src/core/kernel';

describe('fresh authority guards for work plan drafts', () => {
  it('rejects a changed plan or campaign epoch without consuming a command receipt', () => {
    const session = new ApplicationSession();
    const workerId = session.getSnapshot().disciples[1]!.id;
    const plan = { workerId, enabled: false, priorities: [{ recipeId: 'farm.grain', targetStock: 12 }] };
    const guard = { sessionEpoch: 0, workerId, expectedPlan: null, expectedEnabled: false };
    expect(session.dispatchSectEconomy({ kind: 'plan.set', plan }, guard).ok).toBe(true);
    const original = session.exportWorld();
    expect(session.dispatchSectEconomy({ kind: 'plan.set', plan: { ...plan, enabled: true } }, guard).ok).toBe(false);
    expect(session.exportWorld()).toEqual(original);
    const fresh = { ...guard, expectedPlan: workPlanSignature(plan) };
    expect(session.dispatchSectEconomy({ kind: 'plan.set', plan: { ...plan, enabled: true } }, fresh).ok).toBe(true);
    expect(session.getSnapshot().lastCommand?.commandId).toBe('app-command.1');
    session.replaceWorld(createWorld('different-campaign'));
    const replacement = session.exportWorld();
    expect(session.dispatchSectEconomy({ kind: 'plan.set', plan }, guard).ok).toBe(false);
    expect(session.exportWorld()).toEqual(replacement);
  });
  it('guards the global switch separately and keeps role/input pauses authoritative', () => {
    const session = new ApplicationSession();
    const guard = { sessionEpoch: 0, workerId: null, expectedPlan: null, expectedEnabled: false };
    expect(session.dispatchSectEconomy({ kind: 'enabled.set', enabled: true }, guard).ok).toBe(true);
    expect(session.dispatchSectEconomy({ kind: 'enabled.set', enabled: false }, guard).ok).toBe(false);
    const before = session.exportWorld();
    session.setOverlayPaused(true);
    expect(session.dispatchSectEconomy({ kind: 'enabled.set', enabled: false }, { ...guard, expectedEnabled: true }).ok).toBe(false);
    expect(session.exportWorld()).toEqual(before);
    session.setOverlayPaused(false); session.setStorageReadOnly(true);
    expect(session.dispatchSectEconomy({ kind: 'enabled.set', enabled: false }, { ...guard, expectedEnabled: true }).ok).toBe(false);
    expect(session.exportWorld()).toEqual(before);
  });
});
