/** Event names from §11, plus a few harness-internal ones that the TUI renders. */
export const EVENT_TYPES = [
  'run.created',
  'run.resumed',
  'run.finished',
  'contract.proposed',
  'contract.approved',
  'contract.rejected',
  'contract.amended',
  'state.changed',
  'sandbox.prepared',
  'model.request.started',
  'model.output.delta',
  'model.response.completed',
  'model.usage.recorded',
  'tool.requested',
  'tool.approved',
  'tool.rejected',
  'tool.completed',
  'check.started',
  'check.completed',
  'format.completed',
  'network.allowed',
  'network.denied',
  'question.asked',
  'question.answered',
  'scope.change.requested',
  'scope.change.decided',
  'verification.started',
  'verification.completed',
  'budget.warning',
  'budget.exhausted',
  'review.approved',
  'pr.draft.created',
  'pr.approval.requested',
  'pr.approval.granted',
  'pr.published',
  'recovery.reconciled',
  'source.drift.detected',
  'error',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_SCHEMA_VERSION = 1;

export interface EventEnvelope<P = Record<string, unknown>> {
  schemaVersion: number;
  eventId: string;
  runId: string;
  sequence: number;
  timestamp: string;
  type: EventType;
  payload: P;
}

/** Rejection reason codes shared by the gateway, verifier and TUI. */
export type ReasonCode =
  | 'UNKNOWN_TOOL'
  | 'INVALID_INPUT'
  | 'PATH_INVALID'
  | 'PATH_TRAVERSAL'
  | 'PATH_ABSOLUTE'
  | 'PATH_DENIED'
  | 'PATH_NOT_READABLE'
  | 'PATH_NOT_WRITABLE'
  | 'PATH_SYMLINK'
  | 'PATH_ESCAPES_WORKTREE'
  | 'PATH_CASE_MISMATCH'
  | 'PATCH_PATH_MISMATCH'
  | 'PATCH_UNSUPPORTED'
  | 'PATCH_DOES_NOT_APPLY'
  | 'PATCH_LIMIT_REACHED'
  | 'UNKNOWN_REQUIREMENT'
  | 'UNKNOWN_CHECK'
  | 'FILE_TOO_LARGE'
  | 'NOT_FOUND'
  | 'BINARY_FILE';
