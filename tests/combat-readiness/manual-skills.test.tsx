import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { combatCatalog } from '../../src/content/definitions';
import { createBattle, issueCommand, prepareCombatCatalog, stepBattle } from '../../src/core/combat';
import { createCombatController, issueTacticalOrder, restoreCombatController, serializeCombatController } from '../../src/core/combat/ai';
import type { CombatControllerState, TacticalCommand } from '../../src/core/combat/ai';
import { BattlePanel, dispatchBattleSkill } from '../../src/app/BattlePanel';
import type { BattlePanelProps } from '../../src/app/BattlePanel';

// Exercise the real generated button handlers without requiring a Phaser/DOM runtime.
// Hooks retain their slots across rerenders, including the latest-props dispatch ref.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0 }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useEffect: () => undefined, useId: () => 'manual-skills', useMemo: <T,>(fn: () => T) => fn(),
    useState: <T,>(initial: T | (() => T)) => { const index = hooks.index++; if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial; return [hooks.slots[index] as T, (value: T) => { hooks.slots[index] = value; }]; },
    useRef: <T,>(initial: T) => { const index = hooks.index++; if (!(index in hooks.slots)) hooks.slots[index] = { current: initial }; return hooks.slots[index] as { current: T }; },
  };
});
const catalog = prepareCombatCatalog(combatCatalog); const A = 'entity:1'; const E = 'entity:2';
const arena = { origin: { x: 0, y: 0 }, widthCells: 12, heightCells: 5, cellSizeUnits: 20, blockedCells: [] };
function control(skills = ['skill.budong-shan', 'skill.liuhen-jian', 'skill.jianxin']): CombatControllerState { return createCombatController(catalog, createBattle(catalog, { seed: 'manual-skills', contentMode: 'experimental', entities: [
  { id: A, team: 'party', position: { x: 0, y: 0 }, stats: { attack: 10, maxHealth: 100 }, skills },
  { id: E, team: 'enemy', position: { x: 40, y: 0 }, stats: { attack: 10, maxHealth: 100 } },
] }), { playerTeam: 'party', arena }); }
const noop = () => undefined;
function render(controller: CombatControllerState, onTacticalOrder: (command: TacticalCommand) => void, options: Partial<BattlePanelProps> = {}) { hooks.index = 0; return BattlePanel({ controller, catalog, locale: 'en', paused: false, speed: 1, onPausedChange: noop, onSpeedChange: noop, onTacticalOrder, ...options }); }
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>; return [element, ...elements(element.props['children'] as ReactNode)];
}
const skillButton = (tree: ReactNode, id: string) => elements(tree).find(item => item.type === 'button' && item.props['data-skill-id'] === id)!;
const click = (element: ReactElement<Record<string, unknown>>) => (element.props['onClick'] as () => void)();
beforeEach(() => { hooks.slots = []; hooks.index = 0; });

describe('manual equipped-skill controls', () => {
  it('renders real equipped active/ultimate buttons, excludes passives and dispatches the paused self ultimate', () => {
    const initial = control(); let current = initial; const orders: TacticalCommand[] = [];
    expect(initial.config.policies[A]!.allowUltimates).toBe(false);
    const tree = render(initial, order => { orders.push(order); current = issueTacticalOrder(current, catalog, order); }, { paused: true });
    const ultimate = skillButton(tree, 'skill.budong-shan'); expect(ultimate).toBeDefined(); expect(ultimate.props['disabled']).toBe(false);
    expect(skillButton(tree, 'skill.liuhen-jian')).toBeDefined(); expect(skillButton(tree, 'skill.jianxin')).toBeUndefined();
    click(ultimate); click(ultimate);
    expect(orders).toEqual([{ kind: 'cast', actorId: A, skillId: 'skill.budong-shan', targetId: A }]);
    expect(current.battle.entities[A]!.reservedSpirit).toBe(70); expect(current.battle.tick).toBe(initial.battle.tick);
  });
  it('uses the selected enemy as the target while keeping the allied commander as the actor', () => {
    const orders: TacticalCommand[] = []; const initial = control(); let tree = render(initial, order => orders.push(order));
    expect(skillButton(tree, 'skill.liuhen-jian').props['disabled']).toBe(true);
    const enemy = elements(tree).find(item => item.type !== 'button' && item.props['title'] === 'Hostiles')!;
    expect(enemy).toBeDefined(); (enemy.props['onSelect'] as (id: string) => void)(E);
    tree = render(initial, order => orders.push(order)); expect(skillButton(tree, 'skill.liuhen-jian').props['disabled']).toBe(false);
    click(skillButton(tree, 'skill.liuhen-jian'));
    expect(orders).toEqual([{ kind: 'cast', actorId: A, skillId: 'skill.liuhen-jian', targetId: E }]);
  });
  it('rechecks latest readonly props even when invoking a previously rendered enabled button', () => {
    const orders: TacticalCommand[] = []; const initial = control(); const oldButton = skillButton(render(initial, order => orders.push(order)), 'skill.budong-shan');
    expect(oldButton.props['disabled']).toBe(false);
    const locked = render(initial, order => orders.push(order), { readOnly: true }); expect(skillButton(locked, 'skill.budong-shan').props['disabled']).toBe(true);
    click(oldButton); expect(orders).toHaveLength(0);
  });
  it('rechecks latest controller locks before dispatching an old handler', () => {
    const orders: TacticalCommand[] = []; const initial = control(); const oldButton = skillButton(render(initial, order => orders.push(order)), 'skill.budong-shan');
    const casting = issueTacticalOrder(initial, catalog, { kind: 'cast', actorId: A, skillId: 'skill.liuhen-jian', targetId: E });
    render(casting, order => orders.push(order)); click(oldButton); expect(orders).toHaveLength(0);
  });
  it('keeps equipped ultimates manually usable after restoring a save with the old false AI policy', () => {
    const initial = control(); const restored = restoreCombatController(serializeCombatController(initial), catalog, initial.configHash); const orders: TacticalCommand[] = [];
    click(skillButton(render(restored, order => orders.push(order)), 'skill.budong-shan'));
    expect(orders).toEqual([{ kind: 'cast', actorId: A, skillId: 'skill.budong-shan', targetId: A }]);
  });
  it('never accepts an enemy or summon as a commander and never emits raw interrupt/finish commands', () => {
    let initial = control(['skill.zhikui']); const summoned = stepBattle(issueCommand(initial.battle, catalog, { kind: 'cast', actorId: A, skillId: 'skill.zhikui', targetId: A }), catalog, 24);
    initial = createCombatController(catalog, summoned, { playerTeam: 'party', arena }); const orders: TacticalCommand[] = [];
    for (const commanderId of [E, summoned.summons[0]!.entityId]) expect(dispatchBattleSkill({ controller: initial, catalog, commanderId, selectedTargetId: E, readOnly: false, onTacticalOrder: order => orders.push(order) }, 'skill.zhikui')).toBe(false);
    expect(orders).toHaveLength(0);
  });
});
