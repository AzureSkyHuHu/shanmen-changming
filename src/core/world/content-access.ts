import { LEGACY_V7_CONTENT, resolveContentIdentity } from '../../content/registry';
import type { GameContentIdentity } from '../../content/registry';
import { resolveBuildContentContext } from '../../content/registry/build-context';
import type { BuildContentContext } from '../builds/v2-types';

/** Read-only structural port, valid for frozen v1–v7 sources and the coming v8 World. */
export interface WorldContentView {
  simulationVersion: string; contentVersion: string; contentIdentity?: Readonly<GameContentIdentity>;
  expedition: { run: { runId: string } | null; contentIdentity?: Readonly<GameContentIdentity> | null };
}
const legacyVersions = ['0.1.1', '0.2.0', '0.3.0', '0.4.0', '0.5.0', '0.6.0', '0.7.0'];
export function getWorldContent(world: WorldContentView) {
  if (world.contentIdentity === undefined && legacyVersions.includes(world.simulationVersion)
    && world.contentVersion === LEGACY_V7_CONTENT.worldContentVersion) return LEGACY_V7_CONTENT;
  const selected = resolveContentIdentity(world.contentIdentity, { allowCandidate: true });
  if (!selected || selected.worldContentVersion !== world.contentVersion) throw new TypeError('Unsupported World content identity');
  return selected;
}
export function getWorldRunContent(world: WorldContentView) {
  if (!world.expedition.run) return getWorldContent(world);
  if (world.expedition.contentIdentity === undefined && legacyVersions.includes(world.simulationVersion)) return LEGACY_V7_CONTENT;
  const selected = resolveContentIdentity(world.expedition.contentIdentity, { allowCandidate: true });
  if (!selected) throw new TypeError('Unsupported saved run content identity');
  return selected;
}
/** Null is the deliberate v7 UI compatibility path until the World schema is activated. */
export function getWorldBuildContentContext(world: WorldContentView): BuildContentContext | null {
  const selected = getWorldContent(world);
  return selected.buildRules.version === 1 ? null : resolveBuildContentContext(world.contentIdentity, { allowCandidate: true });
}
export const getWorldCombatCatalog = (world: WorldContentView) => getWorldContent(world).combat;
export const getWorldRunCombatCatalog = (world: WorldContentView) => getWorldRunContent(world).combat;
export function getWorldRunEncounter(world: WorldContentView, definitionId: string) {
  const definition = getWorldRunContent(world).encounters.find(entry => entry.id === definitionId);
  if (!definition) throw new TypeError('Unknown registered run encounter'); return definition;
}
