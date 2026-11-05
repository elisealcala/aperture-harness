import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError, type Harness, type Orchestrator } from '@aperture/core';
import type { ModelProvider, ModelRegistry } from '@aperture/models';
import { git, gitEnv, gitStdout } from '@aperture/sandbox';
import { SourceError, type GitHubPullRequest } from '@aperture/sources';
import { newId, type RunRecord } from '@aperture/storage';
import { draftPullRequest, renderPrBody, type PrDraft } from './draft.ts';
import { buildEvidencePacket } from './evidence.ts';

export interface PullRequestApi {
  findPullRequestsByHead(owner: string, repo: string, branch: string): Promise<GitHubPullRequest[]>;
  createPullRequest(owner: string, repo: string, input: { title: string; body: string; head: string; base: string; draft: boolean }): Promise<GitHubPullRequest>;
}

export interface BranchPusher {
  /** Pushes the worktree HEAD to `refs/heads/<branch>` on the repository's origin. */
  push(worktreePath: string, branch: string): Promise<void>;
}

export interface StoredPrDraft {
  runId: string;
  repository: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  draft: PrDraft;
  modelId: string;
  fallback: boolean;
  problems: string[];
  diffSha256: string;
  draftPr: boolean;
  createdAt: string;
}

export interface PrPublicationPlan {
  repository: string;
  remoteUrl: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  draftPr: boolean;
  changedFiles: string[];
  action: string;
}

export interface PrWorkflowOptions {
  harness: Harness;
  orchestrator: Orchestrator;
  provider: ModelProvider;
  registry: ModelRegistry;
  github: PullRequestApi;
  pusher?: BranchPusher;
  redactLiterals?: readonly string[];
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Parses `owner/repo` out of a GitHub remote URL (https or ssh). */
export function repositoryFromRemote(url: string): string | undefined {
  const m = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** Default pusher: argument-array git, hooks disabled, credentials scoped to this process only. */
export function gitPusher(env: NodeJS.ProcessEnv, options: { useGhCli: boolean }): BranchPusher {
  return {
    async push(worktreePath, branch) {
      const publisherEnv = { ...gitEnv(env), ...(env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: env.SSH_AUTH_SOCK } : {}), ...(env.GIT_SSH_COMMAND ? { GIT_SSH_COMMAND: env.GIT_SSH_COMMAND } : {}) };
      const helper = options.useGhCli ? ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'] : [];
      await git(worktreePath, [...helper, 'push', '--no-verify', 'origin', `HEAD:refs/heads/${branch}`], { env: publisherEnv, timeoutMs: 120_000 });
    },
  };
}

/**
 * The PR workflow (§13): Haiku drafts text from verified evidence; publication happens only after an
 * explicit approval of the exact reviewed diff, is performed by harness code (never by a model
 * tool), opens a ready-for-review PR unless a draft is requested, and looks up an existing PR before every create.
 */
export class PrWorkflow {
  constructor(private readonly options: PrWorkflowOptions) {}

  private get harness(): Harness {
    return this.options.harness;
  }

  draftPath(runId: string): string {
    return join(this.harness.layout.runDir(runId), 'pr-draft.json');
  }

  loadDraft(runId: string): StoredPrDraft | undefined {
    const path = this.draftPath(runId);
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as StoredPrDraft) : undefined;
  }

  private async currentDiffSha(run: RunRecord): Promise<string> {
    return sha256(await this.harness.worktrees.diff(run.worktreePath!, run.baselineSha!));
  }

