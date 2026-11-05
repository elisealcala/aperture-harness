/**
 * Auto-format before verification: configured formatters run (through the sandbox runner) on the
 * run's changed files at the start of every verification round, so formatting is fixed
 * deterministically instead of failing checks or spending model turns. The formatter is a small
 * committed node script; the model is scripted.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ContractInput, FormatterSpec } from '../../packages/contracts/src/index.ts';
import { NonInteractive, Orchestrator } from '../../packages/core/src/index.ts';
import type { ToolGateway } from '../../packages/gateway/src/index.ts';
import type { ScriptedResponder } from '../../packages/models/src/index.ts';
import { detectIsolation } from '../../packages/sandbox/src/index.ts';
import type { RunRecord } from '../../packages/storage/src/index.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarnessFixture, fixtureContract, type HarnessFixture } from '../helpers/harness.ts';
import { DONE, patchCall, patchTurn, scriptedModel } from '../helpers/model.ts';
import { gitSync, SESSION_METADATA_PATCH, SESSION_TS_WITH_METADATA } from '../helpers/repo.ts';
import { TempDirs } from '../helpers/tmp.ts';

const seatbeltAvailable = detectIsolation() === 'macos-seatbelt';

/**
 * Fake formatter: strips trailing whitespace from every given file and ensures a final newline,
 * logging its cwd and file arguments. `--fail` exits 3 before touching anything; `--touch=<path>`
 * appends a line to another file (a formatter that writes outside what it was given).
 */
const FMT_MJS = `import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const files = args.filter((a) => !a.startsWith('--'));
console.log('fmt cwd=' + process.cwd());
console.log('fmt files=' + JSON.stringify(files));
if (flags.includes('--fail')) {
  console.error('fmt: simulated failure');
  process.exit(3);
}
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const out = src.split('\\n').map((l) => l.replace(/[ \\t]+$/, '')).join('\\n').replace(/\\n*$/, '\\n');
  if (out !== src) writeFileSync(f, out);
}
for (const flag of flags) {
  if (flag.startsWith('--touch=')) {
    const p = flag.slice('--touch='.length);
    writeFileSync(p, readFileSync(p, 'utf8') + 'touched by formatter\\n');
  }
}
`;

/** Format check: fails when any given file has trailing whitespace. */
const FMT_CHECK_MJS = `import { readFileSync } from 'node:fs';
const bad = [];
for (const f of process.argv.slice(2)) {
  readFileSync(f, 'utf8').split('\\n').forEach((l, i) => { if (/[ \\t]+$/.test(l)) bad.push(f + ':' + (i + 1)); });
}
if (bad.length > 0) { console.error('trailing whitespace: ' + bad.join(', ')); process.exit(1); }
console.log('format ok');
`;

const TOOLS = { 'tools/fmt.mjs': FMT_MJS, 'tools/fmt-check.mjs': FMT_CHECK_MJS };

/** SESSION_METADATA_PATCH with trailing whitespace on both added lines. */
const BADLY_FORMATTED_PATCH = SESSION_METADATA_PATCH.replace('+  metadata?: Record<string, string>;', '+  metadata?: Record<string, string>;   ').replace(
  '+  return { userId: input.userId, metadata: input.metadata };',
  '+  return { userId: input.userId, metadata: input.metadata };\t',
);
const BAD_TURN = patchTurn('src/api/session.ts', BADLY_FORMATTED_PATCH, ['R1', 'R2'], 'toolu_bad');
const GOOD_TURN = patchTurn('src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2'], 'toolu_good');

const ROOT_FMT = { exec: 'node', args: ['tools/fmt.mjs'], include: ['src/**/*.ts'] };

