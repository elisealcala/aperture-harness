import { describe, expect, it } from 'vitest';
import { FakeFetch, fakeLinear, sampleLinearIssue, type LinearIssueJson } from '../../../tests/helpers/fetch.ts';
import { LinearIssueSource, type LinearSourceOptions } from './linear.ts';

const API = 'https://api.linear.app/graphql';
const REF = { type: 'linear' as const, identifier: 'ENG-123' };

function setup(options: Partial<LinearSourceOptions> = {}, issue: LinearIssueJson = sampleLinearIssue()): { fake: FakeFetch; source: LinearIssueSource } {
  const fake = fakeLinear({ issue });
  return { fake, source: new LinearIssueSource({ apiKey: 'lin_api_testkey', fetch: fake.fetch, ...options }) };
}

describe('LinearIssueSource', () => {
  it('POSTs the issue query with the raw API key as Authorization', async () => {
    const { fake, source } = setup();
    await source.fetch(REF);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call).toMatchObject({ url: API, method: 'POST', headers: { authorization: 'lin_api_testkey', 'user-agent': 'aperture-harness', 'content-type': 'application/json' } });
    const body = call.body as { query: string; variables: unknown };
    expect(body.variables).toEqual({ id: 'ENG-123' });
    expect(body.query).toMatch(/^query ApertureIssue/);
    expect(body.query).not.toMatch(/mutation/i);
  });

  it('normalizes the issue; without a team mapping the repository is null', async () => {
    const { source } = setup();
    const issue = sampleLinearIssue();
    const task = await source.fetch(REF);
    expect(task).toMatchObject({
      sourceType: 'linear',
      sourceRef: 'linear:ENG-123',
      taskKey: 'ENG-123',
      repository: null,
      title: issue.title,
      body: issue.description,
      labels: ['enhancement'],
      comments: [{ author: 'Reviewer', body: 'Keep the old response shape.', createdAt: '2026-11-04T18:30:00.000Z' }],
      url: issue.url,
      revision: issue.updatedAt,
    });
  });

  it('maps the team key to a GitHub repository', async () => {
    const { source } = setup({ teamRepositories: { ENG: 'org/repo', OPS: 'org/ops' } });
    await expect(source.fetch(REF)).resolves.toMatchObject({ repository: 'org/repo' });
  });

  it('falls back to the identifier prefix when the team is missing', async () => {
    const { source } = setup({ teamRepositories: { ENG: 'org/repo' } }, { ...sampleLinearIssue(), team: null });
    await expect(source.fetch(REF)).resolves.toMatchObject({ repository: 'org/repo' });
  });

  it('handles a null description and comment author', async () => {
    const issue = { ...sampleLinearIssue(), description: null, comments: { nodes: [{ body: 'x', createdAt: 't', user: null }] } };
    const { source } = setup({}, issue);
    await expect(source.fetch(REF)).resolves.toMatchObject({ body: '', comments: [{ author: 'unknown', body: 'x', createdAt: 't' }] });
  });

  it('uses a configured apiUrl', async () => {
    const fake = fakeLinear({ issue: sampleLinearIssue() }, 'https://linear.example.test/graphql');
    await new LinearIssueSource({ apiKey: 'k', apiUrl: 'https://linear.example.test/graphql', fetch: fake.fetch }).fetch(REF);
    expect(fake.calls[0]!.url).toBe('https://linear.example.test/graphql');
  });

  it('refuses to call the API without a key (AUTH)', async () => {
    const { fake, source } = setup({ apiKey: undefined });
    await expect(source.fetch(REF)).rejects.toMatchObject({ code: 'AUTH', message: expect.stringContaining('LINEAR_API_KEY') });
    expect(fake.calls).toEqual([]);
  });

  it('maps "not found" GraphQL errors to NOT_FOUND and others to TRANSPORT', async () => {
    const { source } = setup();
    await expect(source.fetch({ type: 'linear', identifier: 'ENG-999' })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Linear API error: Entity not found: Issue ENG-999' });

    const rateLimited = new FakeFetch(() => ({ json: { errors: [{ message: 'Rate limit exceeded' }, { message: 'try later' }] } }));
    await expect(new LinearIssueSource({ apiKey: 'k', fetch: rateLimited.fetch }).fetch(REF)).rejects.toMatchObject({ code: 'TRANSPORT', message: 'Linear API error: Rate limit exceeded; try later' });
  });

  it('treats a null issue as NOT_FOUND', async () => {
    const fake = new FakeFetch(() => ({ json: { data: { issue: null } } }));
    await expect(new LinearIssueSource({ apiKey: 'k', fetch: fake.fetch }).fetch(REF)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps a rejected key (HTTP 401) to AUTH', async () => {
    const fake = new FakeFetch(() => ({ status: 401, json: { errors: [{ message: 'Authentication required' }] } }));
    await expect(new LinearIssueSource({ apiKey: 'bad', fetch: fake.fetch }).fetch(REF)).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('rejects non-linear references', async () => {
    const { source } = setup();
    await expect(source.fetch({ type: 'github', owner: 'o', repo: 'r', number: 1 })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});
