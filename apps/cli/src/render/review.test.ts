import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Orchestrator } from '@aperture/core';
import type { RunRecord } from '@aperture/storage';
import type { VerificationReport } from '@aperture/verifier';
import { createHarnessFixture, fixtureContract, type HarnessFixture } from '../../../../tests/helpers/harness.ts';
import { askTurn, DONE, ingestFixture, patchTurn, readTurn, scriptedModel, ScriptedInteraction } from '../../../../tests/helpers/model.ts';
import { SESSION_METADATA_PATCH } from '../../../../tests/helpers/repo.ts';
import { TempDirs } from '../../../../tests/helpers/tmp.ts';
import { formatReview } from './review.ts';
import { createStyle } from './style.ts';

const ANSI = /\u001b\[[0-9;]*m/;
const plain = createStyle(false, 120);
const color = createStyle(true, 120);

/** Lines between a section heading and the next heading (or the end). */
function section(text: string, title: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`── ${title} `));
  if (start < 0) throw new Error(`no ${title} section in:\n${text}`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('── '));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((l) => l !== '');
}

function headings(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('── '))
    .map((l) => /^── (.+?) (\(.*\) )?─+$/.exec(l)?.[1] ?? l);
}

describe('formatReview', () => {
  const tmp = new TempDirs();
  let fx: HarnessFixture;
  let final: RunRecord;
  let report: VerificationReport;

  // READY_FOR_REVIEW via the scripted model: a question answered by the user (a decision), a
  // rejected read of a denied path (a denied action), then the permitted patch.
  beforeAll(async () => {
    fx = createHarnessFixture(tmp, fixtureContract());
    const run = await ingestFixture(fx);
    const { executor } = scriptedModel([
      askTurn('toolu_ask', 'Persist metadata?', { choices: ['yes', 'no'], requirementIds: ['R1'] }),
      readTurn('package.json', 'toolu_denied'),
      patchTurn('src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2'], 'toolu_meta'),
      DONE,
    ]);
    const interaction = new ScriptedInteraction({ answers: [{ answer: 'no', choiceIndex: 1 }] });
    const orchestrator = new Orchestrator(fx.harness);
    final = await orchestrator.drive(run.runId, { executor, interaction });
    report = orchestrator.latestVerification(final.runId)!;
    fx.harness.events.append(final.runId, 'network.denied', { checkRunId: 'chk_x', checkId: 'unit', host: 'evil.example.test', port: 443, method: 'CONNECT', reason: 'host is not in the contract allowlist' });
  });

  afterAll(() => {
    fx.harness.close();
    tmp.cleanup();
  });

  it('starts from a passing READY_FOR_REVIEW run', () => {
    expect(final.state).toBe('READY_FOR_REVIEW');
    expect(report.result).toBe('PASS');
  });

  it('renders the banner with state, workspace, contract and result', () => {
    const text = formatReview(fx.harness, final.runId, report, plain);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(new RegExp(`^╭─ Review · ${final.runId} ─+╮$`));
    expect(lines[1]).toBe('│ Add optional session metadata');
    expect(lines[2]).toMatch(new RegExp(`state READY_FOR_REVIEW   workspace worktree ${final.branch!.replace(/[/.]/g, '\\$&')}   contract v1 [0-9a-f]{12}$`));
    expect(lines[3]).toContain(`verification PASS (attempt ${report.attempt}) — `);
    expect(headings(text)).toEqual(['REQUIREMENTS', 'CHANGES', 'CHECKS', 'DENIED ACTIONS', 'DECISIONS', 'COST', 'RISKS']);
  });

  it('marks requirements ✓ / ~ / ✗ by status', () => {
    const mixed: VerificationReport = {
      ...report,
      result: 'UNVERIFIED',
      requirements: [
        { ...report.requirements[0]!, status: 'VERIFIED', note: 'covered by unit' },
        { ...report.requirements[1]!, status: 'UNVERIFIED', note: 'no check covers R2' },
        { ...report.requirements[1]!, id: 'R3', text: 'Reject bad metadata', status: 'FAILED', note: 'unit failed' },
      ],
    };
    const lines = section(formatReview(fx.harness, final.runId, mixed, plain), 'REQUIREMENTS');
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ {2}✓ R1 {3}VERIFIED {3}Accept an optional metadata field$/),
        expect.stringMatching(/^ {20}covered by unit$/),
        expect.stringMatching(/^ {2}~ R2 {3}UNVERIFIED Preserve compatibility when omitted$/),
        expect.stringMatching(/^ {2}✗ R3 {3}FAILED {5}Reject bad metadata$/),
      ]),
    );
  });

  it('lists changed files with +/− totals', () => {
    const text = formatReview(fx.harness, final.runId, report, plain);
    expect(text).toMatch(/^── CHANGES \(1 files, \+2 −1\) ─+$/m);
    expect(section(text, 'CHANGES')).toEqual([expect.stringMatching(/^ {2}M {2}src\/api\/session\.ts +\+2 +−1$/)]);
  });

  it('sums totals over several files and shows binary changes and added/deleted status', () => {
    const many: VerificationReport = {
      ...report,
      changes: [
        { path: 'a.ts', status: 'A', added: 10, removed: 0, authorized: true },
        { path: 'b.ts', status: 'D', added: 0, removed: 4, authorized: true },
        { path: 'logo.png', status: 'M', added: null, removed: null, authorized: true },
      ],
    };
    const text = formatReview(fx.harness, final.runId, many, plain);
    expect(text).toMatch(/^── CHANGES \(3 files, \+10 −4\) ─+$/m);
    const lines = section(text, 'CHANGES');
    expect(lines[0]).toMatch(/^ {2}A {2}a\.ts +\+10 +−0$/);
    expect(lines[1]).toMatch(/^ {2}D {2}b\.ts +\+0 +−4$/);
    expect(lines[2]).toMatch(/^ {2}M {2}logo\.png +\+bin +−bin$/);
  });

  it('says so when nothing changed', () => {
    const text = formatReview(fx.harness, final.runId, { ...report, changes: [] }, plain);
    expect(text).toMatch(/^── CHANGES \(0 files, \+0 −0\) ─+$/m);
    expect(section(text, 'CHANGES')).toEqual(['  no changes']);
  });

  it('lists checks with status, exit code, duration and optional flag', () => {
    const lines = section(formatReview(fx.harness, final.runId, report, plain), 'CHECKS');
    expect(lines).toEqual(
      expect.arrayContaining([expect.stringMatching(/^ {2}✓ unit {13}PASS {5}exit 0 · \d+\.\ds$/), expect.stringMatching(/^ {2}✓ has-metadata {5}PASS {5}exit 0 · \d+\.\ds · optional$/)]),
    );
  });

  it('marks failing, erroring and timed-out checks, and warns when none ran', () => {
    const base = report.checks[0]!;
    const failing: VerificationReport = {
      ...report,
      checks: [
        { ...base, checkId: 'f', status: 'FAIL', exitCode: 1, durationMs: 1500 },
        { ...base, checkId: 'e', status: 'ERROR', exitCode: 127, durationMs: 0 },
        { ...base, checkId: 't', status: 'TIMEOUT', exitCode: null, durationMs: 60_000 },
      ],
    };
    expect(section(formatReview(fx.harness, final.runId, failing, plain), 'CHECKS')).toEqual([
      `  ✗ ${'f'.padEnd(16)} ${'FAIL'.padEnd(8)} exit 1 · 1.5s`,
      `  ✗ ${'e'.padEnd(16)} ${'ERROR'.padEnd(8)} exit 127 · 0.0s`,
      `  ⏱ ${'t'.padEnd(16)} ${'TIMEOUT'.padEnd(8)} exit - · 60.0s`,
    ]);
    expect(section(formatReview(fx.harness, final.runId, { ...report, checks: [] }, plain), 'CHECKS')).toEqual(['  ▲ no checks ran']);
  });

  it('shows scope violations only when there are any', () => {
    expect(formatReview(fx.harness, final.runId, report, plain)).not.toContain('SCOPE VIOLATIONS');
    const violated: VerificationReport = { ...report, result: 'FAIL', violations: [{ path: 'package.json', code: 'DENIED', detail: 'denied by the contract' }] };
    const text = formatReview(fx.harness, final.runId, violated, plain);
    expect(section(text, 'SCOPE VIOLATIONS')).toEqual(['  ✗ package.json DENIED denied by the contract']);
    expect(headings(text).indexOf('SCOPE VIOLATIONS')).toBe(headings(text).indexOf('CHECKS') + 1);
  });

  it('lists denied tool calls and network.denied events with their reason', () => {
    const text = formatReview(fx.harness, final.runId, report, plain);
    expect(text).toMatch(/^── DENIED ACTIONS \(2\) ─+$/m);
    const lines = section(text, 'DENIED ACTIONS');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^ {2}! read_file( package\.json)? PATH_DENIED$/);
    expect(lines[1]).toBe('  ! egress evil.example.test:443 host is not in the contract allowlist');
  });

  it('shows only the last 10 denied actions with a pointer to the rest', async () => {
    const tfx = createHarnessFixture(tmp, fixtureContract());
    try {
      const run = await ingestFixture(tfx);
      for (let i = 0; i < 12; i++) tfx.harness.events.append(run.runId, 'network.denied', { checkRunId: 'chk', checkId: 'unit', host: `h${i}.example.test`, port: 443, method: 'CONNECT', reason: 'host is not in the contract allowlist' });
      const text = formatReview(tfx.harness, run.runId, report, plain);
      expect(text).toMatch(/^── DENIED ACTIONS \(12\) ─+$/m);
      const lines = section(text, 'DENIED ACTIONS');
      expect(lines).toHaveLength(11);
      expect(lines[0]).toContain('h2.example.test');
      expect(lines[9]).toContain('h11.example.test');
      expect(lines[10]).toBe(`  … 2 more in \`aperture logs ${run.runId} --filter tool.rejected\``);
    } finally {
      tfx.harness.close();
    }
  });

  it('lists the recorded decisions', () => {
    const lines = section(formatReview(fx.harness, final.runId, report, plain), 'DECISIONS');
    expect(lines).toEqual([expect.stringMatching(/^ {2}answer {8}tester \{"answer":"no","choiceIndex":1\}$/)]);
  });

  it('shows cost per phase with request count, models and cache hit rate', () => {
    const lines = section(formatReview(fx.harness, final.runId, report, plain), 'COST');
    expect(lines).toEqual([expect.stringMatching(/^ {2}implementation {2}\$\d+\.\d{4} {2}4 requests · claude-sonnet-5-5 · (no cache|\d+% cache hit)$/)]);
  });

  it('lists non-verified requirements as risks plus the standing reminder', () => {
    expect(section(formatReview(fx.harness, final.runId, report, plain), 'RISKS')).toEqual(['  ▲ passing checks do not prove product behavior; read the diff before accepting']);
    const risky: VerificationReport = { ...report, requirements: [{ ...report.requirements[0]!, status: 'UNVERIFIED', note: 'no check covers R1' }, report.requirements[1]!] };
    expect(section(formatReview(fx.harness, final.runId, risky, plain), 'RISKS')).toEqual(['  ▲ R1 UNVERIFIED: no check covers R1', '  ▲ passing checks do not prove product behavior; read the diff before accepting']);
  });

  it('emits no ANSI codes when the style is disabled and colors when enabled', () => {
    const off = formatReview(fx.harness, final.runId, report, plain);
    const on = formatReview(fx.harness, final.runId, report, color);
    expect(off).not.toMatch(ANSI);
    expect(on).toMatch(ANSI);
    expect(on).toContain(color(['green', 'bold'], 'PASS'));
  });
});
