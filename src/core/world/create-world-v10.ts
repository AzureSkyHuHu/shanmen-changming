import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../content/sect-v10/world-content';
import { SaveCodecErrorV10 } from '../kernel/save-v10';
import { cloneJson } from '../kernel/serialization';
import { MANAGEMENT_V10_PROTOCOL, type WorldStateV10 } from '../sect-expansion/upgrade-types';
import { createSectUpgradeStateV10 } from '../sect-expansion/upgrade-validation';
import { createUnregisteredWorldV9 } from './create-world-v9';
import { admitSaveWorldV10 } from './save-admission-v10';

/** Fresh only, internal only. Reuse deterministic initial map/roster/RNG and the
 * frozen .3 permanent-build bootstrap. No World/import/continuation argument is
 * accepted. Existing saves must use prepareV9ToV10Migration and its source gates.
 * The constructor does not grant or register a runtime, Session or storage slot.
 */
export function createUnregisteredWorldV10(seed: string | number = 'shanmen-001'): WorldStateV10 {
  if (typeof seed !== 'string' && typeof seed !== 'number') throw new TypeError('Fresh v10 requires a string or number seed');
  const initial = createUnregisteredWorldV9(seed);
  const admitted = admitSaveWorldV10({ ...initial,
    simulationVersion: MANAGEMENT_V10_PROTOCOL.simulationVersion,
    runtimeProtocol: MANAGEMENT_V10_PROTOCOL.runtimeProtocol,
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION,
    contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...initial.sectExpansion, schemaVersion: MANAGEMENT_V10_PROTOCOL.sectSchemaVersion,
      upgrade: createSectUpgradeStateV10() },
  });
  if (!admitted.ok) throw new SaveCodecErrorV10(admitted);
  return admitted.world;
}
