import { describe, expect, it } from 'vitest';
import { analyzeContract, parseUserConfig, type UserConfig } from '@aperture/contracts';
import { issue108, sampleIssue } from '../../../tests/helpers/fetch.ts';
import { compileContract, DEFAULT_DENIED, EDIT_ME, extractExpectedFiles, extractMentionedPaths, extractRequirements, sectionItems, type RepoContext } from './compiler.ts';
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

// ---- Amendment A1 §21.4: expected files, reading material, hosted verification -----------------

const FILES_HEADING_FOR_TEST = /^(?:#{1,6}\s*)?files\b.*$/i;

/** elisealcala/agents#108 as the GitHub adapter would normalize it. */
function issue108Task(): NormalizedTask {
  const issue = issue108();
  return githubTask({ sourceRef: 'github:elisealcala/agents#108', taskKey: 'GH-108', repository: 'elisealcala/agents', title: issue.title, body: issue.body ?? '', url: issue.html_url, revision: issue.updated_at });
}

const EXPECTED_108 = ['studio/tests/manager/stage-2-boundary.spec.ts', 'project-manager/docs/implementation/evidence/stage-2-boundary.md', 'project-manager/deploy/README.md'];
const READING_108 = 'project-manager/docs/implementation/02-cloudflare-native.md';
/** The agents repo at the #108 baseline: the deploy README and the plan doc exist; the spec and evidence file do not. */
const REPO_108: RepoContext = {
  trackedFiles: ['project-manager/deploy/README.md', READING_108, 'project-manager/AGENTS.md', 'studio/package.json', 'studio/src/routes/manager.ts', 'studio/src/routes/manager.test.ts'],
  baselineRef: 'HEAD',
};

describe('sectionItems', () => {
  it('collects list items under the first matching heading until the next heading', () => {
    const body = ['Intro', '## Files', '- `a/one.ts`', 'A paragraph inside the section is skipped.', '* `b/two.ts`', '## Later', '- `c/three.ts`', '## Files again', '- `d/four.ts`'].join('\n');
    expect(sectionItems(body, FILES_HEADING_FOR_TEST)).toEqual(['`a/one.ts`', '`b/two.ts`']);
  });

  it('returns nothing when the heading is absent', () => {
    expect(sectionItems('## Goal\n- `a/one.ts`\n', FILES_HEADING_FOR_TEST)).toEqual([]);
  });

  it('does not treat a list item that matches the heading pattern as the heading', () => {
    expect(sectionItems('- files are listed below\n- `a/one.ts`\n', /files\b/i)).toEqual([]);
  });

  it('ignores items hidden in HTML comments', () => {
    expect(sectionItems('## Files\n<!--\n- `package.json`\n-->\n- `a/one.ts`\n', FILES_HEADING_FOR_TEST)).toEqual(['`a/one.ts`']);
  });
});

describe('extractExpectedFiles', () => {
  it('reads the three expected files of elisealcala/agents#108 in order', () => {
    expect(extractExpectedFiles(issue108().body!)).toEqual(EXPECTED_108);
  });

  it.each([
    ['## Files to create', 'files to create'],
    ['### Files to modify', 'files to modify'],
    ['**Affected files**', 'bold affected files'],
    ['## Changed files (2)', 'heading with a suffix'],
  ])('recognizes "%s" (%s)', (heading) => {
    expect(extractExpectedFiles(`${heading}\n- \`src/new/thing.ts\`\n`)).toEqual(['src/new/thing.ts']);
  });

  it('keeps only backticked, valid, non-glob paths and normalizes ./ prefixes', () => {
    const body = [
      '## Expected files',
      '- `./docs/guide.md`',
      '- `src/a.ts` and `src/b.ts` (two in one item)',
      '- `src/**/*.ts`',
      '- `../outside.ts`',
      '- `/etc/passwd`',
      '- `.git/config`',
      '- `Makefile`',
      '- docs/not-backticked.md',
      '- `CHANGELOG.md`',
      '- `src/a.ts`',
    ].join('\n');
    expect(extractExpectedFiles(body)).toEqual(['docs/guide.md', 'src/a.ts', 'src/b.ts', 'CHANGELOG.md']);
  });

  it('returns nothing without an expected-files section', () => {
    expect(extractExpectedFiles(sampleIssue().body!)).toEqual([]);
  });
});

describe('compileContract with an expected-files section (elisealcala/agents#108)', () => {
  const { contract, notes } = compileContract(issue108Task(), config(), REPO_108);

  it('makes exactly the expected files writable, including ones that do not exist yet', () => {
    expect(contract.spec.scope.writable).toEqual(EXPECTED_108);
    expect(contract.spec.scope.writable).not.toContain(EDIT_ME);
  });

  it('makes the handoff reading material readable but not writable', () => {
    expect(contract.spec.scope.readable).toContain(READING_108);
    expect(contract.spec.scope.writable).not.toContain(READING_108);
    // Directories of the expected files are readable for context.
    expect(contract.spec.scope.readable).toEqual(expect.arrayContaining(['studio/tests/manager/**', 'project-manager/docs/implementation/evidence/**', 'project-manager/deploy/**']));
  });

  it('notes the new files (only those missing at the baseline) and the hosted-verification gap', () => {
    const codes = noteCodes(notes);
    expect(codes).toEqual(expect.arrayContaining(['NEW_FILES', 'HOSTED_VERIFICATION']));
    expect(codes).not.toContain('NO_FILES_IDENTIFIED');
    const newFiles = notes.find((n) => n.startsWith('NEW_FILES:'))!;
    expect(newFiles).toContain('studio/tests/manager/stage-2-boundary.spec.ts');
    expect(newFiles).toContain('project-manager/docs/implementation/evidence/stage-2-boundary.md');
    expect(newFiles).not.toContain('project-manager/deploy/README.md');
    expect(notes.find((n) => n.startsWith('HOSTED_VERIFICATION:'))).toMatch(/permissions\.network/);
  });

  it('takes the "Done when" checkboxes as requirements and keeps network denied until the approver adds hosts', () => {
    expect(contract.spec.requirements.map((r) => r.text)).toEqual([
      expect.stringMatching(/^Unsigned\/wrong-actor\/direct private endpoint attempts/),
      expect.stringMatching(/^Same-origin owner requests reach the intended binding/),
      expect.stringMatching(/^Protected responses are private\/no-store/),
    ]);
    expect(contract.spec.permissions.network).toBe('deny');
    expect(analyzeContract(contract, new Set(['unit'])).filter((f) => f.level === 'error')).toEqual([]);
  });
});

describe('compileContract expected-files edge cases', () => {
  it('does not make an expected file on the deny list writable, and reports it', () => {
    const body = '## Acceptance criteria\n- works\n\n## Expected files\n- `src/api/session.ts`\n- `.env.local`\n- `studio/package.json`\n';
    const { contract, notes } = compileContract(githubTask({ body }), config(), REPO);
    expect(contract.spec.scope.writable).toEqual(['src/api/session.ts']);
    expect(notes.find((n) => n.startsWith('FILTERED_DENIED_PATHS:'))).toMatch(/\.env\.local.*studio\/package\.json/);
    expect(noteCodes(notes)).not.toContain('NEW_FILES');
  });

  it('treats other tracked mentions as readable only and adds no sibling tests when files are listed', () => {
    const body = '## Acceptance criteria\n- works\n\n## Expected files\n- `src/util.ts`\n\nSee `docs/guide.md` and src/api/session.ts for background.\n';
    const { contract } = compileContract(githubTask({ body }), config(), REPO);
    expect(contract.spec.scope.writable).toEqual(['src/util.ts']);
    expect(contract.spec.scope.readable).toEqual(expect.arrayContaining(['src/**', 'docs/guide.md', 'src/api/session.ts']));
    expect(contract.spec.scope.writable).not.toContain('src/api/session.test.ts');
  });

  it('falls back to a placeholder when every expected file is denied', () => {
    const body = '## Acceptance criteria\n- works\n\n## Expected files\n- `package.json`\n';
    const { contract, notes } = compileContract(githubTask({ body }), config(), REPO);
    expect(contract.spec.scope.writable).toEqual([EDIT_ME]);
    expect(noteCodes(notes)).toEqual(expect.arrayContaining(['FILTERED_DENIED_PATHS', 'NO_FILES_IDENTIFIED']));
  });

  it.each(['deployed', 'hosted', 'production', 'staging', 'browser', 'screenshots', 'live site'])('adds HOSTED_VERIFICATION for "%s" wording', (word) => {
    const { notes } = compileContract(githubTask({ body: `## Acceptance criteria\n- the ${word} flow works in src/api/session.ts\n` }), config(), REPO);
    expect(noteCodes(notes)).toContain('HOSTED_VERIFICATION');
  });

  it('does not add HOSTED_VERIFICATION for local-only wording', () => {
    const { notes } = compileContract(githubTask({ title: 'Add metadata', body: '## Acceptance criteria\n- unit tests cover src/api/session.ts\n' }), config(), REPO);
    expect(noteCodes(notes)).not.toContain('HOSTED_VERIFICATION');
  });
});
