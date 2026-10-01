import { checkedAdd } from './numeric';

export interface SequenceState {
  nextEntity: number;
  nextEvent: number;
  nextAction: number;
  nextInstance: number;
}
export type SequenceKind = 'entity' | 'event' | 'action' | 'instance';
const KEYS = { entity: 'nextEntity', event: 'nextEvent', action: 'nextAction', instance: 'nextInstance' } as const;

export function createSequences(): SequenceState {
  return { nextEntity: 1, nextEvent: 1, nextAction: 1, nextInstance: 1 };
}

export function allocateId(sequences: SequenceState, kind: SequenceKind): { id: string; sequences: SequenceState } {
  const key = KEYS[kind];
  const value = sequences[key];
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Invalid ID sequence');
  return { id: `${kind}:${value}`, sequences: { ...sequences, [key]: checkedAdd(value, 1) } };
}
