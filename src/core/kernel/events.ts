import type { WorldState } from '../world/types';
import type { DomainEvent } from './contracts';
import { allocateId } from './ids';
import { cloneJson } from './serialization';

export function appendEvent(world: WorldState, event: Omit<DomainEvent, 'eventId' | 'tick'>): { world: WorldState; event: DomainEvent } {
  const allocated = allocateId(world.sequences, 'event');
  const value: DomainEvent = Object.freeze({ ...event, eventId: allocated.id, tick: world.clock.simulationTick, payload: Object.freeze(cloneJson(event.payload)) });
  return { world: { ...world, sequences: allocated.sequences, events: [...world.events, value] }, event: value };
}
