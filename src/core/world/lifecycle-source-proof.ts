import { CALENDAR_TICKS_PER_MONTH } from '../kernel/clock';
import { checkedAdd } from '../kernel/numeric';
import type { WorldStateV8 } from './v8-types';
import type { PendingDeath } from '../cultivation/types';
import { validateWorldLifecycleMigration } from './lifecycle-migration';
/** Legacy exceptions are explicit and bound to old retained prefixes. Every new
 * permanent death must instead have its actual lifecycle or mapped run source. */
export type LifecycleSource = Pick<WorldStateV8, 'legacy' | 'builds' | 'cultivation' | 'disciples' | 'expedition' | 'campaign'>;
export function validateWorldLifecycleSources(world: LifecycleSource): string[] {
  const legacyErrors = validateWorldLifecycleMigration(world); if (legacyErrors.length) return legacyErrors;
  try {
    const metadata = world.legacy.migrationLifecycle;
    const oldFinal = new Set(metadata?.finalizedDeaths.map(death => death.deathId) ?? []);
    const oldPending = new Set(metadata?.pendingDeaths.map(death => death.deathId) ?? []);
    const profileFor = (id: string) => [...world.cultivation.disciples, ...world.cultivation.archivedDisciples].find(profile => profile.discipleId === id);
    const expiry = (death: PendingDeath) => {
      const event = world.cultivation.events.find(event => event.kind === 'cultivation.expiryPending' && event.relatedId === death.deathId && event.discipleId === death.discipleId);
      const profile = profileFor(death.discipleId);
      const identity = world.disciples.find(actor => actor.id === death.discipleId) ?? world.legacy.archivedIdentities.find(actor => actor.discipleId === death.discipleId);
      if (!event || !profile || !identity || profile.ageMonths < profile.lifespanMonths) throw new TypeError('Lifespan death has no actual expiry');
      const expiresAt = checkedAdd(identity.birthCalendarTick, profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH);
      if (event.month < Math.floor(expiresAt / CALENDAR_TICKS_PER_MONTH) || event.month > death.month) throw new TypeError('Expiry predates the actual lifetime boundary');
      return event;
    };
    for (const pending of world.cultivation.pendingDeaths) {
      if (oldPending.has(pending.deathId)) continue;
      if (pending.cause !== 'lifespan') throw new TypeError('Unsupported new pending death source'); expiry(pending);
    }
    for (const death of world.cultivation.deaths) {
      if (oldFinal.has(death.deathId)) continue;
      const died = world.cultivation.events.filter(event => event.kind === 'cultivation.died' && event.discipleId === death.discipleId && event.relatedId === death.deathId);
      if (died.length !== 1) throw new TypeError('New death has no unique finalized event');
      if (oldPending.has(death.deathId)) continue;
      if (death.cause === 'lifespan') {
        const source = expiry(death); if (Number(source.eventId.slice(6)) >= Number(died[0]!.eventId.slice(6))) throw new TypeError('Lifespan death precedes expiry');
      } else if (death.cause === 'breakthrough') {
        const attempt = world.cultivation.attempts.find(attempt => attempt.discipleId === death.discipleId && attempt.rootActionId === died[0]!.rootActionId
          && attempt.phase === 'Resolved' && attempt.outcome === 'death' && attempt.sample !== null);
        if (!attempt || !world.cultivation.events.some(event => event.kind === 'cultivation.resolved' && event.relatedId === attempt.attemptId
          && event.rootActionId === died[0]!.rootActionId && Number(event.eventId.slice(6)) > Number(died[0]!.eventId.slice(6)))) throw new TypeError('Breakthrough death has no resolved sampled attempt');
      } else if (death.cause === 'combat') {
        const runs = [...(world.expedition.run ? [world.expedition.run] : []), ...world.campaign.settledRunEvidence.map(evidence => evidence.run)];
        const mapped = runs.some(run => run.encounterResults.some(result => result.members.some(member => member.discipleId === death.discipleId && member.permanentDeathId === death.deathId && !member.alive)
          && [...world.expedition.deathMappings, ...world.expedition.history.flatMap(history => history.deathMappings)].some(mapping => mapping.encounterId === result.encounterId
            && mapping.discipleId === death.discipleId && mapping.worldDeathId === death.deathId)));
        if (!mapped) throw new TypeError('Combat death has no mapped registered encounter');
      } else throw new TypeError('Unknown new death cause cannot borrow a legacy exception');
    }
    return [];
  } catch (error) { return [error instanceof Error ? error.message : 'Invalid lifecycle source']; }
}
