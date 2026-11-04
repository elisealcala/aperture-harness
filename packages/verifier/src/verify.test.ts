import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContractInput } from '@aperture/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureContract, prepareRun, type PreparedRun } from '../../../tests/helpers/harness.ts';
import { PACKAGE_JSON_POSTINSTALL_PATCH, SESSION_COMMENT_PATCH, SESSION_METADATA_PATCH } from '../../../tests/helpers/repo.ts';
import { TempDirs } from '../../../tests/helpers/tmp.ts';
import { failureFeedback, normalizeFailureText, verifyRun, type AppliedPatch, type VerificationReport } from './verify.ts';

const tmp = new TempDirs();

/** Required `has-metadata` check: fails until SESSION_METADATA_PATCH lands. */
function requireMetadata(c: ContractInput): void {
  c.spec.checks = c.spec.checks!.map((check) => (check.id === 'has-metadata' ? { ...check, required: true } : check));
}

/** A required check whose failure output differs on every run only in timings, temp paths and timestamps. */
const TIMING_CHECK = {
  extraCommands: {
    timing: {
      exec: 'node',
      args: [
        '-e',
        "console.error('assertion failed after ' + (1 + Math.floor(Math.random() * 9000)) + 'ms in /tmp/aperture-' + Math.random().toString(16).slice(2) + ' at ' + new Date().toISOString()); process.exit(1)",
      ],
    },
  },
  extraChecks: [{ id: 'timing', commandId: 'timing', required: true }],
};

