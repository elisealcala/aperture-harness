import type { ExecutionContract } from '@aperture/contracts';

export interface SourceComment {
  author: string;
  body: string;
  createdAt: string;
}

/**
 * A ticket normalized across GitHub, Linear and local YAML. Every free-text field is untrusted
 * input data: it may inform a *proposed* contract but never grants permissions by itself.
 */
export interface NormalizedTask {
  sourceType: 'github' | 'linear' | 'local';
  /** Canonical reference, e.g. `github:org/repo#142`, `linear:ENG-123`, `local:/abs/task.yaml`. */
  sourceRef: string;
  /** Stable task id used for contracts (e.g. `GH-142`, `ENG-123`). */
  taskKey: string;
  repository: string | null;
  title: string;
  body: string;
  labels: string[];
  comments: SourceComment[];
  url: string | null;
  /** Pinned revision of the source (issue `updated_at`, file digest) used for drift detection. */
  revision: string;
  fetchedAt: string;
  /** A local contract file supplies the contract directly instead of a ticket to compile. */
  contract?: ExecutionContract;
}

export type SourceRef =
  | { type: 'github'; owner: string; repo: string; number: number }
  | { type: 'linear'; identifier: string }
  | { type: 'local'; path: string };

export interface TaskSource {
  readonly type: SourceRef['type'];
  fetch(ref: SourceRef): Promise<NormalizedTask>;
}

export class SourceError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_REF' | 'NOT_FOUND' | 'AUTH' | 'TRANSPORT' | 'INVALID_CONTENT' | 'UNSUPPORTED',
  ) {
    super(message);
    this.name = 'SourceError';
  }
}
