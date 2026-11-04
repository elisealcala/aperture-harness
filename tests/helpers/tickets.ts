import { parseUserConfig, type UserConfig } from '../../packages/contracts/src/index.ts';
import { Harness, NonInteractive, Orchestrator, SourceRegistry } from '../../packages/core/src/index.ts';
import type { ScriptedModelProvider, ScriptedResponder } from '../../packages/models/src/index.ts';
import type { BranchPusher, PullRequestApi } from '../../packages/pr/src/index.ts';
import type { GitHubPullRequest } from '../../packages/sources/src/index.ts';
import type { RunRecord } from '../../packages/storage/src/index.ts';
import { FakeFetch, fakeGitHub, fakeLinear, SAMPLE_COMMENT, sampleIssue, sampleLinearIssue, type FakeGitHubState, type LinearIssueJson } from './fetch.ts';
import { DONE, patchTurn, scriptedModel } from './model.ts';
import { createFixtureRepo, FIXTURE_GIT_ENV, gitSync, SESSION_METADATA_PATCH, type FixtureRepo } from './repo.ts';
import type { TempDirs } from './tmp.ts';

/** Harness env: hermetic git identity plus fake credentials (the fakes never check them). */
export const TICKET_ENV: NodeJS.ProcessEnv = { ...FIXTURE_GIT_ENV, GITHUB_TOKEN: 'test-github-token', LINEAR_API_KEY: 'test-linear-key' };

export const ORIGIN_URL = 'https://github.com/org/repo.git';

/** User config for ticket runs: no `gh` CLI lookups, and a trusted `unit` command for checks. */
export function ticketConfig(raw: Record<string, unknown> = {}): UserConfig {
  return parseUserConfig({
    providers: { github: { useGhCli: false } },
    commands: { unit: { exec: 'node', args: ['--test', 'test/session.test.mjs'], timeoutSeconds: 60 } },
    ...raw,
  });
}

export interface TicketFixture {
  repo: FixtureRepo;
  storageDir: string;
  config: UserConfig;
  harness: Harness;
  /** Mutable upstream state: edit it to simulate the ticket changing after ingest. */
  github: FakeGitHubState;
  linear: { issue: LinearIssueJson };
  /** Every request the source adapters sent (GitHub REST and Linear GraphQL). */
  fetch: FakeFetch;
}

export interface TicketFixtureOptions {
  config?: Record<string, unknown>;
  /** `origin` remote URL; `null` for none. */
  origin?: string | null;
}

/**
 * Fixture repo (with an `origin` that is never contacted) + a Harness whose SourceRegistry talks
 * to in-memory GitHub/Linear fakes built from fixtures/sample-issue.json.
 */
export function createTicketFixture(tmp: TempDirs, options: TicketFixtureOptions = {}): TicketFixture {
  const repo = createFixtureRepo(tmp.make('aperture-repo-'));
  const origin = options.origin === undefined ? ORIGIN_URL : options.origin;
  if (origin) gitSync(repo.path, ['remote', 'add', 'origin', origin]);
  const storageDir = tmp.make('aperture-storage-');
  const config = ticketConfig(options.config);
  const github: FakeGitHubState = { issue: sampleIssue(), comments: [SAMPLE_COMMENT] };
  const linear = { issue: sampleLinearIssue() };
  const githubFake = fakeGitHub(github);
  const linearFake = fakeLinear(linear);
  const fetch = new FakeFetch((req) => (req.url.startsWith('https://api.linear.app/') ? linearFake.route(req) : githubFake.route(req)));
  const sources = SourceRegistry.withDefaults(config, TICKET_ENV, fetch.fetch);
  const harness = new Harness({ config, storageDir, env: TICKET_ENV, sources });
  return { repo, storageDir, config, harness, github, linear, fetch };
}

export async function ingestTicket(fx: TicketFixture, reference: string): Promise<RunRecord> {
  return fx.harness.ingest(reference, { repoPath: fx.repo.path, isolation: 'reduced', questionMode: 'noninteractive' });
}

/** The permitted SESSION_METADATA_PATCH, citing every requirement the sample issue compiles to. */
export const SAMPLE_TURNS: readonly ScriptedResponder[] = [patchTurn('src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2', 'R3'], 'toolu_meta'), DONE];

/** Approves the proposal (noninteractively) and drives the run with a scripted implementation model. */
export async function driveTicket(fx: TicketFixture, runId: string, turns: readonly ScriptedResponder[] = SAMPLE_TURNS): Promise<{ final: RunRecord; provider: ScriptedModelProvider; orchestrator: Orchestrator }> {
  const { provider, executor } = scriptedModel(turns);
  const orchestrator = new Orchestrator(fx.harness);
  const final = await orchestrator.drive(runId, { executor, interaction: new NonInteractive('alice', { approveContracts: true }) });
  return { final, provider, orchestrator };
}

// ---- PR publication fakes --------------------------------------------------------------------

export function pullRequest(number: number, branch: string, sha = 'remote-head-sha'): GitHubPullRequest {
  return { number, html_url: `https://github.com/org/repo/pull/${number}`, state: 'open', draft: true, head: { ref: branch, sha }, base: { ref: 'main' } };
}

/** In-memory GitHub pull request API: created PRs become visible to later lookups. */
export class FakePullRequestApi implements PullRequestApi {
  readonly finds: Array<{ owner: string; repo: string; branch: string }> = [];
  readonly creates: Array<{ owner: string; repo: string; input: { title: string; body: string; head: string; base: string; draft: boolean } }> = [];
  /** PRs that exist remotely (lookups return all of them; the workflow must pick by head ref). */
  remote: GitHubPullRequest[] = [];
  /** Thrown by the next createPullRequest *after* the PR was created remotely (lost response). */
  failNextCreateAfterCommit: Error | undefined;
  nextNumber = 101;

  async findPullRequestsByHead(owner: string, repo: string, branch: string): Promise<GitHubPullRequest[]> {
    this.finds.push({ owner, repo, branch });
    return [...this.remote];
  }

  async createPullRequest(owner: string, repo: string, input: { title: string; body: string; head: string; base: string; draft: boolean }): Promise<GitHubPullRequest> {
    this.creates.push({ owner, repo, input });
    const pr = pullRequest(this.nextNumber++, input.head);
    this.remote.push(pr);
    const err = this.failNextCreateAfterCommit;
    if (err) {
      this.failNextCreateAfterCommit = undefined;
      throw err;
    }
    return pr;
  }
}

export class FakePusher implements BranchPusher {
  readonly pushes: Array<{ worktreePath: string; branch: string }> = [];

  async push(worktreePath: string, branch: string): Promise<void> {
    this.pushes.push({ worktreePath, branch });
  }
}
