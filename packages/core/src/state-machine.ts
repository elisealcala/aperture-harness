import type { RunState } from '@aperture/storage';

/**
 * Allowed transitions. The first block is §7 verbatim; the second block adds the minimal edges the
 * spec implies but does not draw (cancel/fail before execution, abandoning a PR draft or approval).
 */
const SPEC_TRANSITIONS: ReadonlyArray<[RunState, RunState]> = [
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

const IMPLIED_TRANSITIONS: ReadonlyArray<[RunState, RunState]> = [
  ['NEEDS_CONTRACT_REVIEW', 'CANCELED'],
  ['PREPARING', 'CANCELED'],
  ['VERIFYING', 'CANCELED'],
  ['EXECUTING', 'FAILED'],
  ['VERIFYING', 'FAILED'],
  ['PR_DRAFTING', 'READY_FOR_REVIEW'],
  ['PR_APPROVAL', 'READY_FOR_REVIEW'],
  ['PR_APPROVAL', 'PR_DRAFTING'],
  ['PR_APPROVAL', 'CANCELED'],
];

const ALLOWED = new Map<RunState, Set<RunState>>();
for (const [from, to] of [...SPEC_TRANSITIONS, ...IMPLIED_TRANSITIONS]) {
  if (!ALLOWED.has(from)) ALLOWED.set(from, new Set());
  ALLOWED.get(from)!.add(to);
}

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(['COMPLETED_LOCAL', 'PR_CREATED', 'BLOCKED', 'FAILED', 'CANCELED']);

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: RunState,
    readonly to: RunState,
  ) {
    super(`invalid state transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: RunState, to: RunState): boolean {
  return ALLOWED.get(from)?.has(to) ?? false;
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

export function nextStates(from: RunState): RunState[] {
  return [...(ALLOWED.get(from) ?? [])];
}
