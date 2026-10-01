import { appendWorldEvents } from '../world/history-access';
import type { WorldStateBase } from '../world/types';
import type { DomainEvent } from './contracts';
import { allocateId } from './ids';
import { cloneJson } from './serialization';

export function appendEvent<W extends WorldStateBase>(world: W, event: Omit<DomainEvent, 'eventId' | 'tick'>): { world: W; event: DomainEvent } {
  const allocated = allocateId(world.sequences, 'event');
  const value: DomainEvent = Object.freeze({ ...event, eventId: allocated.id, tick: world.clock.simulationTick, payload: Object.freeze(cloneJson(event.payload)) });
  return { world: appendWorldEvents({ ...world, sequences: allocated.sequences }, [value]), event: value };
}
