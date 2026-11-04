import { defaultFetch, requestJson, type FetchLike } from './http.ts';
import { SourceError, type NormalizedTask, type SourceRef, type TaskSource } from './types.ts';

const ISSUE_QUERY = `query ApertureIssue($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
    url
    updatedAt
    team { key }
    labels(first: 20) { nodes { name } }
    comments(first: 30) { nodes { body createdAt user { name } } }
  }
}`;

interface LinearIssueResponse {
  data?: {
    issue: {
      identifier: string;
      title: string;
      description: string | null;
      url: string;
      updatedAt: string;
      team: { key: string } | null;
      labels: { nodes: Array<{ name: string }> };
      comments: { nodes: Array<{ body: string; createdAt: string; user: { name: string } | null }> };
    } | null;
  };
  errors?: Array<{ message: string }>;
}

export interface LinearSourceOptions {
  apiUrl?: string;
  apiKey?: string;
  /** Linear team key → GitHub `owner/repo` (needed later for PR publication, AT-02). */
  teamRepositories?: Readonly<Record<string, string>>;
  fetch?: FetchLike;
}

/** Linear issues via the GraphQL API with a read-only API key. */
export class LinearIssueSource implements TaskSource {
  readonly type = 'linear' as const;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: LinearSourceOptions = {}) {
    this.fetchImpl = options.fetch ?? defaultFetch;
  }

  async fetch(ref: SourceRef): Promise<NormalizedTask> {
    if (ref.type !== 'linear') throw new SourceError('LinearIssueSource only handles linear references', 'UNSUPPORTED');
    if (!this.options.apiKey) throw new SourceError('no Linear API key: set the env var named by providers.linear.apiKeyEnv (default LINEAR_API_KEY)', 'AUTH');
    const { data } = await requestJson<LinearIssueResponse>(this.fetchImpl, this.options.apiUrl ?? 'https://api.linear.app/graphql', {
      method: 'POST',
      // Linear personal API keys are sent as the raw Authorization value.
      headers: { authorization: this.options.apiKey, 'user-agent': 'aperture-harness' },
      body: { query: ISSUE_QUERY, variables: { id: ref.identifier } },
    });
    if (data.errors && data.errors.length > 0) {
      const message = data.errors.map((e) => e.message).join('; ');
      throw new SourceError(`Linear API error: ${message}`, /not found|could not find/i.test(message) ? 'NOT_FOUND' : 'TRANSPORT');
    }
    const issue = data.data?.issue;
    if (!issue) throw new SourceError(`Linear issue ${ref.identifier} not found`, 'NOT_FOUND');
    const teamKey = issue.team?.key ?? ref.identifier.split('-')[0]!;
    const repository = this.options.teamRepositories?.[teamKey] ?? null;
    return {
      sourceType: 'linear',
      sourceRef: `linear:${issue.identifier}`,
      taskKey: issue.identifier,
      repository,
      title: issue.title,
      body: (issue.description ?? '').slice(0, 20_000),
      labels: issue.labels.nodes.map((l) => l.name),
      comments: issue.comments.nodes.map((c) => ({ author: c.user?.name ?? 'unknown', body: c.body.slice(0, 4000), createdAt: c.createdAt })),
      url: issue.url,
      revision: issue.updatedAt,
      fetchedAt: new Date().toISOString(),
    };
  }
}
