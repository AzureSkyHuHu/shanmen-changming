import type { SectCell } from '../../../content/sect-v9/types';
import { cloneJson } from '../../kernel/serialization';
import { deriveSectFootprint } from '../../sect-expansion/layout';
import type { RelocationEligibilityExclusion, RelocationOwnerClaim, RelocationOwnerDraft, RelocationOwnerFrame, RelocationOwnershipProjection, RelocationProjectionIssue, RelocationWorkOwner, RelocationWorkOwnerRef } from './types';

const cellKey = (cell: SectCell): string => `${cell.x},${cell.y}`;
const sameOwner = (a: RelocationWorkOwnerRef, b: RelocationWorkOwnerRef): boolean => a.domain === b.domain && a.id === b.id;
const ref = (owner: RelocationWorkOwnerRef): RelocationWorkOwnerRef => ({ domain: owner.domain, id: owner.id });

/** Typed diagnostic projection, NOT record validation, eligibility admission or a
 * historical-placement proof. Conflicts stay visible rather than selecting a winner. */
export function projectRelocationOwnership(source: RelocationOwnerDraft): RelocationOwnershipProjection {
  const owners: RelocationWorkOwner[] = [];
  const claims: RelocationOwnerClaim[] = [];
  const issues: RelocationProjectionIssue[] = [];
  const exclusions: RelocationEligibilityExclusion[] = [];
  const books = source.domains;
  const issue = (code: RelocationProjectionIssue['code'], key: string, entries: readonly RelocationWorkOwnerRef[] = []): void => {
    issues.push({ code, key, owners: entries.map(ref) });
  };
  const add = (owner: RelocationWorkOwner): void => { owners.push(owner); };
  for (const job of [...Object.values(source.transactions), ...Object.values(source.automaticProduction.live).map(entry => entry.transaction)]) {
    if (job.state === 'Committed' || job.state === 'Cancelled' || job.phase === 'Done' || job.phase === 'Cancelled') continue;
    add({ domain: 'legacy-production', id: job.transactionId, actorId: job.workerId, actorRole: 'worker', job,
      navigation: job.navigation, traveling: job.navigation.path.length > 0 && job.blockedReason === null });
  }
  for (const job of books.construction.jobs) if (job.terminal === null) add({ domain: 'construction', id: job.jobId,
    actorId: job.workerId, actorRole: 'worker', job, navigation: job.navigation, traveling: job.navigation.path.length > 0 && job.blocked === null });
  for (const job of books.production.jobs) if (job.terminal === null) add({ domain: 'sect-production', id: job.transactionId,
    actorId: job.workerId, actorRole: 'worker', job, navigation: job.navigation, traveling: job.navigation.path.length > 0 && job.blockedReason === null });
  for (const job of books.research.jobs) if (job.terminal === null) add({ domain: 'research', id: job.jobId,
    actorId: job.workerId, actorRole: 'worker', job, navigation: job.navigation, traveling: job.navigation.path.length > 0 && job.blocked === null });
  for (const job of books.care.jobs) if (job.terminal === null) add({ domain: 'care', id: job.jobId,
    actorId: job.patientId, actorRole: 'patient', job, navigation: job.navigation, traveling: job.navigation.path.length > 0 && job.blocked === null });
  for (const job of books.upgrade.jobs) if (job.terminal === null) add({ domain: 'upgrade', id: job.jobId,
    actorId: job.workerId, actorRole: 'worker', job, navigation: job.navigation, traveling: job.navigation.path.length > 0 && job.blocked === null });
  for (const job of books.relocation.jobs) if (job.terminal === null) {
    const live = books.relocationLive.filter(entry => entry.jobId === job.jobId);
    if (live.length !== 1) issue('RELOCATION_LIVE_MISMATCH', job.jobId, [{ domain: 'relocation', id: job.jobId }]);
    const entry = live.length === 1 ? live[0] : undefined;
    add({ domain: 'relocation', id: job.jobId, actorId: job.workerId, actorRole: 'worker', job,
      navigation: entry?.navigation ?? null, traveling: !!entry && entry.navigation.path.length > 0 && entry.blocked === null });
  }
  for (const entry of books.relocationLive) if (!owners.some(owner => owner.domain === 'relocation' && owner.id === entry.jobId)) issue('RELOCATION_LIVE_MISMATCH', entry.jobId);
  const legacy = owners.filter(owner => owner.domain === 'legacy-production');
  for (const id of new Set([...source.activeProductionTransactionIds, ...legacy.map(owner => owner.id)])) {
    if (source.activeProductionTransactionIds.filter(value => value === id).length !== 1 || legacy.filter(owner => owner.id === id).length !== 1) issue('LEGACY_INDEX_MISMATCH', id);
  }
  const claim = (owner: RelocationWorkOwnerRef, kind: RelocationOwnerClaim['kind'], key: string, access: RelocationOwnerClaim['access'] = 'exclusive'): void => {
    // One owner may refer to the same entrance twice (old and new, or storage and site).
    if (!claims.some(value => value.kind === kind && value.key === key && sameOwner(value.owner, owner) && value.access === access)) claims.push({ kind, key, access, owner: ref(owner) });
  };
  const station = (owner: RelocationWorkOwnerRef, id: string, access: RelocationOwnerClaim['access'] = 'exclusive'): void => {
    const sites = source.buildings.filter(site => site.id === id);
    if (sites.length !== 1) issue('MISSING_SITE', id, [owner]);
    else if (sites[0]) claim(owner, 'entrance', cellKey(sites[0]), access);
  };
  // Serialized actor/site references remain visible even if no live job or index
  // explains them. A reference is a diagnostic claim, never a fabricated live owner.
  for (const actor of source.disciples) if (actor.assignmentTransactionId !== null) {
    const owner: RelocationWorkOwnerRef = { domain: 'legacy-production', id: actor.assignmentTransactionId };
    claim(owner, 'actor', actor.id);
    const matches = legacy.filter(entry => entry.id === owner.id && entry.actorId === actor.id);
    if (matches.length !== 1) issue('LEGACY_ASSIGNMENT_MISMATCH', actor.id, [owner]);
  }
  for (const site of source.buildings) if (site.stationTransactionId !== null) {
    const owner: RelocationWorkOwnerRef = { domain: 'legacy-production', id: site.stationTransactionId };
    claim(owner, 'seat', site.id); claim(owner, 'entrance', cellKey(site));
    const matches = legacy.filter(entry => entry.id === owner.id && entry.job.worksiteId === site.id
      && (entry.job.phase === 'TravellingToWork' || entry.job.phase === 'Working'));
    if (matches.length !== 1) issue('LEGACY_STATION_MISMATCH', site.id, [owner]);
  }
  for (const owner of legacy) {
    const actors = source.disciples.filter(actor => actor.id === owner.actorId && actor.assignmentTransactionId === owner.id);
    if (actors.length !== 1) issue('LEGACY_ASSIGNMENT_MISMATCH', owner.actorId, [owner]);
    if (owner.job.phase === 'TravellingToWork' || owner.job.phase === 'Working') {
      const sites = source.buildings.filter(site => site.id === owner.job.worksiteId && site.stationTransactionId === owner.id);
      if (sites.length !== 1) issue('LEGACY_STATION_MISMATCH', owner.job.worksiteId ?? owner.id, [owner]);
    }
  }
  for (const owner of owners) {
    claim(owner, 'actor', owner.actorId);
    switch (owner.domain) {
      case 'legacy-production': {
        if (owner.job.storageId !== null) station(owner, owner.job.storageId, 'shared-legacy-storage');
        break;
      }
      case 'construction':
        claim(owner, 'seat', owner.job.seatToken); claim(owner, 'entrance', owner.job.entranceToken); break;
      case 'sect-production':
        // Lifetime exclusion remains after production releases its work seat for delivery.
        claim(owner, 'building-lifetime', owner.job.productiveSite.siteId);
        if (owner.job.seatSiteId !== null) {
          claim(owner, 'seat', owner.job.seatSiteId); claim(owner, 'entrance', cellKey(owner.job.productiveSite.position));
        } else if (owner.job.storageId !== null) station(owner, owner.job.storageId);
        break;
      case 'research':
        claim(owner, 'building-lifetime', owner.job.site.buildingId);
        claim(owner, 'seat', owner.job.site.buildingId); claim(owner, 'entrance', cellKey(owner.job.site.position)); break;
      case 'care': claim(owner, 'entrance', cellKey(owner.job.storagePosition)); break;
      case 'upgrade':
        claim(owner, 'building-lifetime', owner.job.buildingId);
        claim(owner, 'seat', owner.job.seatToken); claim(owner, 'entrance', owner.job.entranceToken); break;
      case 'relocation': {
        claim(owner, 'building-lifetime', owner.job.buildingId); claim(owner, 'seat', owner.job.buildingId);
        const old = deriveSectFootprint(owner.job.from); const target = deriveSectFootprint(owner.job.to);
        if (!old.ok || !target.ok) issue('INVALID_GEOMETRY', owner.id, [owner]);
        if (old.ok) claim(owner, 'entrance', cellKey(old.footprint.entrance));
        if (target.ok) {
          claim(owner, 'entrance', cellKey(target.footprint.entrance));
          for (const cell of [...target.footprint.cells, target.footprint.entrance]) claim(owner, 'soft-target', cellKey(cell));
        }
        break;
      }
    }
  }
  for (let i = 0; i < owners.length; i++) {
    const owner = owners[i]!;
    const duplicates = owners.slice(i + 1).filter(other => sameOwner(owner, other));
    if (duplicates.length) issue('DUPLICATE_OWNER', owner.id, [owner, ...duplicates]);
    if (!source.disciples.some(actor => actor.id === owner.actorId)) issue('MISSING_ACTOR_PROFILE', owner.actorId, [owner]);
  }
  for (let i = 0; i < claims.length; i++) {
    const entry = claims[i]!;
    const others = claims.slice(i + 1).filter(other => other.kind === entry.kind && other.key === entry.key && !sameOwner(entry.owner, other.owner)
      && (entry.access === 'exclusive' || other.access === 'exclusive'));
    if (others.length) issue('CLAIM_CONFLICT', `${entry.kind}:${entry.key}`, [entry.owner, ...others.map(other => other.owner)]);
  }
  for (const actor of source.disciples) {
    const profiles = source.cultivation.disciples.filter(profile => profile.discipleId === actor.id);
    const builds = source.builds.disciples.filter(profile => profile.discipleId === actor.id);
    if (profiles.length !== 1 || builds.length !== 1) issue('MISSING_ACTOR_PROFILE', actor.id);
    const exclude = (kind: RelocationEligibilityExclusion['kind'], sourceId: string | null = null): void => {
      exclusions.push({ actorId: actor.id, kind, sourceId });
    };
    if (actor.lifeState !== 'alive') exclude('not-alive');
    if (!actor.canWork) exclude('cannot-work');
    if (actor.traveling && !owners.some(owner => owner.actorId === actor.id)) exclude('unowned-travel');
    for (const profile of profiles) {
      if (profile.lifeState !== 'alive' && actor.lifeState === 'alive') exclude('not-alive');
      if (profile.trainingMode !== 'duty') exclude('training');
      if (profile.activeAttemptId !== null) exclude('cultivation', profile.activeAttemptId);
      if (profile.teaching !== null) exclude('teaching', profile.teaching.teachingId);
      if (profile.activityOwner !== null) exclude('away', profile.activityOwner.lockId);
    }
    for (const teacher of source.cultivation.disciples) if (teacher.teaching?.studentId === actor.id) exclude('teaching', teacher.teaching.teachingId);
    for (const build of builds) if (build.lock !== null) exclude('build-lock', build.lock.lockId);
  }
  for (const owner of owners) {
    // Care has its own training/injury eligibility; duty-worker exclusions cannot certify it.
    const incompatible = exclusions.filter(entry => entry.actorId === owner.actorId && (owner.actorRole !== 'patient' || entry.kind !== 'training' && entry.kind !== 'cannot-work'));
    for (const entry of incompatible) issue('OWNER_EXCLUDED', `${entry.kind}:${entry.actorId}`, [owner]);
  }
  return cloneJson({ owners, claims, exclusions, issues, activeJobCount: owners.length });
}

