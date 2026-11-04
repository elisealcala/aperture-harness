import { readFileSync } from 'node:fs';
import type { FetchLike } from '../../packages/sources/src/index.ts';

/** One request seen by a FakeFetch, with the JSON body parsed back. */
export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface FakeResponse {
  status?: number;
  /** Serialized with JSON.stringify unless `text` is given. */
  json?: unknown;
  text?: string;
}

export type FakeRoute = (request: RecordedRequest) => FakeResponse | undefined;

/**
 * Transport-boundary fake for the sources package (`FetchLike`). Records every request; unmatched
 * requests get a 404 so a test never silently reaches a real API.
 */
export class FakeFetch {
  readonly calls: RecordedRequest[] = [];

  constructor(readonly route: FakeRoute) {}

  readonly fetch: FetchLike = async (url, init) => {
    const request: RecordedRequest = { url, method: init.method, headers: { ...init.headers }, ...(init.body !== undefined ? { body: JSON.parse(init.body) as unknown } : {}) };
    this.calls.push(request);
    const response = this.route(request) ?? { status: 404, json: { message: 'Not Found' } };
    const status = response.status ?? 200;
    const text = response.text ?? (response.json === undefined ? '' : JSON.stringify(response.json));
    return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => text };
  };
}

export interface GitHubIssueJson {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<string | { name?: string }>;
  html_url: string;
  updated_at: string;
  user?: { login?: string } | null;
  comments: number;
  pull_request?: unknown;
}

/** `fixtures/sample-issue.json` (org/repo#142, with a hidden HTML-comment injection). */
export function sampleIssue(): GitHubIssueJson {
  return JSON.parse(readFileSync(new URL('../../fixtures/sample-issue.json', import.meta.url), 'utf8')) as GitHubIssueJson;
}

export const SAMPLE_COMMENT = { body: 'Please keep the old response shape.', created_at: '2026-11-04T18:30:00Z', user: { login: 'reviewer', type: 'User' } };

/** Mutable state behind `fakeGitHub`; tests edit it to simulate a ticket changing upstream. */
export interface FakeGitHubState {
  issue: GitHubIssueJson;
  comments: unknown[];
}

/** Read-only GitHub REST fake serving one issue (and its comments) of `org/repo`. */
export function fakeGitHub(state: FakeGitHubState, apiUrl = 'https://api.github.com'): FakeFetch {
  return new FakeFetch((req) => {
    if (req.method !== 'GET') return { status: 405, json: { message: 'fake GitHub is read-only' } };
    const base = `${apiUrl}/repos/org/repo/issues/${state.issue.number}`;
    if (req.url === base) return { json: state.issue };
    if (req.url.startsWith(`${base}/comments?`)) return { json: state.comments };
    return undefined;
  });
}

export interface LinearIssueJson {
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  updatedAt: string;
  team: { key: string } | null;
  labels: { nodes: Array<{ name: string }> };
  comments: { nodes: Array<{ body: string; createdAt: string; user: { name: string } | null }> };
}

/** The sample issue as Linear would return it for `ENG-123`. */
export function sampleLinearIssue(): LinearIssueJson {
  const gh = sampleIssue();
  return {
    identifier: 'ENG-123',
    title: gh.title,
    description: gh.body,
    url: 'https://linear.app/acme/issue/ENG-123/add-optional-session-metadata',
    updatedAt: '2026-11-04T18:00:00.000Z',
    team: { key: 'ENG' },
    labels: { nodes: [{ name: 'enhancement' }] },
    comments: { nodes: [{ body: 'Keep the old response shape.', createdAt: '2026-11-04T18:30:00.000Z', user: { name: 'Reviewer' } }] },
  };
}

/** Linear GraphQL fake: answers the issue query for `state.issue.identifier`, else a GraphQL error. */
export function fakeLinear(state: { issue: LinearIssueJson }, apiUrl = 'https://api.linear.app/graphql'): FakeFetch {
  return new FakeFetch((req) => {
    if (req.url !== apiUrl || req.method !== 'POST') return undefined;
    const { variables } = req.body as { query: string; variables: { id: string } };
    if (variables.id !== state.issue.identifier) return { json: { errors: [{ message: `Entity not found: Issue ${variables.id}` }] } };
    return { json: { data: { issue: state.issue } } };
  });
}
