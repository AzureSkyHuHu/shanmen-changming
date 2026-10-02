import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../content/sect-v10/world-content';
import type { SaveMetadata } from '../kernel/save';
import { parseSaveV9 } from '../kernel/save-v9';
import { createSaveEnvelopeV10, SaveCodecErrorV10 } from '../kernel/save-v10';
import { cloneJson } from '../kernel/serialization';
import { MANAGEMENT_V10_PROTOCOL, type MigrationIssueV10, type PreparedMigrationV10 } from '../sect-expansion/upgrade-types';
import { createSectUpgradeStateV10 } from '../sect-expansion/upgrade-validation';
import type { SaveFailureV9 } from './save-admission-v9';
import { admitSaveWorldV10, captureSaveDataV10 } from './save-admission-v10';
import { inspectQuietV9ToV10Boundary } from './v10-migration-boundary';

function sourceIssue(failure: SaveFailureV9): MigrationIssueV10 {
  switch (failure.error.code) {
    case 'UNSUPPORTED_SAVE_VERSION': return { code: 'UNSUPPORTED_SOURCE', path: 'saveVersion' };
    case 'UNSUPPORTED_SIMULATION_VERSION': return { code: 'UNSUPPORTED_SOURCE', path: 'simulationVersion' };
    case 'UNSUPPORTED_CONTENT_VERSION': return { code: 'UNSUPPORTED_SOURCE', path: 'contentIdentity' };
    case 'UNSUPPORTED_SCOPE': return { code: 'UNSUPPORTED_SOURCE', path: '$' };
    case 'TOO_LARGE': return { code: 'CAPACITY_EXCEEDED', path: '$' };
    default: return { code: 'INVALID_SOURCE', path: '$' };
  }
}

/** Pure, fixed .3 -> v10 preparation, never save authorization or a storage write.
 * The unchanged old parser is the FIRST gate, including its funded admission.
 * The existing quiet boundary then runs unchanged. Only their detached source is
 * lifted; old histories, field presence, ordering, IDs, clocks and RNG stay exact.
 *
 * Target records and future capacity are independently admitted in full. In
 * particular a journal accepted by the old parser can still be unsupported by
 * v10; it must reject, never be erased, renamed or given new provenance.
 * sourceText retains the caller's exact bytes-as-string, including whitespace and
 * key order. sourceChecksum is diagnostic only, not authorization or a backup.
 * A controller still owns read-only checks, current-source/session fencing,
 * source backup/readback, empty target selection and durable pointer commit.
 */
export function prepareV9ToV10Migration(sourceText: string, metadata: SaveMetadata): PreparedMigrationV10 {
  const parsed = parseSaveV9(sourceText);
  if (!parsed.ok) return { ok: false, issues: [sourceIssue(parsed)] };
  const issues = inspectQuietV9ToV10Boundary(parsed.world);
  if (issues.length) return { ok: false, issues };

  const source = parsed.world;
  const target = admitSaveWorldV10({ ...source,
    simulationVersion: MANAGEMENT_V10_PROTOCOL.simulationVersion,
    runtimeProtocol: MANAGEMENT_V10_PROTOCOL.runtimeProtocol,
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION,
    contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...source.sectExpansion, schemaVersion: MANAGEMENT_V10_PROTOCOL.sectSchemaVersion,
      upgrade: createSectUpgradeStateV10() },
  });
  if (!target.ok) return { ok: false, issues: [{
    code: target.error.code === 'TOO_LARGE' ? 'CAPACITY_EXCEEDED' : 'UNSUPPORTED_SOURCE', path: 'target',
  }] };

  // Capture before handing metadata to the codec. Any caught exception below is
  // produced from owned plain data; no caller-thrown Proxy error is inspected.
  const capturedMetadata = captureSaveDataV10(metadata);
  if (!capturedMetadata.ok) return { ok: false, issues: [{
    code: capturedMetadata.error.code === 'TOO_LARGE' ? 'CAPACITY_EXCEEDED' : 'INVALID_SOURCE', path: 'metadata',
  }] };
  try {
    const envelope = createSaveEnvelopeV10(target.world, capturedMetadata.value as SaveMetadata);
    return { ok: true, sourceText, sourceChecksum: parsed.envelope.checksum, world: target.world, envelope };
  } catch (error) {
    return { ok: false, issues: [{
      code: error instanceof SaveCodecErrorV10 && error.code === 'TOO_LARGE' ? 'CAPACITY_EXCEEDED' : 'INVALID_SOURCE',
      path: 'metadata',
    }] };
  }
}