describe('verifyRun against a real worktree', () => {
  let p: PreparedRun;
  const applied: AppliedPatch[] = [];

  async function patch(id: string, path: string, diff: string, requirementIds: string[]): Promise<void> {
    const outcome = await p.gateway.execute({ id, name: 'propose_patch', input: { path, unifiedDiff: diff, requirementIds } });
    expect(outcome).toMatchObject({ kind: 'result', isError: false });
    applied.push({ opId: id, path, requirementIds });
  }

  async function verify(attempt = 1): Promise<VerificationReport> {
    return verifyRun({ attempt, contract: p.fx.harness.approvedContract(p.run), gateway: p.gateway, worktrees: p.fx.harness.worktrees, worktreePath: p.worktree, baselineSha: p.run.baselineSha!, appliedPatches: applied, isolation: 'reduced' });
  }

  async function setup(contract: ContractInput = fixtureContract()): Promise<void> {
    p = await prepareRun(tmp, contract);
  }

  afterEach(() => {
    applied.splice(0);
    p.fx.harness.close();
    tmp.cleanup();
  });

  it('PASS: every requirement has a patch and a passing covering check', async () => {
    await setup();
    await patch('op_meta', 'src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2']);
    const report = await verify();
    const contract = p.fx.harness.approvedContract(p.run);
    const diff = await p.fx.harness.worktrees.diff(p.worktree, p.run.baselineSha!);

    expect(report).toMatchObject({
      schemaVersion: 1,
      attempt: 1,
      result: 'PASS',
      summary: 'all 2 requirements have diff and check evidence',
      baselineSha: p.fx.repo.headSha,
      contractVersion: 1,
      contractSha256: contract.sha256,
      diffSha256: createHash('sha256').update(diff).digest('hex'),
      changes: [{ path: 'src/api/session.ts', status: 'M', added: 2, removed: 1, authorized: true }],
      violations: [],
      failureSignature: null,
      isolation: 'reduced',
    });
    expect(report.checks.map((c) => [c.checkId, c.required, c.status, c.exitCode])).toEqual([
      ['unit', true, 'PASS', 0],
      ['has-metadata', false, 'PASS', 0],
    ]);
    expect(report.requirements).toEqual([
      expect.objectContaining({ id: 'R1', status: 'VERIFIED', files: ['src/api/session.ts'], patchOperations: ['op_meta'], checks: ['unit', 'has-metadata'] }),
      expect.objectContaining({ id: 'R2', status: 'VERIFIED', files: ['src/api/session.ts'], patchOperations: ['op_meta'] }),
    ]);
    expect(Date.parse(report.verifiedAt)).not.toBeNaN();
  });

  it('runs every declared check as a verification round (attempt >= 1), not as an agent run', async () => {
    await setup();
    await patch('op_meta', 'src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2']);
    await verify(2);
    const rows = p.fx.harness.store.checksForRun(p.run.runId);
    expect(rows.map((r) => [r.checkId, r.attempt])).toEqual([
      ['unit', 2],
      ['has-metadata', 2],
    ]);
  });

  it('FAIL: an empty diff is never a candidate', async () => {
    await setup();
    const report = await verify();
    expect(report.result).toBe('FAIL');
    expect(report.summary).toBe('no changes were made to the worktree');
    expect(report.changes).toEqual([]);
    expect(report.failureSignature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('FAIL: a failed required check fails verification and the requirements it covers', async () => {
    await setup(fixtureContract({ mutate: requireMetadata }));
    await patch('op_comment', 'src/api/session.ts', SESSION_COMMENT_PATCH, ['R1', 'R2']);
    const report = await verify();
    expect(report.result).toBe('FAIL');
    expect(report.summary).toBe('required checks failed: has-metadata (FAIL)');
    expect(report.checks.find((c) => c.checkId === 'has-metadata')).toMatchObject({ required: true, status: 'FAIL', exitCode: 1, outputTail: expect.stringContaining('metadata field missing from SessionInput') });
    expect(report.requirements.map((r) => [r.id, r.status, r.note])).toEqual([
      ['R1', 'FAILED', 'covering check(s) failed: has-metadata'],
      ['R2', 'FAILED', 'covering check(s) failed: has-metadata'],
    ]);
    expect(report.failureSignature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a failing non-required check does not fail verification', async () => {
    await setup();
    await patch('op_comment', 'src/api/session.ts', SESSION_COMMENT_PATCH, ['R1', 'R2']);
    const report = await verify();
    expect(report.checks.find((c) => c.checkId === 'has-metadata')).toMatchObject({ required: false, status: 'FAIL' });
    expect(report.result).toBe('PASS');
    expect(report.requirements.every((r) => r.status === 'VERIFIED' && r.checks.join() === 'unit')).toBe(true);
  });

  it('UNVERIFIED: a requirement that no applied patch references (AT-09)', async () => {
    await setup();
    await patch('op_meta', 'src/api/session.ts', SESSION_METADATA_PATCH, ['R1']);
    const report = await verify();
    expect(report.result).toBe('UNVERIFIED');
    expect(report.summary).toBe('unverified requirements: R2');
    expect(report.requirements.find((r) => r.id === 'R2')).toMatchObject({ status: 'UNVERIFIED', files: [], patchOperations: [], note: 'no applied change references this requirement; needs manual review' });
    expect(report.failureSignature).toBeNull();
  });

  it('UNVERIFIED: a patched requirement that no passing check covers', async () => {
    await setup(
      fixtureContract({
        mutate: (c) => {
          c.spec.checks = c.spec.checks!.map((check) => ({ ...check, covers: ['R1'] }));
        },
      }),
    );
    await patch('op_meta', 'src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2']);
    const report = await verify();
    expect(report.result).toBe('UNVERIFIED');
    expect(report.requirements.map((r) => [r.id, r.status])).toEqual([
      ['R1', 'VERIFIED'],
      ['R2', 'UNVERIFIED'],
    ]);
    expect(report.requirements[1]).toMatchObject({ files: ['src/api/session.ts'], checks: [], note: 'changed files reference it but no passing check covers it; needs manual review' });
  });

  describe('BLOCKED scope violations', () => {
    it('an untracked file written directly to disk', async () => {
      await setup();
      await patch('op_meta', 'src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2']);
      writeFileSync(join(p.worktree, 'src/api/extra.ts'), 'export const sneaky = true;\n');
      const report = await verify();
      expect(report.result).toBe('BLOCKED');
      expect(report.violations).toEqual([{ path: 'src/api/extra.ts', code: 'UNTRACKED_FILE', detail: 'unexpected untracked file (not created through propose_patch)' }]);
      expect(report.summary).toBe('scope violations: src/api/extra.ts (UNTRACKED_FILE)');
      expect(report.failureSignature).toBeNull();
    });

    it('a tracked file outside the writable scope edited directly on disk', async () => {
      await setup();
      await patch('op_meta', 'src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2']);
      writeFileSync(join(p.worktree, 'README.md'), '# changed behind the gateway\n');
      const report = await verify();
      expect(report.result).toBe('BLOCKED');
      expect(report.changes.find((c) => c.path === 'README.md')).toMatchObject({ status: 'M', authorized: false });
      expect(report.violations).toEqual([{ path: 'README.md', code: 'NOT_WRITABLE', detail: 'changed a path outside the writable scope' }]);
    });

    it('a denied dependency manifest edited on disk is both DENIED and DEPENDENCY_EDIT', async () => {
      await setup();
      await patch('op_meta', 'src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2']);
      writeFileSync(join(p.worktree, 'package.json'), '{"name":"evil"}\n');
      const report = await verify();
      expect(report.result).toBe('BLOCKED');
      expect(report.violations.map((v) => [v.path, v.code])).toEqual([
        ['package.json', 'DENIED'],
        ['package.json', 'DEPENDENCY_EDIT'],
      ]);
    });

    it('a dependency manifest change is blocked even when the contract makes it writable', async () => {
      await setup(
        fixtureContract({
          mutate: (c) => {
            c.spec.scope.writable = [...c.spec.scope.writable, 'package.json'];
            c.spec.scope.denied = c.spec.scope.denied!.filter((d) => d !== 'package.json');
          },
        }),
      );
      await patch('op_meta', 'src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2']);
      await patch('op_pkg', 'package.json', PACKAGE_JSON_POSTINSTALL_PATCH, ['R1']);
      const report = await verify();
      expect(report.result).toBe('BLOCKED');
      expect(report.changes.find((c) => c.path === 'package.json')).toMatchObject({ authorized: true });
      expect(report.violations).toEqual([{ path: 'package.json', code: 'DEPENDENCY_EDIT', detail: 'dependency manifests and lockfiles may not change' }]);
    });

    it('violations take precedence over failed checks', async () => {
      await setup(fixtureContract({ mutate: requireMetadata }));
      writeFileSync(join(p.worktree, 'README.md'), '# changed\n');
      const report = await verify();
      expect(report.checks.find((c) => c.checkId === 'has-metadata')?.status).toBe('FAIL');
      expect(report.result).toBe('BLOCKED');
    });
  });

  describe('failure signature (stall detection input)', () => {
    it('is equal for equal failures whose output differs only in timings, temp paths and timestamps', async () => {
      await setup(fixtureContract(TIMING_CHECK));
      await patch('op_meta', 'src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2']);
      const first = await verify(1);
      const second = await verify(2);
      const tails = [first, second].map((r) => r.checks.find((c) => c.checkId === 'timing')!.outputTail);
      expect(tails[0]).not.toBe(tails[1]);
      expect(first.result).toBe('FAIL');
      expect(first.failureSignature).toMatch(/^[0-9a-f]{64}$/);
      expect(second.failureSignature).toBe(first.failureSignature);
    });

    it('changes when the set of failing checks changes', async () => {
      await setup(fixtureContract({ ...TIMING_CHECK, mutate: requireMetadata }));
      await patch('op_comment', 'src/api/session.ts', SESSION_COMMENT_PATCH, ['R1', 'R2']);
      const before = await verify(1);
      expect(before.summary).toBe('required checks failed: has-metadata (FAIL), timing (FAIL)');
      await patch('op_meta', 'src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2']);
      const after = await verify(2);
      expect(after.summary).toBe('required checks failed: timing (FAIL)');
      expect(after.failureSignature).not.toBe(before.failureSignature);
    });

    it('differs between an empty diff and a failed check', async () => {
      await setup(fixtureContract({ mutate: requireMetadata }));
      const empty = await verify(1);
      await patch('op_comment', 'src/api/session.ts', SESSION_COMMENT_PATCH, ['R1', 'R2']);
      const failed = await verify(2);
      expect(empty.failureSignature).not.toBe(failed.failureSignature);
    });
  });

  it('failureFeedback reports the failing check output and failed requirements', async () => {
    await setup(fixtureContract({ mutate: requireMetadata }));
    await patch('op_comment', 'src/api/session.ts', SESSION_COMMENT_PATCH, ['R1', 'R2']);
    const feedback = failureFeedback(await verify());
    expect(feedback.split('\n')[0]).toBe('Harness verification attempt 1: FAIL. required checks failed: has-metadata (FAIL).');
    expect(feedback).toContain('Check has-metadata FAIL (exit 1):\n$ node test/check-metadata.mjs');
    expect(feedback).toContain('metadata field missing from SessionInput');
    expect(feedback).not.toContain('Check unit');
    expect(feedback).toContain('Requirement R1 FAILED: covering check(s) failed: has-metadata');
    expect(feedback).toContain('Requirement R2 FAILED');
    expect(feedback.trimEnd().endsWith('Do not modify tests to hide failures unless the contract requires it.')).toBe(true);
  });
});