const STUDIO_APP_TS = 'export const app = 1;\n';
const STUDIO_APP_PATCH = ['--- a/studio/app.ts', '+++ b/studio/app.ts', '@@ -1,1 +1,2 @@', ' export const app = 1;', '+export const name = "studio";  ', ''].join('\n');
const LEGACY_TS = 'export const legacy = true;\n';
const LEGACY_DELETE_PATCH = ['--- a/src/api/legacy.ts', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-export const legacy = true;', ''].join('\n');
const NOTES_CREATE_PATCH = ['--- /dev/null', '+++ b/src/api/NOTES.md', '@@ -0,0 +1,1 @@', '+Session metadata notes.   ', ''].join('\n');

/** Extra committed fixture files: the tools plus a studio package, a legacy module and a non-writable lib. */
const EXTRA_FILES: Record<string, string> = {
  ...TOOLS,
  'studio/app.ts': STUDIO_APP_TS,
  'studio/nested/deep.ts': 'export const deep = 1;   \n',
  'studio-legacy/app.ts': 'export const old = 1;   \n',
  'src/api/legacy.ts': LEGACY_TS,
  'lib/util.ts': 'export const util = 1;   \n',
};

/** Widens the fixture scope to the extra files (lib/ stays read-only). */
function widenScope(c: ContractInput): void {
  c.spec.scope.writable = ['src/api/**', 'studio/**', 'studio-legacy/**'];
  c.spec.scope.readable = ['src/**', 'test/**', 'studio/**', 'studio-legacy/**', 'lib/**', 'tools/**'];
}

/** A required `fmt-check` that fails while src/api/session.ts has trailing whitespace. */
function requireFormatCheck(c: ContractInput): void {
  c.spec.commands!['fmt-check'] = { exec: 'node', args: ['tools/fmt-check.mjs', 'src/api/session.ts'], timeoutSeconds: 60 };
  c.spec.checks = [...c.spec.checks!, { id: 'fmt-check', commandId: 'fmt-check', required: true }];
}

function commitFiles(repoPath: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repoPath, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  gitSync(repoPath, ['add', '-A']);
  gitSync(repoPath, ['commit', '-q', '-m', 'add formatter tools']);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const tmp = new TempDirs();
let fx: HarnessFixture;
let orchestrator: Orchestrator;

afterEach(() => {
  fx.harness.close();
  tmp.cleanup();
});

interface DriveOptions {
  formatters?: Record<string, unknown>;
  mutate?: (c: ContractInput) => void;
  isolation?: 'reduced' | 'required';
}

function setup(options: DriveOptions): void {
  fx = createHarnessFixture(tmp, fixtureContract(options.mutate ? { mutate: options.mutate } : {}), options.formatters ? { config: { formatters: options.formatters } } : {});
  commitFiles(fx.repo.path, EXTRA_FILES);
}

async function drive(options: DriveOptions, turns: ScriptedResponder[]): Promise<RunRecord> {
  setup(options);
  const run = await fx.harness.ingest(fx.contractPath, { repoPath: fx.repo.path, isolation: options.isolation ?? 'reduced', questionMode: 'interactive' });
  const { executor } = scriptedModel(turns);
  orchestrator = new Orchestrator(fx.harness);
  return orchestrator.drive(run.runId, { executor, interaction: new NonInteractive('test', { approveContracts: true }) });
}

/** Ingest -> approve -> prepare, returning a gateway on the EXECUTING run. */
async function prepareGateway(options: DriveOptions = {}): Promise<{ run: RunRecord; gateway: ToolGateway }> {
  setup({ mutate: widenScope, ...options });
  const ingested = await fx.harness.ingest(fx.contractPath, { repoPath: fx.repo.path, isolation: options.isolation ?? 'reduced', questionMode: 'noninteractive' });
  fx.harness.approvePending(ingested.runId, 'test');
  fx.harness.transition(ingested.runId, 'PREPARING', 'contract approved');
  const run = await fx.harness.prepare(ingested.runId);
  return { run, gateway: fx.harness.createGateway(run) };
}

function formatEvents(runId: string): Array<Record<string, unknown>> {
  return fx.harness.events.list(runId, { types: ['format.completed'] }).map((e) => e.payload);
}

function verifications(runId: string): Array<Record<string, unknown>> {
  return fx.harness.events.list(runId, { types: ['verification.completed'] }).map((e) => e.payload);
}

function eventTypes(runId: string): string[] {
  return fx.harness.events.list(runId).map((e) => e.type);
}

function spec(raw: Partial<FormatterSpec> & { exec: string; include: string[] }): FormatterSpec {
  return { args: [], timeoutSeconds: 60, ...raw };
}

function artifact(runId: string, name: string): string {
  return readFileSync(join(fx.storageDir, 'runs', runId, name), 'utf8');
}

describe('auto-format before verification (orchestrator)', () => {
  it('reformats a badly formatted model patch before checks run; verification and proposed.patch see the formatted file', async () => {
    const final = await drive({ formatters: { 'root-fmt': ROOT_FMT }, mutate: requireFormatCheck }, [BAD_TURN, DONE]);

    expect(final.state).toBe('READY_FOR_REVIEW');
    expect(readFileSync(join(final.worktreePath!, 'src/api/session.ts'), 'utf8')).toBe(SESSION_TS_WITH_METADATA);
    expect(formatEvents(final.runId)).toEqual([
      expect.objectContaining({ formatterId: 'root-fmt', files: ['src/api/session.ts'], status: 'FORMATTED', exitCode: 0, outputTail: expect.stringContaining('fmt files=["src/api/session.ts"]') }),
    ]);
    // Formatting happens after verification.started and before the first check.
    const types = eventTypes(final.runId);
    expect(types.indexOf('verification.started')).toBeLessThan(types.indexOf('format.completed'));
    expect(types.indexOf('format.completed')).toBeLessThan(types.indexOf('check.started'));

    expect(verifications(final.runId)).toEqual([expect.objectContaining({ result: 'PASS', checks: expect.arrayContaining([{ checkId: 'fmt-check', status: 'PASS' }]) })]);
    const patch = artifact(final.runId, 'proposed.patch');
    expect(patch).toContain('+  metadata?: Record<string, string>;\n');
    expect(patch).toContain('+  return { userId: input.userId, metadata: input.metadata };\n');
    expect(patch).not.toMatch(/^\+.*[ \t]$/m);
    // The verified diff is exactly the formatted one: its hash matches proposed.patch and review approval succeeds.
    const report = orchestrator.latestVerification(final.runId)!;
    expect(report.diffSha256).toBe(sha256(patch));
    await expect(orchestrator.approveReview(final.runId, 'alice', { acceptLocal: true })).resolves.toMatchObject({ state: 'COMPLETED_LOCAL' });
  });

  it('without formatters the same patch fails the required format check and enters the fix loop', async () => {
    const final = await drive({ mutate: requireFormatCheck }, [BAD_TURN, DONE, DONE]);

    expect(formatEvents(final.runId)).toEqual([]);
    expect(verifications(final.runId).map((v) => v.result)).toEqual(['FAIL', 'FAIL']);
    const reasons = fx.harness.events.list(final.runId, { types: ['state.changed'] }).map((e) => `${String(e.payload.from)}->${String(e.payload.to)}: ${String(e.payload.reason ?? '')}`);
    expect(reasons).toContain('VERIFYING->EXECUTING: bounded fix 1/3: required checks failed: fmt-check (FAIL)');
    expect(final.state).toBe('BLOCKED');
    expect(final.terminalReason).toBe('STALLED: identical failure repeated (required checks failed: fmt-check (FAIL))');
  });

  it('passes only non-deleted changed files matching include, and runs every configured formatter (with cwd)', async () => {
    const studioFmt = { exec: 'node', args: ['../tools/fmt.mjs'], cwd: 'studio', include: ['**/*.ts'] };
    const final = await drive({ formatters: { 'root-fmt': ROOT_FMT, 'studio-fmt': studioFmt }, mutate: (c) => (widenScope(c), requireFormatCheck(c)) }, [
      {
        toolCalls: [
          patchCall('src/api/session.ts', BADLY_FORMATTED_PATCH, ['R1', 'R2'], 'toolu_session'),
          patchCall('src/api/legacy.ts', LEGACY_DELETE_PATCH, ['R2'], 'toolu_delete'),
          patchCall('src/api/NOTES.md', NOTES_CREATE_PATCH, ['R1'], 'toolu_notes'),
          patchCall('studio/app.ts', STUDIO_APP_PATCH, ['R1'], 'toolu_studio'),
        ],
      },
      DONE,
    ]);

    expect(final.state).toBe('READY_FOR_REVIEW');
    const events = formatEvents(final.runId);
    // root-fmt: the deleted legacy.ts, the non-.ts NOTES.md and studio/ (outside include) are not passed.
    expect(events).toEqual([
      expect.objectContaining({ formatterId: 'root-fmt', files: ['src/api/session.ts'], status: 'FORMATTED' }),
      // studio-fmt: src/api/session.ts matches `**/*.ts` but lies outside cwd; paths are relative to cwd.
      expect.objectContaining({ formatterId: 'studio-fmt', files: ['studio/app.ts'], status: 'FORMATTED' }),
    ]);
    expect(events[0]!.outputTail).toContain(`fmt cwd=${final.worktreePath}\n`);
    expect(events[1]!.outputTail).toContain(`fmt cwd=${join(final.worktreePath!, 'studio')}\n`);
    expect(events[1]!.outputTail).toContain('fmt files=["app.ts"]');

    expect(readFileSync(join(final.worktreePath!, 'studio/app.ts'), 'utf8')).toBe('export const app = 1;\nexport const name = "studio";\n');
    expect(readFileSync(join(final.worktreePath!, 'src/api/NOTES.md'), 'utf8')).toBe('Session metadata notes.   \n');
    // Unchanged files under cwd are never handed to the formatter.
    expect(readFileSync(join(final.worktreePath!, 'studio/nested/deep.ts'), 'utf8')).toBe('export const deep = 1;   \n');
  });

  it('blocks with SCOPE_VIOLATION when a formatter modifies a file outside the writable scope', async () => {
    const final = await drive({ formatters: { sneaky: { ...ROOT_FMT, args: ['tools/fmt.mjs', '--touch=README.md'] } } }, [GOOD_TURN, DONE]);

    expect(formatEvents(final.runId)).toEqual([expect.objectContaining({ formatterId: 'sneaky', files: ['src/api/session.ts'], status: 'FORMATTED' })]);
    expect(final.state).toBe('BLOCKED');
    expect(final.terminalReason).toBe('SCOPE_VIOLATION: scope violations: README.md (NOT_WRITABLE)');
    expect(verifications(final.runId)).toEqual([expect.objectContaining({ result: 'BLOCKED', violations: [expect.objectContaining({ path: 'README.md', code: 'NOT_WRITABLE' })] })]);
  });

  it('reports a failing formatter and still runs verification', async () => {
    const final = await drive({ formatters: { broken: { ...ROOT_FMT, args: ['tools/fmt.mjs', '--fail'] } } }, [GOOD_TURN, DONE]);

    expect(formatEvents(final.runId)).toEqual([
      expect.objectContaining({ formatterId: 'broken', files: ['src/api/session.ts'], status: 'FAILED', exitCode: 3, outputTail: expect.stringContaining('fmt: simulated failure') }),
    ]);
    const types = eventTypes(final.runId);
    expect(types.indexOf('format.completed')).toBeLessThan(types.indexOf('check.started'));
    expect(verifications(final.runId)).toEqual([expect.objectContaining({ result: 'PASS' })]);
    expect(final.state).toBe('READY_FOR_REVIEW');
  });

  it('a formatter failure does not hide formatting problems from the format check', async () => {
    const final = await drive({ formatters: { broken: { ...ROOT_FMT, args: ['tools/fmt.mjs', '--fail'] } }, mutate: (c) => { requireFormatCheck(c); c.spec.limits!.maxVerificationAttempts = 1; } }, [BAD_TURN, DONE]);

    expect(formatEvents(final.runId).map((e) => e.status)).toEqual(['FAILED']);
    expect(final.state).toBe('BLOCKED');
    expect(final.terminalReason).toBe('VERIFICATION_FAILED after 1 attempts: required checks failed: fmt-check (FAIL)');
  });

  it('is a no-op when nothing changed (the formatter never runs)', async () => {
    // If it ran, --touch would modify README.md and turn this into a scope violation.
    const final = await drive({ formatters: { sneaky: { ...ROOT_FMT, args: ['tools/fmt.mjs', '--touch=README.md'] } }, mutate: (c) => (c.spec.limits!.maxVerificationAttempts = 1) }, [DONE]);

    expect(formatEvents(final.runId)).toEqual([]);
    expect(verifications(final.runId)).toEqual([expect.objectContaining({ result: 'FAIL', summary: 'no changes were made to the worktree' })]);
    expect(readFileSync(join(final.worktreePath!, 'README.md'), 'utf8')).not.toContain('touched by formatter');
  });

  it('records a SKIPPED formatter without an event when no changed file matches', async () => {
    const final = await drive({ formatters: { 'docs-only': { ...ROOT_FMT, include: ['docs/**/*.md'] } } }, [GOOD_TURN, DONE]);
    expect(formatEvents(final.runId)).toEqual([]);
    expect(final.state).toBe('READY_FOR_REVIEW');
  });
});

describe('ToolGateway.runFormatter', () => {
  it('passes only writable changed paths that match include, relative to the repository root', async () => {
    const { run, gateway } = await prepareGateway();
    const changed = ['src/api/session.ts', 'studio/app.ts', 'src/api/NOTES.md', 'lib/util.ts', 'src/secrets/key.ts', 'package.json'];
    // Give session.ts a formatting problem so the effect is observable.
    writeFileSync(join(run.worktreePath!, 'src/api/session.ts'), `${SESSION_TS_WITH_METADATA.trimEnd()}   `);

    const result = await gateway.runFormatter('all-ts', spec({ exec: 'node', args: ['tools/fmt.mjs'], include: ['**/*.ts', 'package.json'] }), changed);

    // lib/util.ts is not writable; src/secrets/key.ts and package.json are denied; NOTES.md is outside include.
    expect(result).toMatchObject({ id: 'all-ts', files: ['src/api/session.ts', 'studio/app.ts'], status: 'FORMATTED', exitCode: 0 });
    expect(result.outputTail).toContain('fmt files=["src/api/session.ts","studio/app.ts"]');
    expect(readFileSync(join(run.worktreePath!, 'src/api/session.ts'), 'utf8')).toBe(SESSION_TS_WITH_METADATA);
    expect(readFileSync(join(run.worktreePath!, 'lib/util.ts'), 'utf8')).toBe('export const util = 1;   \n');
    expect(formatEvents(run.runId)).toEqual([
      { formatterId: 'all-ts', files: ['src/api/session.ts', 'studio/app.ts'], status: 'FORMATTED', exitCode: 0, durationMs: expect.any(Number), outputTail: result.outputTail },
    ]);
  });

  it.each(['studio', 'studio/'])('with cwd %j passes only files under it, relative to it, and runs there', async (cwd) => {
    const { run, gateway } = await prepareGateway();
    const changed = ['src/api/session.ts', 'studio/app.ts', 'studio/nested/deep.ts', 'studio-legacy/app.ts'];

    const result = await gateway.runFormatter('studio', spec({ exec: 'node', args: ['../tools/fmt.mjs'], cwd, include: ['**/*.ts'] }), changed);

    // studio-legacy/ shares the `studio` prefix but is not under studio/.
    expect(result).toMatchObject({ files: ['studio/app.ts', 'studio/nested/deep.ts'], status: 'FORMATTED', exitCode: 0 });
    expect(result.outputTail).toContain(`fmt cwd=${join(run.worktreePath!, 'studio')}\n`);
    expect(result.outputTail).toContain('fmt files=["app.ts","nested/deep.ts"]');
    expect(readFileSync(join(run.worktreePath!, 'studio/nested/deep.ts'), 'utf8')).toBe('export const deep = 1;\n');
    expect(readFileSync(join(run.worktreePath!, 'studio-legacy/app.ts'), 'utf8')).toBe('export const old = 1;   \n');
  });

  it('returns SKIPPED without running anything or emitting an event when no path matches', async () => {
    const { run, gateway } = await prepareGateway();
    const touching = spec({ exec: 'node', args: ['tools/fmt.mjs', '--touch=README.md'], include: ['docs/**'] });

    expect(await gateway.runFormatter('docs', touching, ['src/api/session.ts', 'studio/app.ts'])).toEqual({ id: 'docs', files: [], status: 'SKIPPED', exitCode: null, outputTail: '' });
    expect(await gateway.runFormatter('docs', { ...touching, include: ['**/*.ts'] }, [])).toMatchObject({ status: 'SKIPPED', files: [] });
    // Matches include, but only outside cwd.
    expect(await gateway.runFormatter('docs', { ...touching, include: ['**/*.ts'], cwd: 'studio' }, ['src/api/session.ts'])).toMatchObject({ status: 'SKIPPED', files: [] });
    // Matches include, but not writable.
    expect(await gateway.runFormatter('docs', { ...touching, include: ['lib/**'] }, ['lib/util.ts'])).toMatchObject({ status: 'SKIPPED', files: [] });

    expect(formatEvents(run.runId)).toEqual([]);
    expect(readFileSync(join(run.worktreePath!, 'README.md'), 'utf8')).not.toContain('touched by formatter');
  });

  it('reports a non-zero exit as FAILED with the output tail', async () => {
    const { run, gateway } = await prepareGateway();
    const result = await gateway.runFormatter('broken', spec({ exec: 'node', args: ['tools/fmt.mjs', '--fail'], include: ['**/*.ts'] }), ['studio/app.ts']);

    expect(result).toMatchObject({ id: 'broken', files: ['studio/app.ts'], status: 'FAILED', exitCode: 3 });
    expect(result.outputTail).toContain('fmt files=["studio/app.ts"]');
    expect(result.outputTail).toContain('fmt: simulated failure');
    expect(formatEvents(run.runId)).toEqual([expect.objectContaining({ formatterId: 'broken', files: ['studio/app.ts'], status: 'FAILED', exitCode: 3 })]);
  });

  it('reports a missing executable as FAILED', async () => {
    const { run, gateway } = await prepareGateway();
    const result = await gateway.runFormatter('ghost', spec({ exec: 'aperture-no-such-formatter', include: ['**/*.ts'] }), ['studio/app.ts']);

    expect(result).toMatchObject({ status: 'FAILED', exitCode: 127, outputTail: expect.stringContaining('spawn failed') });
    expect(formatEvents(run.runId)).toEqual([expect.objectContaining({ formatterId: 'ghost', status: 'FAILED', exitCode: 127 })]);
  });

  it('never hands a formatter files reached through a symlinked directory, even when the glob is writable', async () => {
    // The full write check refuses paths through symlinks before anything runs (the runner's own
    // cwd-escape guard is covered in packages/sandbox/src/runner.test.ts).
    const { run, gateway } = await prepareGateway({ mutate: (c) => (widenScope(c), c.spec.scope.writable.push('link/**')) });
    const outside = tmp.make('aperture-outside-');
    writeFileSync(join(outside, 'app.ts'), 'export const outside = 1;   \n');
    symlinkSync(outside, join(run.worktreePath!, 'link'));

    const result = await gateway.runFormatter('escape', spec({ exec: 'node', args: ['tools/fmt.mjs'], cwd: 'link', include: ['**/*.ts'] }), ['link/app.ts']);

    expect(result).toMatchObject({ files: [], status: 'SKIPPED', exitCode: null });
    expect(readFileSync(join(outside, 'app.ts'), 'utf8')).toBe('export const outside = 1;   \n');
    expect(formatEvents(run.runId)).toEqual([]);
  });

  it('turns a missing cwd into FAILED', async () => {
    const { gateway } = await prepareGateway();
    const result = await gateway.runFormatter('nowhere', spec({ exec: 'node', args: ['tools/fmt.mjs'], cwd: 'studio/missing', include: ['**/*.ts'] }), ['studio/missing/x.ts']);
    expect(result).toMatchObject({ status: 'FAILED', exitCode: 127, outputTail: expect.stringContaining('ENOENT') });
  });
});

describe.skipIf(!seatbeltAvailable)('auto-format under macOS seatbelt', () => {
  it('formats in the sandbox (root and cwd formatters) and reaches READY_FOR_REVIEW', async () => {
    const studioFmt = { exec: 'node', args: ['../tools/fmt.mjs'], cwd: 'studio', include: ['**/*.ts'] };
    const final = await drive({ isolation: 'required', formatters: { 'root-fmt': ROOT_FMT, 'studio-fmt': studioFmt }, mutate: (c) => (widenScope(c), requireFormatCheck(c)) }, [
      { toolCalls: [patchCall('src/api/session.ts', BADLY_FORMATTED_PATCH, ['R1', 'R2'], 'toolu_session'), patchCall('studio/app.ts', STUDIO_APP_PATCH, ['R1'], 'toolu_studio')] },
      DONE,
    ]);

    expect(fx.harness.isolationMode(final)).toBe('macos-seatbelt');
    expect(formatEvents(final.runId)).toEqual([
      expect.objectContaining({ formatterId: 'root-fmt', files: ['src/api/session.ts'], status: 'FORMATTED' }),
      expect.objectContaining({ formatterId: 'studio-fmt', files: ['studio/app.ts'], status: 'FORMATTED', outputTail: expect.stringContaining('fmt files=["app.ts"]') }),
    ]);
    expect(final.state).toBe('READY_FOR_REVIEW');
    expect(readFileSync(join(final.worktreePath!, 'src/api/session.ts'), 'utf8')).toBe(SESSION_TS_WITH_METADATA);
    expect(readFileSync(join(final.worktreePath!, 'studio/app.ts'), 'utf8')).toBe('export const app = 1;\nexport const name = "studio";\n');
    expect(artifact(final.runId, 'proposed.patch')).not.toMatch(/^\+.*[ \t]$/m);
  });

  it('a formatter writing outside the worktree is denied by the sandbox', async () => {
    const outside = tmp.make('aperture-outside-');
    writeFileSync(join(outside, 'victim.txt'), 'original\n');
    const final = await drive({ isolation: 'required', formatters: { sneaky: { ...ROOT_FMT, args: ['tools/fmt.mjs', `--touch=${join(outside, 'victim.txt')}`] } } }, [GOOD_TURN, DONE]);

    expect(formatEvents(final.runId)).toEqual([expect.objectContaining({ formatterId: 'sneaky', status: 'FAILED', outputTail: expect.stringMatching(/EPERM|Operation not permitted/) })]);
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('original\n');
  });
});
