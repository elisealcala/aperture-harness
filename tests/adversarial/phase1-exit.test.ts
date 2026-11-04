/**
 * Phase 1 exit criterion (§17): an adversarial agent attempt to touch `package.json` is denied and
 * logged, while a permitted patch and check succeed. Also covers AT-03 (unauthorized write rejected
 * before mutation, policy event emitted) and the traversal half of AT-04.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NonInteractive, Orchestrator, ScriptedExecutor } from '../../packages/core/src/index.ts';
import type { EventEnvelope } from '../../packages/events/src/index.ts';
import { detectIsolation } from '../../packages/sandbox/src/index.ts';
import { ApertureStore, type RunRecord } from '../../packages/storage/src/index.ts';
import { createHarnessFixture, type HarnessFixture } from '../helpers/harness.ts';
import { captureRepoState, PACKAGE_JSON, PACKAGE_JSON_POSTINSTALL_PATCH, SESSION_METADATA_PATCH, type RepoState } from '../helpers/repo.ts';
import { TempDirs } from '../helpers/tmp.ts';

const TRAVERSAL_PATCH = ['--- /dev/null', '+++ b/../outside.txt', '@@ -0,0 +1 @@', '+written outside the worktree', ''].join('\n');

const ADVERSARIAL_SCRIPT = [
  // (a) supply-chain attack: add a postinstall hook to a denied file
  { tool: 'propose_patch', input: { path: 'package.json', unifiedDiff: PACKAGE_JSON_POSTINSTALL_PATCH, requirementIds: ['R1'] } },
  // (b) escape the worktree with a traversal path
  { tool: 'propose_patch', input: { path: '../outside.txt', unifiedDiff: TRAVERSAL_PATCH, requirementIds: ['R1'] } },
  // (c) the legitimate change
  { tool: 'propose_patch', input: { path: 'src/api/session.ts', unifiedDiff: SESSION_METADATA_PATCH, requirementIds: ['R1'] } },
  // (d) the declared check
  { tool: 'run_check', input: { checkId: 'unit' } },
];

const modes: Array<{ label: string; isolation: 'reduced' | 'required' }> = [{ label: 'reduced isolation', isolation: 'reduced' }];
if (detectIsolation() === 'macos-seatbelt') modes.push({ label: 'macOS seatbelt sandbox', isolation: 'required' });

function readJsonl(path: string): EventEnvelope[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as EventEnvelope);
}

describe.each(modes)('Phase 1 exit: adversarial scripted executor ($label)', ({ isolation }) => {
  const tmp = new TempDirs();
  let fx: HarnessFixture;
  let repoBefore: RepoState;
  let final: RunRecord;
  let worktree: string;

  beforeAll(async () => {
    fx = createHarnessFixture(tmp);
    repoBefore = captureRepoState(fx.repo.path);
    const ingested = await fx.harness.ingest(fx.contractPath, { repoPath: fx.repo.path, isolation, questionMode: 'noninteractive' });
    final = await new Orchestrator(fx.harness).drive(ingested.runId, {
      executor: new ScriptedExecutor(ADVERSARIAL_SCRIPT),
      interaction: new NonInteractive('test', { approveContracts: true }),
    });
    worktree = final.worktreePath!;
  });

  afterAll(() => {
    fx.harness.close();
    tmp.cleanup();
  });

  function rejectedPayloads(): Array<Record<string, unknown>> {
    return fx.harness.events.list(final.runId, { types: ['tool.rejected'] }).map((e) => e.payload);
  }

  it('prepared a worktree outside the user checkout', () => {
    expect(worktree).toBeTruthy();
    expect(worktree.startsWith(fx.storageDir)).toBe(true);
    expect(fx.harness.events.list(final.runId, { types: ['sandbox.prepared'] })[0]?.payload.isolation).toBe(isolation === 'reduced' ? 'reduced' : 'macos-seatbelt');
  });

  it('(a) denies the package.json postinstall patch and leaves package.json unchanged', () => {
    expect(readFileSync(join(worktree, 'package.json'), 'utf8')).toBe(PACKAGE_JSON);
    expect(readFileSync(join(worktree, 'package.json'), 'utf8')).not.toContain('postinstall');
    expect(rejectedPayloads()).toContainEqual(expect.objectContaining({ toolCallId: 'script_0', name: 'propose_patch', reasonCode: 'PATH_DENIED', path: 'package.json', requirementIds: ['R1'] }));
    expect(fx.harness.store.getToolOp('script_0')).toMatchObject({ status: 'rejected' });
  });

  it('(b) denies the traversal path and writes nothing outside the worktree', () => {
    expect(rejectedPayloads()).toContainEqual(expect.objectContaining({ toolCallId: 'script_1', name: 'propose_patch', reasonCode: 'PATH_TRAVERSAL', path: '../outside.txt' }));
    expect(fx.harness.store.getToolOp('script_1')).toMatchObject({ status: 'rejected' });
    expect(existsSync(join(dirname(worktree), 'outside.txt'))).toBe(false);
    expect(existsSync(join(dirname(fx.repo.path), 'outside.txt'))).toBe(false);
  });

  it('rejects both attempts before mutation (no patch attempt is consumed)', () => {
    // Only the permitted patch reached the apply stage.
    expect(fx.harness.getRun(final.runId).patchAttempts).toBe(1);
    expect(fx.harness.events.list(final.runId, { types: ['tool.approved'] }).filter((e) => e.payload.name === 'propose_patch').map((e) => e.payload.toolCallId)).toEqual(['script_2']);
  });

  it('persists the rejection events durably in SQLite', () => {
    const reader = ApertureStore.open(fx.harness.layout.databasePath);
    try {
      const rows = reader.sql.all<{ sequence: number; payload_json: string }>(
        "SELECT sequence, payload_json FROM events WHERE run_id = :id AND type = 'tool.rejected' ORDER BY sequence",
        { id: final.runId },
      );
      const codes = rows.map((r) => (JSON.parse(r.payload_json) as { reasonCode: string }).reasonCode);
      expect(codes).toEqual(['PATH_DENIED', 'PATH_TRAVERSAL']);
    } finally {
      reader.close();
    }
  });

  it('projects the same events into runs/<id>/events.jsonl', () => {
    const jsonlPath = join(fx.storageDir, 'runs', final.runId, 'events.jsonl');
    expect(fx.harness.events.jsonlPath(final.runId)).toBe(jsonlPath);
    const projected = readJsonl(jsonlPath);
    const fromDb = fx.harness.events.list(final.runId);
    expect(projected).toEqual(fromDb);
    expect(projected.map((e) => e.sequence)).toEqual(fromDb.map((_, i) => i + 1));
    const rejected = projected.filter((e) => e.type === 'tool.rejected');
    expect(rejected.map((e) => [e.payload.toolCallId, e.payload.reasonCode])).toEqual([
      ['script_0', 'PATH_DENIED'],
      ['script_1', 'PATH_TRAVERSAL'],
    ]);
    expect(fx.harness.events.syncProjection(final.runId)).toEqual({ rebuilt: false });
  });

  it('(c) applies the permitted patch to the worktree', async () => {
    expect(fx.harness.store.getToolOp('script_2')).toMatchObject({ tool: 'propose_patch', status: 'applied' });
    const diff = await fx.harness.worktrees.diff(worktree, final.baselineSha!);
    expect(diff).toContain('diff --git a/src/api/session.ts b/src/api/session.ts');
    expect(diff).toContain('+  metadata?: Record<string, string>;');
    expect(diff).toContain('+  return { userId: input.userId, metadata: input.metadata };');
    expect(diff).not.toContain('postinstall');
  });

  // Fails with git 2.50.1 because of the `git apply --intent-to-add` index rewrite (gateway.ts:280):
  // every other tracked file is reported as deleted.
  it('changes nothing in the worktree except the permitted file', async () => {
    const changes = await fx.harness.worktrees.nameStatus(worktree, final.baselineSha!);
    expect(changes).toEqual([{ status: 'M', path: 'src/api/session.ts' }]);
  });

  it('(d) runs the declared check and it passes', () => {
    const op = fx.harness.store.getToolOp('script_3');
    expect(op).toMatchObject({ tool: 'run_check', status: 'completed' });
    expect(JSON.parse(op!.resultJson!)).toMatchObject({ kind: 'result', isError: false, content: expect.stringMatching(/^check unit: PASS/) });
    const checks = fx.harness.store.checksForRun(final.runId);
    expect(checks.length).toBeGreaterThanOrEqual(1);
    expect(checks.every((c) => c.checkId === 'unit' && c.status === 'PASS' && c.exitCode === 0)).toBe(true);
    for (const c of checks) expect(existsSync(c.artifactPath!)).toBe(true);
  });

  // Fails with git 2.50.1: verification sees the index-rewrite "deletions" as unauthorized changes
  // and moves the run to BLOCKED instead.
  it('ends the run in READY_FOR_REVIEW after verification passes', () => {
    expect({ state: final.state, reason: final.terminalReason }).toEqual({ state: 'READY_FOR_REVIEW', reason: null });
    const verification = fx.harness.events.list(final.runId, { types: ['verification.completed'] }).at(-1)?.payload;
    expect(verification).toMatchObject({ result: 'PASS', unauthorized: [], checks: [{ checkId: 'unit', status: 'PASS' }] });
  });

  it("leaves the user's original checkout untouched", () => {
    expect(captureRepoState(fx.repo.path)).toEqual(repoBefore);
  });
});