describe('normalizeFailureText', () => {
  it('replaces timings, temp paths, long hex ids and ISO timestamps, and collapses whitespace', () => {
    const text = 'failed in 12ms (1.5 s) at /private/var/folders/x/T/run-1/a.ts:3 id deadbeefdeadbeef0123 at 2026-11-04T20:00:00.123Z\n\n  done';
    expect(normalizeFailureText(text)).toBe('failed in <t> (<t>) at <tmp>:3 id <hex> at <ts> done');
  });

  it('maps outputs that differ only in volatile fragments to the same text', () => {
    expect(normalizeFailureText('took 31ms in /tmp/abc')).toBe(normalizeFailureText('took 4500ms in /tmp/xyz'));
    expect(normalizeFailureText('expected 1 got 2')).not.toBe(normalizeFailureText('expected 1 got 3'));
  });
});

describe('failureFeedback', () => {
  function report(overrides: Partial<VerificationReport> = {}): VerificationReport {
    return {
      schemaVersion: 1,
      attempt: 2,
      result: 'FAIL',
      summary: 'required checks failed: unit (TIMEOUT)',
      baselineSha: 'a'.repeat(40),
      contractVersion: 1,
      contractSha256: 'b'.repeat(64),
      diffSha256: 'c'.repeat(64),
      changes: [],
      violations: [],
      checks: [
        { checkId: 'unit', required: true, status: 'TIMEOUT', exitCode: null, durationMs: 60_000, artifactPath: '/x', outputTail: `${'x'.repeat(5000)}END` },
        { checkId: 'lint', required: true, status: 'PASS', exitCode: 0, durationMs: 10, artifactPath: '/y', outputTail: 'clean' },
      ],
      requirements: [
        { id: 'R1', text: 'a', status: 'VERIFIED', files: [], patchOperations: [], checks: [], note: 'ok' },
        { id: 'R2', text: 'b', status: 'UNVERIFIED', files: [], patchOperations: [], checks: [], note: 'no applied change references this requirement' },
      ],
      failureSignature: 'd'.repeat(64),
      isolation: 'reduced',
      verifiedAt: '2026-11-04T20:00:00.000Z',
      ...overrides,
    };
  }

  it('bounds each check output to its last 4000 characters and prints "none" for a missing exit code', () => {
    const feedback = failureFeedback(report());
    expect(feedback).toContain(`Check unit TIMEOUT (exit none):\n${'x'.repeat(3997)}END`);
    expect(feedback).not.toContain('x'.repeat(3998));
    expect(feedback).not.toContain('Check lint');
  });

  it('lists only requirements that are not verified', () => {
    const feedback = failureFeedback(report());
    expect(feedback).toContain('Requirement R2 UNVERIFIED: no applied change references this requirement');
    expect(feedback).not.toContain('Requirement R1');
  });
});