/** Pure typed data copy. No capture of unknown objects and no admission assertion. */
export function projectRelocationOwner(source: RelocationOwnerDraft): RelocationOwnerFrame {
  return cloneJson({
    authority: { clock: source.clock, map: source.map, inventory: source.inventory, disciples: source.disciples },
    continuity: {
      kind: source.kind, seed: source.seed, contentIdentity: source.contentIdentity,
      randomStreams: source.randomStreams, sequences: source.sequences, buildings: source.buildings,
      sectEconomy: source.sectEconomy, history: source.history, automaticProduction: source.automaticProduction,
      reservations: source.reservations, transactions: source.transactions, activeProductionTransactionIds: source.activeProductionTransactionIds,
      commandReceipts: source.commandReceipts, pendingCommands: source.pendingCommands, events: source.events,
      unlocks: source.unlocks, diagnostics: source.diagnostics, cultivation: source.cultivation,
      cultivationClock: source.cultivationClock, builds: source.builds, expedition: source.expedition, campaign: source.campaign, legacy: source.legacy,
    },
    domains: source.domains,
    ownership: projectRelocationOwnership(source),
  });
}

/** Inverse typed projection, not candidate publication. Caller edits to diagnostic
 * ownership cannot grant permission. Actor position/travel remain explicit authority,
 * never guessed from the first matching job when jobs conflict. */
export function recomposeRelocationOwner(frame: RelocationOwnerFrame): RelocationOwnerDraft {
  const c = frame.continuity; const a = frame.authority;
  return cloneJson({
    kind: c.kind, seed: c.seed, contentIdentity: c.contentIdentity, clock: a.clock,
    randomStreams: c.randomStreams, sequences: c.sequences, map: a.map, disciples: a.disciples,
    buildings: c.buildings, sectEconomy: c.sectEconomy, history: c.history, automaticProduction: c.automaticProduction,
    inventory: a.inventory, reservations: c.reservations, transactions: c.transactions,
    activeProductionTransactionIds: c.activeProductionTransactionIds, commandReceipts: c.commandReceipts,
    pendingCommands: c.pendingCommands, events: c.events, unlocks: c.unlocks, diagnostics: c.diagnostics,
    cultivation: c.cultivation, cultivationClock: c.cultivationClock, builds: c.builds,
    expedition: c.expedition, campaign: c.campaign, legacy: c.legacy, domains: frame.domains,
  });
}
