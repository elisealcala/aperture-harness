import type { RunSummary } from '@aperture/storage';

/** "just now", "5m ago", "3h ago", "2d ago", or the date for older runs. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 30 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return iso.slice(0, 10);
}

/**
 * Case-insensitive filter over title, source, state, run id, branch and repository. Every
 * whitespace-separated term must match (e.g. `blocked agents`).
 */
export function filterRuns(runs: readonly RunSummary[], query: string): RunSummary[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...runs];
  return runs.filter((run) => {
    const haystack = [run.title, run.sourceRef, run.state, run.runId, run.branch ?? '', run.repoPath, run.workspace].join(' ').toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

export function stateColor(state: string): string {
  if (state === 'COMPLETED_LOCAL' || state === 'PR_CREATED' || state === 'READY_FOR_REVIEW') return 'green';
  if (state === 'BLOCKED' || state === 'FAILED') return 'red';
  if (state === 'CANCELED') return 'gray';
  if (state === 'WAITING_FOR_USER' || state === 'NEEDS_CONTRACT_REVIEW' || state === 'PR_APPROVAL') return 'yellow';
  return 'cyan';
}

/** Keeps the selection inside the list and the visible window around it. */
export function clampSelection(selected: number, length: number): number {
  if (length === 0) return 0;
  return Math.max(0, Math.min(selected, length - 1));
}

export function visibleWindow(selected: number, length: number, height: number): { start: number; end: number } {
  if (length <= height) return { start: 0, end: length };
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), length - height));
  return { start, end: start + height };
}

export function truncate(text: string, width: number): string {
  if (width <= 1) return '';
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}
