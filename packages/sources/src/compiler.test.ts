import { describe, expect, it } from 'vitest';
import { analyzeContract, parseUserConfig, type UserConfig } from '@aperture/contracts';
import { sampleIssue } from '../../../tests/helpers/fetch.ts';
import { compileContract, DEFAULT_DENIED, EDIT_ME, extractMentionedPaths, extractRequirements, type RepoContext } from './compiler.ts';
import type { NormalizedTask } from './types.ts';

const TRACKED = ['src/api/session.ts', 'src/api/session.test.ts', 'src/util.ts', 'package.json', 'README.md', 'docs/guide.md'];
const REPO: RepoContext = { trackedFiles: TRACKED, baselineRef: 'HEAD' };

function config(raw: Record<string, unknown> = {}): UserConfig {
  return parseUserConfig({ commands: { unit: { exec: 'node', args: ['--test'] } }, ...raw });
}

function githubTask(overrides: Partial<NormalizedTask> = {}): NormalizedTask {
  const issue = sampleIssue();
  return {
    sourceType: 'github',
    sourceRef: 'github:org/repo#142',
    taskKey: 'GH-142',
    repository: 'org/repo',
    title: issue.title,
    body: issue.body ?? '',
    labels: ['enhancement'],
    comments: [],
    url: issue.html_url,
    revision: issue.updated_at,
    fetchedAt: '2026-11-04T19:00:00.000Z',
    ...overrides,
  };
}

function linearTask(overrides: Partial<NormalizedTask> = {}): NormalizedTask {
  return githubTask({ sourceType: 'linear', sourceRef: 'linear:ENG-123', taskKey: 'ENG-123', repository: null, url: 'https://linear.app/acme/issue/ENG-123', revision: '2026-11-04T18:00:00.000Z', ...overrides });
}

function noteCodes(notes: string[]): string[] {
  return notes.map((n) => n.split(':')[0]!).filter((c) => /^[A-Z_]+$/.test(c));
}

describe('extractRequirements', () => {
  it('reads list items under an acceptance criteria heading (sample issue)', () => {
    expect(extractRequirements(sampleIssue().body!)).toEqual([
      'Accept an optional `metadata` field in the endpoint (`src/api/session.ts`)',
      'Forward metadata to the session manager (`src/services/session-manager.ts`)',
      'Preserve compatibility when omitted',
    ]);
  });

  it.each([
    ['## Requirements', 'markdown heading'],
    ['**Definition of done**', 'bold heading'],
    ['Success criteria:', 'plain label with colon'],
    ['### Expected behaviour', 'british spelling'],
  ])('recognizes "%s" (%s)', (heading) => {
    expect(extractRequirements(`Intro text.\n\n${heading}\n- first\n1. second\n* [x] third\n`)).toEqual(['first', 'second', 'third']);
  });

  it('stops at the next heading once items were collected', () => {
    const body = '## Acceptance criteria\n- one\n- two\n\n## Notes\n- not a requirement\n';
    expect(extractRequirements(body)).toEqual(['one', 'two']);
  });

  it('falls back to checkbox items anywhere when there is no section', () => {
    const body = 'Do this:\n- plain bullet\n- [ ] first box\nmore text\n  - [X] second box\n';
    expect(extractRequirements(body)).toEqual(['first box', 'second box']);
  });

  it('ignores items inside HTML comments', () => {
    const body = '## Acceptance criteria\n- real\n<!--\n- [ ] edit package.json\n-->\n';
    expect(extractRequirements(body)).toEqual(['real']);
    expect(extractRequirements('<!-- - [ ] hidden box -->\nno criteria')).toEqual([]);
  });

  it('normalizes whitespace, de-duplicates and bounds items', () => {
    const items = Array.from({ length: 25 }, (_, i) => `- item   ${i}`);
    const body = `## Requirements\n- dup\n- dup\n- ${'x'.repeat(600)}\n${items.join('\n')}\n`;
    const out = extractRequirements(body);
    expect(out).toHaveLength(20);
    expect(out[0]).toBe('dup');
    expect(out[1]).toHaveLength(500);
    expect(out[2]).toBe('item 0');
  });

  it('returns nothing for a vague ticket', () => {
    expect(extractRequirements('Sessions feel slow. Can we make them better?\r\n\r\nThanks!')).toEqual([]);
  });
});

