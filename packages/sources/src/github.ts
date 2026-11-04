import { defaultFetch, requestJson, resolveGitHubToken, type FetchLike } from './http.ts';
import { SourceError, type NormalizedTask, type SourceComment, type SourceRef, type TaskSource } from './types.ts';

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  updated_at: string;
  labels: Array<string | { name?: string }>;
  comments: number;
  pull_request?: unknown;
  user?: { login?: string } | null;
}

interface GitHubComment {
  body: string | null;
  created_at: string;
  user?: { login?: string; type?: string } | null;
}

export interface GitHubPullRequest {
  number: number;
  html_url: string;
  state: string;
  draft?: boolean;
  head: { ref: string; sha: string; label?: string };
  base: { ref: string };
}

export interface GitHubClientOptions {
  apiUrl?: string;
  token?: string | (() => Promise<string | undefined>);
  fetch?: FetchLike;
}

/**
 * Minimal GitHub REST client. Reads issues for the source adapter; the PR publisher uses the pull
 * request methods. It has no methods that comment on, label, close or merge anything.
 */
export class GitHubClient {
  private readonly apiUrl: string;
  private readonly fetchImpl: FetchLike;
  private tokenPromise: Promise<string | undefined> | undefined;

  constructor(private readonly options: GitHubClientOptions = {}) {
    this.apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? defaultFetch;
  }

  static fromEnv(env: NodeJS.ProcessEnv, config: { tokenEnv: string; useGhCli: boolean; apiUrl: string }, fetchImpl?: FetchLike): GitHubClient {
    return new GitHubClient({ apiUrl: config.apiUrl, token: () => resolveGitHubToken(env, config), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }

  private async headers(): Promise<Record<string, string>> {
    const t = this.options.token;
    this.tokenPromise ??= typeof t === 'function' ? t() : Promise.resolve(t);
    const token = await this.tokenPromise;
    return {
      'user-agent': 'aperture-harness',
      'x-github-api-version': '2022-11-28',
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  private repoPath(owner: string, repo: string): string {
    return `${this.apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  async getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue> {
    return (await requestJson<GitHubIssue>(this.fetchImpl, `${this.repoPath(owner, repo)}/issues/${number}`, { headers: await this.headers() })).data;
  }

  async listIssueComments(owner: string, repo: string, number: number, max = 30): Promise<GitHubComment[]> {
    const url = `${this.repoPath(owner, repo)}/issues/${number}/comments?per_page=${Math.min(max, 100)}`;
    return (await requestJson<GitHubComment[]>(this.fetchImpl, url, { headers: await this.headers() })).data.slice(0, max);
  }

  async findPullRequestsByHead(owner: string, repo: string, branch: string): Promise<GitHubPullRequest[]> {
    const url = `${this.repoPath(owner, repo)}/pulls?state=all&per_page=10&head=${encodeURIComponent(`${owner}:${branch}`)}`;
    return (await requestJson<GitHubPullRequest[]>(this.fetchImpl, url, { headers: await this.headers() })).data;
  }

  async createPullRequest(owner: string, repo: string, input: { title: string; body: string; head: string; base: string; draft: boolean }): Promise<GitHubPullRequest> {
    const { status, data } = await requestJson<GitHubPullRequest & { message?: string; errors?: unknown }>(this.fetchImpl, `${this.repoPath(owner, repo)}/pulls`, {
      method: 'POST',
      headers: await this.headers(),
      body: input,
      timeoutMs: 30_000,
    });
    if (status === 422) throw new SourceError(`GitHub rejected the pull request: ${data.message ?? 'validation failed'} ${JSON.stringify(data.errors ?? '')}`, 'INVALID_CONTENT');
    return data;
  }
}

const MAX_BODY = 20_000;
const MAX_COMMENT = 4_000;

/** GitHub Issues → NormalizedTask. Issue text, labels and comments are untrusted data. */
export class GitHubIssueSource implements TaskSource {
  readonly type = 'github' as const;

  constructor(private readonly client: GitHubClient) {}

  async fetch(ref: SourceRef): Promise<NormalizedTask> {
    if (ref.type !== 'github') throw new SourceError('GitHubIssueSource only handles github references', 'UNSUPPORTED');
    const issue = await this.client.getIssue(ref.owner, ref.repo, ref.number);
    if (issue.pull_request) throw new SourceError(`${ref.owner}/${ref.repo}#${ref.number} is a pull request, not an issue`, 'UNSUPPORTED');
    const comments: SourceComment[] = issue.comments > 0
      ? (await this.client.listIssueComments(ref.owner, ref.repo, ref.number)).map((c) => ({ author: c.user?.login ?? 'unknown', body: (c.body ?? '').slice(0, MAX_COMMENT), createdAt: c.created_at }))
      : [];
    return {
      sourceType: 'github',
      sourceRef: `github:${ref.owner}/${ref.repo}#${ref.number}`,
      taskKey: `GH-${ref.number}`,
      repository: `${ref.owner}/${ref.repo}`,
      title: issue.title,
      body: (issue.body ?? '').slice(0, MAX_BODY),
      labels: issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
      comments,
      url: issue.html_url,
      revision: issue.updated_at,
      fetchedAt: new Date().toISOString(),
    };
  }
}