  private async baseBranch(run: RunRecord, repository: string): Promise<string> {
    const configured = this.harness.config.repositories[repository]?.baseBranch;
    if (configured) return configured;
    if (run.baselineRef && run.baselineRef !== 'HEAD' && !/^[0-9a-f]{7,40}$/.test(run.baselineRef)) return run.baselineRef.replace(/^origin\//, '');
    const head = await git(run.repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { allowFailure: true });
    return head.exitCode === 0 ? head.stdout.trim().replace(/^origin\//, '') : 'main';
  }

  /** Invalidates review + PR approval when the worktree no longer matches what was reviewed (§13.7). */
  private async assertReviewedDiff(run: RunRecord): Promise<string> {
    const diffSha = await this.currentDiffSha(run);
    if (!run.reviewDiffSha256) throw new HarnessError(`the diff has not been approved; run \`aperture review ${run.runId} --approve\` first`, 'NOT_REVIEWED');
    if (diffSha !== run.reviewDiffSha256) {
      this.harness.store.updateRun(run.runId, { reviewDiffSha256: null, reviewApprovedAt: null });
      if (run.state === 'PR_APPROVAL') this.harness.transition(run.runId, 'READY_FOR_REVIEW', 'diff changed after review; PR approval invalidated');
      throw new HarnessError('the worktree changed after review; review approval was invalidated — re-run `aperture review`', 'DIFF_CHANGED');
    }
    return diffSha;
  }

  async draft(runId: string, options: { repository?: string; draftPr?: boolean; modelId?: string } = {}): Promise<StoredPrDraft> {
    let run = this.harness.getRun(runId);
    if (run.state !== 'READY_FOR_REVIEW' && run.state !== 'PR_APPROVAL') throw new HarnessError(`run is ${run.state}; PR drafting needs READY_FOR_REVIEW`, 'NOT_READY');
    const contract = this.harness.approvedContract(run);
    if (contract.contract.spec.permissions.pullRequestCreate === 'deny') throw new HarnessError('the contract denies pull request creation', 'PR_DENIED');
    const diffSha = await this.assertReviewedDiff(run);
    const task = this.harness.store.getTask(run.taskId)!;
    if (!task.repository && options.repository) this.harness.store.setTaskRepository(task.taskId, options.repository);
    const repository = this.harness.store.getTask(run.taskId)!.repository;
    if (!repository) {
      throw new HarnessError('no GitHub repository is associated with this task; pass --repository owner/repo (or map the Linear team in config.linear.teamRepositories)', 'NO_REPOSITORY');
    }
    this.harness.transition(runId, 'PR_DRAFTING', run.state === 'PR_APPROVAL' ? 're-drafting' : 'user requested a PR');
    try {
      await this.harness.checkSourceDrift(runId);
      const packet = await buildEvidencePacket(this.harness, this.options.orchestrator, runId);
      const modelId = options.modelId ?? contract.contract.spec.models.prDraft;
      const result = await draftPullRequest(packet, {
        provider: this.options.provider,
        registry: this.options.registry,
        modelId,
        budgetUsd: contract.contract.spec.limits.prBudgetUsd,
        spentUsd: () => this.harness.store.spentUsd(runId, 'pr_draft'),
        cache: contract.contract.spec.cache,
        ...(this.options.redactLiterals ? { redactLiterals: this.options.redactLiterals } : {}),
      });
      if (result.usage) {
        this.harness.store.insertUsage({ ...result.usage, runId, phase: 'pr_draft', modelId, createdAt: new Date().toISOString() });
        this.harness.emit(runId, 'model.usage.recorded', { ...result.usage, phase: 'pr_draft', modelId, actual: true, spentUsd: this.harness.store.spentUsd(runId, 'pr_draft'), budgetUsd: contract.contract.spec.limits.prBudgetUsd });
      }
      run = this.harness.getRun(runId);
      const stored: StoredPrDraft = {
        runId,
        repository,
        branch: run.branch!,
        base: await this.baseBranch(run, repository),
        title: result.draft.title,
        body: renderPrBody(result.draft, packet, { draftModel: result.fallback ? 'deterministic template' : modelId }),
        draft: result.draft,
        modelId,
        fallback: result.fallback,
        problems: result.problems,
        diffSha256: diffSha,
        draftPr: options.draftPr ?? this.harness.config.pr.draftByDefault,
        createdAt: new Date().toISOString(),
      };
      this.harness.writeArtifact(runId, 'pr-draft.json', `${JSON.stringify(stored, null, 2)}\n`, 'pr_draft');
      this.harness.emit(runId, 'pr.draft.created', { title: stored.title, modelId, fallback: result.fallback, problems: result.problems });
      this.harness.transition(runId, 'PR_APPROVAL', 'draft ready for approval');
      this.harness.emit(runId, 'pr.approval.requested', { repository, branch: stored.branch, base: stored.base, title: stored.title, draftPr: stored.draftPr });
      return stored;
    } catch (err) {
      if (this.harness.getRun(runId).state === 'PR_DRAFTING') this.harness.transition(runId, 'READY_FOR_REVIEW', `PR drafting failed: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Everything the user approves: target, branch, base, files, title and body. */
  async plan(runId: string): Promise<PrPublicationPlan> {
    const run = this.harness.getRun(runId);
    const draft = this.loadDraft(runId);
    if (!draft) throw new HarnessError(`no PR draft; run \`aperture pr draft ${runId}\` first`, 'NO_DRAFT');
    const remoteUrl = (await gitStdout(run.repoPath, ['remote', 'get-url', 'origin'])).trim();
    const changes = await this.harness.worktrees.nameStatus(run.worktreePath!, run.baselineSha!);
    return {
      repository: draft.repository,
      remoteUrl,
      branch: draft.branch,
      base: draft.base,
      title: draft.title,
      body: draft.body,
      draftPr: draft.draftPr,
      changedFiles: changes.map((c) => `${c.status} ${c.path}`),
      action: `commit ${changes.length} file(s) on ${draft.branch}, push to origin (${draft.repository}), open a ${draft.draftPr ? 'GitHub draft ' : 'ready-for-review '}PR into ${draft.base}`,
    };
  }

  /**
   * Publishes after explicit approval (AT-13). Safe to call again after a failure or success: the
   * persisted operation and a remote lookup by head branch prevent duplicate PRs (AT-14).
   */
  async publish(runId: string, approval: { approved: boolean; actor: string }): Promise<{ url: string; number: number; existing: boolean }> {
    let run = this.harness.getRun(runId);
    const existingPublication = this.harness.store.getPublication(runId);
    if (run.state === 'PR_CREATED' && existingPublication?.prUrl && existingPublication.prNumber) {
      return { url: existingPublication.prUrl, number: existingPublication.prNumber, existing: true };
    }
    const draft = this.loadDraft(runId);
    if (!draft) throw new HarnessError(`no PR draft; run \`aperture pr draft ${runId}\` first`, 'NO_DRAFT');

    if (run.state === 'PR_APPROVAL') {
      await this.harness.assertWorkspaceBranch(run);
      if (!approval.approved) throw new HarnessError('publishing a pull request requires explicit approval; nothing was pushed', 'NOT_APPROVED');
      const diffSha = await this.assertReviewedDiff(run);
      if (diffSha !== draft.diffSha256) throw new HarnessError('the diff changed after the PR draft; re-run `aperture pr draft`', 'DIFF_CHANGED');
      const remoteRepo = repositoryFromRemote((await gitStdout(run.repoPath, ['remote', 'get-url', 'origin'])).trim());
      if (!remoteRepo || remoteRepo.toLowerCase() !== draft.repository.toLowerCase()) {
        throw new HarnessError(`origin points at ${remoteRepo ?? 'an unrecognized remote'}, not ${draft.repository}; refusing to push`, 'REMOTE_MISMATCH');
      }
      const now = new Date().toISOString();
      this.harness.store.transaction(() => {
        this.harness.store.insertDecision({
          decisionId: newId('dec'),
          runId,
          questionId: null,
          kind: 'pr_publish',
          answerJson: JSON.stringify({ repository: draft.repository, branch: draft.branch, base: draft.base, title: draft.title, bodySha256: sha256(draft.body), diffSha256: diffSha }),
          actor: approval.actor,
          contractVersion: this.harness.approvedContract(run).version,
          createdAt: now,
        });
        this.harness.store.upsertPublication({ runId, operationId: newId('pub'), repository: draft.repository, branch: draft.branch, baseBranch: draft.base, headSha: null, status: 'approved', prNumber: null, prUrl: null, approvedAt: now, updatedAt: now });
        this.harness.emit(runId, 'pr.approval.granted', { actor: approval.actor, repository: draft.repository, branch: draft.branch, base: draft.base });
        this.harness.transition(runId, 'PR_PUBLISHING', 'publish approved');
      });
      run = this.harness.getRun(runId);
    }
    if (run.state !== 'PR_PUBLISHING') throw new HarnessError(`run is ${run.state}; nothing to publish`, 'NOT_READY');
    await this.harness.assertWorkspaceBranch(run);

    const [owner, repo] = draft.repository.split('/') as [string, string];
    try {
      let publication = this.harness.store.getPublication(runId)!;
      if (publication.status === 'approved') {
        const headSha = await this.commitIfNeeded(run, draft);
        await (this.options.pusher ?? gitPusher(this.harness.env, this.harness.config.providers.github)).push(run.worktreePath!, draft.branch);
        this.harness.store.upsertPublication({ ...publication, headSha, status: 'pushed', updatedAt: new Date().toISOString() });
        publication = this.harness.store.getPublication(runId)!;
      }
      const found = (await this.options.github.findPullRequestsByHead(owner, repo, draft.branch)).find((pr) => pr.head.ref === draft.branch);
      const pr = found ?? (await this.options.github.createPullRequest(owner, repo, { title: draft.title, body: draft.body, head: draft.branch, base: draft.base, draft: draft.draftPr }));
      const now = new Date().toISOString();
      const record = { ...publication, status: 'created' as const, prNumber: pr.number, prUrl: pr.html_url, headSha: publication.headSha ?? pr.head.sha, updatedAt: now };
      this.harness.store.transaction(() => {
        this.harness.store.upsertPublication(record);
        this.harness.emit(runId, 'pr.published', { url: pr.html_url, number: pr.number, existing: Boolean(found), branch: draft.branch, headSha: record.headSha });
        this.harness.transition(runId, 'PR_CREATED', `PR #${pr.number} ${found ? 'already existed' : 'created'}`);
      });
      this.harness.writeArtifact(runId, 'pr-publication.json', `${JSON.stringify(record, null, 2)}\n`, 'pr_publication');
      this.options.orchestrator.finalize(runId);
      return { url: pr.html_url, number: pr.number, existing: Boolean(found) };
    } catch (err) {
      this.harness.emit(runId, 'error', { message: `PR publication failed: ${(err as Error).message}` });
      const permanent = err instanceof HarnessError || (err instanceof SourceError && (err.code === 'AUTH' || err.code === 'INVALID_CONTENT' || err.code === 'NOT_FOUND'));
      if (permanent && this.harness.getRun(runId).state === 'PR_PUBLISHING') this.harness.transition(runId, 'BLOCKED', `PR publication failed: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Commits the reviewed diff once; verifies the commit contains exactly the reviewed changes. */
  private async commitIfNeeded(run: RunRecord, draft: StoredPrDraft): Promise<string> {
    const worktree = run.worktreePath!;
    const head = (await gitStdout(worktree, ['rev-parse', 'HEAD'])).trim();
    if (head === run.baselineSha) {
      const changes = await this.harness.worktrees.nameStatus(worktree, run.baselineSha!);
      await git(worktree, ['add', '-A', '--', ...changes.map((c) => c.path)]);
      const message = `${draft.title}\n\n${draft.draft.issueReference}\n\nAperture-Run: ${run.runId}`;
      await git(worktree, ['commit', '--no-verify', '--no-gpg-sign', '-m', message], { env: gitEnv(this.harness.env) });
    }
    const committed = sha256(await gitStdout(worktree, ['diff', '--binary', '--no-color', '--no-ext-diff', '--no-renames', run.baselineSha!, 'HEAD', '--']));
    if (committed !== draft.diffSha256) throw new HarnessError('the commit does not match the reviewed diff; refusing to push', 'COMMIT_MISMATCH');
    return (await gitStdout(worktree, ['rev-parse', 'HEAD'])).trim();
  }
}