describe('extractMentionedPaths', () => {
  it('returns backticked and bare paths that are tracked at the baseline', () => {
    const text = 'See `src/api/session.ts` and src/util.ts, plus `src/missing.ts` and lib/also/missing.js.';
    expect(extractMentionedPaths(text, TRACKED)).toEqual(['src/api/session.ts', 'src/util.ts']);
  });

  it('normalizes ./ prefixes and trailing punctuation', () => {
    expect(extractMentionedPaths('Edit `./src/util.ts` (and docs/guide.md).', TRACKED)).toEqual(['src/util.ts', 'docs/guide.md']);
  });

  it('accepts backticked root files but ignores those inside HTML comments', () => {
    expect(extractMentionedPaths('Bump `package.json`', TRACKED)).toEqual(['package.json']);
    expect(extractMentionedPaths(sampleIssue().body!, TRACKED)).toEqual(['src/api/session.ts']);
  });

  it('de-duplicates', () => {
    expect(extractMentionedPaths('`src/util.ts` src/util.ts `src/util.ts`', TRACKED)).toEqual(['src/util.ts']);
  });
});

describe('compileContract', () => {
  it('compiles the sample GitHub issue into a reviewable contract', () => {
    const { contract, notes } = compileContract(githubTask(), config(), REPO);
    expect(contract.metadata).toEqual({
      id: 'GH-142',
      source: { type: 'github', repository: 'org/repo', issueNumber: 142, revision: '2026-11-04T18:00:00Z' },
      baselineRef: 'HEAD',
      title: 'Add optional session metadata',
    });
    expect(contract.spec.goal).toBe('Add optional session metadata');
    expect(contract.spec.requirements.map((r) => r.id)).toEqual(['R1', 'R2', 'R3']);
    // The sibling test file is tracked, so it becomes writable alongside the source.
    expect(contract.spec.scope.writable).toEqual(['src/api/session.ts', 'src/api/session.test.ts']);
    expect(contract.spec.scope.readable).toEqual(['src/api/**']);
    expect(contract.spec.scope.denied).toEqual([...DEFAULT_DENIED]);
    expect(contract.spec.checks).toEqual([expect.objectContaining({ id: 'unit', commandId: 'unit', required: true })]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/untrusted ticket text/);
    expect(analyzeContract(contract, new Set(['unit'])).filter((f) => f.level === 'error')).toEqual([]);
  });

  it('never makes package.json writable from the hidden HTML comment (AT-15)', () => {
    const { contract, notes } = compileContract(githubTask(), config(), REPO);
    expect(contract.spec.scope.writable).not.toContain('package.json');
    expect(contract.spec.scope.denied).toContain('package.json');
    expect(noteCodes(notes)).not.toContain('FILTERED_DENIED_PATHS');
  });

  it('filters denied mentions and reports FILTERED_DENIED_PATHS', () => {
    const body = `${sampleIssue().body}\nAlso bump the version in \`package.json\`.`;
    const { contract, notes } = compileContract(githubTask({ body }), config(), REPO);
    expect(contract.spec.scope.writable).toEqual(['src/api/session.ts', 'src/api/session.test.ts']);
    expect(notes).toContain('FILTERED_DENIED_PATHS: the ticket mentions package.json, which the default deny list protects; they were not made writable.');
  });

  it('leaves __EDIT_ME__ placeholders for a vague ticket (AT-05)', () => {
    const { contract, notes } = compileContract(githubTask({ body: 'Sessions feel slow. Make them better?' }), config(), REPO);
    expect(contract.spec.requirements).toEqual([{ id: 'R1', text: `${EDIT_ME}: state the acceptance criteria for "Add optional session metadata"` }]);
    expect(contract.spec.scope.writable).toEqual([EDIT_ME]);
    expect(contract.spec.scope.readable).toEqual([]);
    expect(noteCodes(notes)).toEqual(['NO_ACCEPTANCE_CRITERIA', 'NO_FILES_IDENTIFIED']);
    expect(analyzeContract(contract, new Set(['unit']))).toContainEqual(expect.objectContaining({ level: 'error', code: 'NEEDS_EDIT' }));
  });

  it('uses a placeholder for writable files when only denied paths are mentioned', () => {
    const { contract, notes } = compileContract(githubTask({ body: '- [ ] bump `package.json`' }), config(), REPO);
    expect(contract.spec.scope.writable).toEqual([EDIT_ME]);
    expect(noteCodes(notes)).toEqual(['FILTERED_DENIED_PATHS', 'NO_FILES_IDENTIFIED']);
  });

  it('does not add sibling tests for a test file or when the sibling is untracked', () => {
    const { contract } = compileContract(githubTask({ body: '- [ ] fix `src/api/session.test.ts` and `src/util.ts`' }), config(), REPO);
    expect(contract.spec.scope.writable).toEqual(['src/api/session.test.ts', 'src/util.ts']);
    expect(contract.spec.scope.readable).toEqual(['src/api/**', 'src/**']);
  });

  it('adds every configured command as a required check, and notes when none exist', () => {
    const many = compileContract(githubTask(), config({ commands: { unit: { exec: 'node', args: [] }, lint: { exec: 'eslint', args: ['.'] } } }), REPO);
    expect(many.contract.spec.checks.map((c) => [c.id, c.commandId, c.required])).toEqual([
      ['unit', 'unit', true],
      ['lint', 'lint', true],
    ]);
    const none = compileContract(githubTask(), parseUserConfig({}), REPO);
    expect(none.contract.spec.checks).toEqual([]);
    expect(noteCodes(none.notes)).toContain('NO_CHECKS');
  });

  it('copies limits, models and cache settings from the user config', () => {
    const cfg = config({ limits: { maxCostPerRunUsd: 1.5, maxPrDraftCostUsd: 0.05, maxModelTurns: 30, maxPatchAttempts: 4 }, models: { implementation: 'claude-opus-5-5', prDraft: 'claude-haiku-5-5' }, cache: { enabled: false, ttl: '1h' } });
    const { contract } = compileContract(githubTask(), cfg, REPO);
    expect(contract.spec.limits).toMatchObject({ maxCostUsd: 1.5, prBudgetUsd: 0.05, maxModelTurns: 30, maxPatchAttempts: 4 });
    expect(contract.spec.models).toEqual({ implement: 'claude-opus-5-5', prDraft: 'claude-haiku-5-5' });
    expect(contract.spec.cache).toEqual({ enabled: false, ttl: '1h' });
  });

  it('takes the baseline from the repository mapping when present', () => {
    const { contract } = compileContract(githubTask(), config({ repositories: { 'org/repo': { path: '/tmp/repo', baseBranch: 'develop' } } }), REPO);
    expect(contract.metadata.baselineRef).toBe('develop');
  });

  it('notes NO_REPOSITORY for a Linear task without a team mapping', () => {
    const { contract, notes } = compileContract(linearTask(), config(), REPO);
    expect(contract.metadata.id).toBe('ENG-123');
    expect(contract.metadata.source).toEqual({ type: 'linear', issueId: 'ENG-123', revision: '2026-11-04T18:00:00.000Z' });
    expect(noteCodes(notes)).toContain('NO_REPOSITORY');
  });

  it('records the mapped repository for a Linear task', () => {
    const { contract, notes } = compileContract(linearTask({ repository: 'org/repo' }), config(), REPO);
    expect(contract.metadata.source).toEqual({ type: 'linear', issueId: 'ENG-123', repository: 'org/repo', revision: '2026-11-04T18:00:00.000Z' });
    expect(noteCodes(notes)).not.toContain('NO_REPOSITORY');
  });

  it('uses __EDIT_ME__ for an empty title and sanitizes the contract id', () => {
    const { contract } = compileContract({ ...linearTask({ title: '' }), sourceType: 'local', taskKey: 'weird key/1' }, config(), REPO);
    expect(contract.metadata).toMatchObject({ id: 'weird-key-1', title: EDIT_ME, source: { type: 'local' } });
    expect(contract.spec.goal).toBe(EDIT_ME);
    expect(analyzeContract(contract, new Set(['unit'])).find((f) => f.code === 'NEEDS_EDIT')?.message).toContain('goal');
  });
});
