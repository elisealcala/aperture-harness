import type { RunState } from '@aperture/storage';
import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, InvalidTransitionError, isTerminal, nextStates, TERMINAL_STATES } from './state-machine.ts';

const ALL_STATES: RunState[] = [
  'INGESTING',
  'NEEDS_CONTRACT_REVIEW',
  'PREPARING',
  'EXECUTING',
  'WAITING_FOR_USER',
  'VERIFYING',
  'READY_FOR_REVIEW',
  'PR_DRAFTING',
  'PR_APPROVAL',
  'PR_PUBLISHING',
  'PR_CREATED',
  'COMPLETED_LOCAL',
  'BLOCKED',
  'FAILED',
  'CANCELED',
];

/** Every edge drawn in the §7 state diagram, transcribed independently of the implementation. */
const SPEC_EDGES: Array<[RunState, RunState]> = [
  ['INGESTING', 'NEEDS_CONTRACT_REVIEW'],
  ['NEEDS_CONTRACT_REVIEW', 'PREPARING'],
  ['PREPARING', 'EXECUTING'],
  ['EXECUTING', 'WAITING_FOR_USER'],
  ['WAITING_FOR_USER', 'EXECUTING'],
  ['EXECUTING', 'VERIFYING'],
  ['VERIFYING', 'EXECUTING'],
  ['VERIFYING', 'READY_FOR_REVIEW'],
  ['READY_FOR_REVIEW', 'PR_DRAFTING'],
  ['PR_DRAFTING', 'PR_APPROVAL'],
  ['PR_APPROVAL', 'PR_PUBLISHING'],
  ['PR_PUBLISHING', 'PR_CREATED'],
  ['READY_FOR_REVIEW', 'COMPLETED_LOCAL'],
  ['INGESTING', 'FAILED'],
  ['PREPARING', 'FAILED'],
  ['EXECUTING', 'BLOCKED'],
  ['VERIFYING', 'BLOCKED'],
  ['PR_PUBLISHING', 'BLOCKED'],
  ['WAITING_FOR_USER', 'CANCELED'],
  ['EXECUTING', 'CANCELED'],
  ['READY_FOR_REVIEW', 'CANCELED'],
];

describe('run state machine', () => {
  it.each(SPEC_EDGES)('allows the §7 edge %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each<[RunState, RunState, string]>([
    ['INGESTING', 'EXECUTING', 'skips contract review'],
    ['NEEDS_CONTRACT_REVIEW', 'EXECUTING', 'skips preparation'],
    ['PREPARING', 'READY_FOR_REVIEW', 'skips execution and verification'],
    ['EXECUTING', 'READY_FOR_REVIEW', 'skips verification'],
    ['EXECUTING', 'COMPLETED_LOCAL', 'skips review'],
    ['WAITING_FOR_USER', 'VERIFYING', 'skips execution'],
    ['READY_FOR_REVIEW', 'PR_PUBLISHING', 'skips PR approval'],
    ['READY_FOR_REVIEW', 'PR_CREATED', 'skips drafting and approval'],
    ['PR_DRAFTING', 'PR_PUBLISHING', 'skips PR approval'],
    ['VERIFYING', 'COMPLETED_LOCAL', 'skips review'],
    ['EXECUTING', 'EXECUTING', 'self-loop'],
    ['READY_FOR_REVIEW', 'EXECUTING', 'reopens reviewed work without a new run'],
  ])('rejects %s -> %s (%s)', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it('reports the offending states on InvalidTransitionError', () => {
    try {
      assertTransition('EXECUTING', 'PR_CREATED');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      expect(err).toMatchObject({ from: 'EXECUTING', to: 'PR_CREATED', message: 'invalid state transition EXECUTING -> PR_CREATED' });
    }
  });

  describe('terminal states', () => {
    const terminal: RunState[] = ['COMPLETED_LOCAL', 'PR_CREATED', 'BLOCKED', 'FAILED', 'CANCELED'];

    it('are exactly the five §7 terminal outcomes', () => {
      expect([...TERMINAL_STATES].sort()).toEqual([...terminal].sort());
      for (const s of ALL_STATES) expect(isTerminal(s)).toBe(terminal.includes(s));
    });

    it('READY_FOR_REVIEW is not terminal', () => {
      expect(isTerminal('READY_FOR_REVIEW')).toBe(false);
    });

    it.each(terminal)('%s has no outgoing transitions', (state) => {
      expect(nextStates(state)).toEqual([]);
      for (const to of ALL_STATES) expect(canTransition(state, to)).toBe(false);
    });
  });

  it('can reach a terminal state from every non-terminal state', () => {
    for (const start of ALL_STATES.filter((s) => !isTerminal(s))) {
      const seen = new Set<RunState>([start]);
      const queue = [start];
      while (queue.length > 0) {
        for (const next of nextStates(queue.shift()!)) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect([...seen].some(isTerminal), `${start} cannot reach a terminal state`).toBe(true);
    }
  });

  it('nextStates lists the outgoing edges of a state', () => {
    expect(nextStates('READY_FOR_REVIEW').sort()).toEqual(['CANCELED', 'COMPLETED_LOCAL', 'PR_DRAFTING']);
  });
});
