import { describe, expect, it } from 'vitest';
import { FakeFetch, fakeGitHub, SAMPLE_COMMENT, sampleIssue, type FakeGitHubState } from '../../../tests/helpers/fetch.ts';
import { GitHubClient, GitHubIssueSource } from './github.ts';
import { SourceError } from './types.ts';

const ISSUE_URL = 'https://api.github.com/repos/org/repo/issues/142';
const REF = { type: 'github' as const, owner: 'org', repo: 'repo', number: 142 };

function setup(overrides: Partial<FakeGitHubState['issue']> = {}): { state: FakeGitHubState; fake: FakeFetch; source: GitHubIssueSource } {
  const state: FakeGitHubState = { issue: { ...sampleIssue(), ...overrides }, comments: [SAMPLE_COMMENT] };
  const fake = fakeGitHub(state);
  return { state, fake, source: new GitHubIssueSource(new GitHubClient({ token: 'test-token', fetch: fake.fetch })) };
}

describe('GitHubIssueSource', () => {
  it('normalizes an issue into GH-<n> with labels, comments and updated_at as the revision', async () => {
    const { source } = setup();
    const task = await source.fetch(REF);
    const issue = sampleIssue();
    expect(task).toMatchObject({
      sourceType: 'github',
      sourceRef: 'github:org/repo#142',
      taskKey: 'GH-142',
      repository: 'org/repo',
      title: 'Add optional session metadata',
      body: issue.body,
      labels: ['enhancement'],
      comments: [{ author: 'reviewer', body: SAMPLE_COMMENT.body, createdAt: SAMPLE_COMMENT.created_at }],
      url: 'https://github.com/org/repo/issues/142',
      revision: '2026-11-04T18:00:00Z',
    });
    expect(Date.parse(task.fetchedAt)).not.toBeNaN();
    expect(task.contract).toBeUndefined();
  });

  it('sends GitHub headers with the bearer token and only GETs', async () => {
    const { fake, source } = setup();
    await source.fetch(REF);
    expect(fake.calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', ISSUE_URL],
      ['GET', `${ISSUE_URL}/comments?per_page=30`],
    ]);
    expect(fake.calls[0]!.headers).toMatchObject({
      authorization: 'Bearer test-token',
      'user-agent': 'aperture-harness',
      'x-github-api-version': '2022-11-28',
      accept: 'application/vnd.github+json',
    });
  });

  it('fetches comments only when the issue reports some', async () => {
    const { fake, source } = setup({ comments: 0 });
    const task = await source.fetch(REF);
    expect(task.comments).toEqual([]);
    expect(fake.calls.map((c) => c.url)).toEqual([ISSUE_URL]);
  });

  it('refuses pull requests', async () => {
    const { source } = setup({ pull_request: { url: 'https://api.github.com/repos/org/repo/pulls/142' } });
    await expect(source.fetch(REF)).rejects.toMatchObject({ code: 'UNSUPPORTED', message: expect.stringContaining('is a pull request') });
  });

  it('handles null bodies, string labels and missing comment authors', async () => {
    const { state, source } = setup({ body: null, labels: ['bug', { name: 'p1' }, {}] });
    state.comments = [{ body: null, created_at: '2026-11-04T19:00:00Z', user: null }];
    const task = await source.fetch(REF);
    expect(task.body).toBe('');
    expect(task.labels).toEqual(['bug', 'p1']);
    expect(task.comments).toEqual([{ author: 'unknown', body: '', createdAt: '2026-11-04T19:00:00Z' }]);
  });

  it('bounds the body and each comment', async () => {
    const { state, source } = setup({ body: 'b'.repeat(25_000) });
    state.comments = [{ ...SAMPLE_COMMENT, body: 'c'.repeat(5_000) }];
    const task = await source.fetch(REF);
    expect(task.body).toHaveLength(20_000);
    expect(task.comments[0]!.body).toHaveLength(4_000);
  });

  it('rejects non-github references', async () => {
    const { source } = setup();
    await expect(source.fetch({ type: 'linear', identifier: 'ENG-1' })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('surfaces a missing issue as NOT_FOUND', async () => {
    const { source } = setup();
    await expect(source.fetch({ ...REF, number: 999 })).rejects.toBeInstanceOf(SourceError);
    await expect(source.fetch({ ...REF, number: 999 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('GitHubClient', () => {
  const pr = { number: 7, html_url: 'https://github.com/org/repo/pull/7', state: 'open', draft: true, head: { ref: 'aperture/run-1', sha: 'abc' }, base: { ref: 'main' } };

  it('omits the authorization header without a token and strips a trailing slash from apiUrl', async () => {
    const fake = new FakeFetch(() => ({ json: sampleIssue() }));
    await new GitHubClient({ apiUrl: 'https://ghe.example.test/api/v3/', fetch: fake.fetch }).getIssue('org', 'repo', 142);
    expect(fake.calls[0]!.url).toBe('https://ghe.example.test/api/v3/repos/org/repo/issues/142');
    expect(fake.calls[0]!.headers.authorization).toBeUndefined();
  });

  it('resolves a token function once and reuses it', async () => {
    let calls = 0;
    const fake = new FakeFetch(() => ({ json: sampleIssue() }));
    const client = new GitHubClient({
      token: async () => {
        calls++;
        return 'lazy';
      },
      fetch: fake.fetch,
    });
    await client.getIssue('org', 'repo', 142);
    await client.getIssue('org', 'repo', 142);
    expect(calls).toBe(1);
    expect(fake.calls.map((c) => c.headers.authorization)).toEqual(['Bearer lazy', 'Bearer lazy']);
  });

  it('fromEnv reads the configured token env var', async () => {
    const fake = new FakeFetch(() => ({ json: sampleIssue() }));
    const client = GitHubClient.fromEnv({ CUSTOM_GH: 'env-token' }, { tokenEnv: 'CUSTOM_GH', useGhCli: false, apiUrl: 'https://api.github.com' }, fake.fetch);
    await client.getIssue('org', 'repo', 142);
    expect(fake.calls[0]!.headers.authorization).toBe('Bearer env-token');
  });

  it('caps listIssueComments at max', async () => {
    const fake = new FakeFetch(() => ({ json: Array.from({ length: 10 }, () => SAMPLE_COMMENT) }));
    const comments = await new GitHubClient({ fetch: fake.fetch }).listIssueComments('org', 'repo', 142, 3);
    expect(comments).toHaveLength(3);
    expect(fake.calls[0]!.url).toBe(`${ISSUE_URL}/comments?per_page=3`);
  });

  it('findPullRequestsByHead queries all states by owner:branch', async () => {
    const fake = new FakeFetch(() => ({ json: [pr] }));
    const found = await new GitHubClient({ fetch: fake.fetch }).findPullRequestsByHead('org', 'repo', 'aperture/run-1');
    expect(found).toEqual([pr]);
    expect(fake.calls).toEqual([
      expect.objectContaining({ method: 'GET', url: 'https://api.github.com/repos/org/repo/pulls?state=all&per_page=10&head=org%3Aaperture%2Frun-1' }),
    ]);
    expect(new URL(fake.calls[0]!.url).searchParams.get('head')).toBe('org:aperture/run-1');
  });

  it('createPullRequest POSTs the input to /pulls', async () => {
    const fake = new FakeFetch(() => ({ status: 201, json: pr }));
    const input = { title: 'Add metadata', body: 'body', head: 'aperture/run-1', base: 'main', draft: true };
    await expect(new GitHubClient({ token: 't', fetch: fake.fetch }).createPullRequest('org', 'repo', input)).resolves.toEqual(pr);
    expect(fake.calls).toEqual([
      expect.objectContaining({ method: 'POST', url: 'https://api.github.com/repos/org/repo/pulls', body: input, headers: expect.objectContaining({ authorization: 'Bearer t', 'content-type': 'application/json' }) }),
    ]);
  });

  it('createPullRequest turns a 422 into INVALID_CONTENT with the API message', async () => {
    const fake = new FakeFetch(() => ({ status: 422, json: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists' }] } }));
    await expect(new GitHubClient({ fetch: fake.fetch }).createPullRequest('org', 'repo', { title: 't', body: 'b', head: 'h', base: 'main', draft: true })).rejects.toMatchObject({
      code: 'INVALID_CONTENT',
      message: expect.stringContaining('Validation Failed'),
    });
  });
});
