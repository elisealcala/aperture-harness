import { describe, expect, it } from 'vitest';
import { parseContract, type ContractInput, type ExecutionContract } from '@aperture/contracts';
import { fixtureContract, type FixtureContractOptions } from '../../../../tests/helpers/harness.ts';
import { formatContract, type ContractViewInput } from './contract.ts';
import { createStyle } from './style.ts';

const ANSI = /\u001b\[[0-9;]*m/;
const SHA = 'f'.repeat(64);
const plain = createStyle(false, 100);
const color = createStyle(true, 100);

function contract(mutate?: (c: ContractInput) => void, options: Omit<FixtureContractOptions, 'mutate'> = {}): ExecutionContract {
  return parseContract(fixtureContract({ ...options, ...(mutate ? { mutate } : {}) }));
}

function view(extra: Partial<ContractViewInput> = {}, c: ExecutionContract = contract()): ContractViewInput {
  return { contract: c, version: 2, sha256: SHA, ...extra };
}

/** Lines between a section heading and the next heading (or the end). */
function section(text: string, title: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`── ${title} `));
  if (start < 0) throw new Error(`no ${title} section in:\n${text}`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('── '));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

describe('formatContract', () => {
  it('renders the banner and every section in order', () => {
    const text = formatContract(view({ notes: ['VAGUE_TICKET: needs review'] }), plain);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^╭─ Contract v2 · LOCAL-142 ─+╮$/);
    expect(lines[1]).toBe('│ Add optional session metadata');
    expect(lines[2]).toContain(`source local contract   baseline HEAD   sha256 ${SHA.slice(0, 16)}`);
    expect(lines[2]).not.toContain(SHA.slice(0, 17));
    const headings = lines.filter((l) => l.startsWith('── ')).map((l) => /^── (.+?) (\(\d+\) )?─+$/.exec(l)?.[1]);
    expect(headings).toEqual(['GOAL', 'REQUIREMENTS', 'SCOPE', 'PERMISSIONS', 'CHECKS', 'LIMITS & MODELS', 'REVIEW NOTES']);
    expect(section(text, 'GOAL')).toEqual(['  Accept and forward optional session metadata without changing existing behavior', '']);
  });

  it('lists requirements with their count', () => {
    const text = formatContract(view(), plain);
    expect(text).toMatch(/^── REQUIREMENTS \(2\) ─+$/m);
    expect(section(text, 'REQUIREMENTS').filter(Boolean)).toEqual(['  R1   Accept an optional metadata field', '  R2   Preserve compatibility when omitted']);
  });

  it('labels a github source', () => {
    const c = contract((x) => void (x.metadata.source = { type: 'github', repository: 'org/repo', issueNumber: 142 } as never));
    expect(formatContract(view({}, c), plain)).toContain('source github:org/repo#142');
  });

  describe('SCOPE', () => {
    it('marks writable paths absent from existingPaths as new files', () => {
      const lines = section(formatContract(view({ existingPaths: new Set(['src/api/session.ts', 'README.md']) }), plain), 'SCOPE');
      expect(lines).toContain('    ✎ src/api/session.ts');
      expect(lines).toContain('    ✎ src/api/session.test.ts (new file)');
    });

    it('never marks glob patterns as new', () => {
      const c = contract((x) => void (x.spec.scope.writable = ['src/api/session.ts', 'src/api/*.ts']));
      const lines = section(formatContract(view({ existingPaths: new Set(['src/api/session.ts']) }, c), plain), 'SCOPE');
      expect(lines).toContain('    ✎ src/api/*.ts');
      expect(lines.join('\n')).not.toContain('(new file)');
    });

    it('marks nothing as new without existingPaths', () => {
      expect(formatContract(view(), plain)).not.toContain('(new file)');
    });

    it('lists readable and denied paths', () => {
      const lines = section(formatContract(view(), plain), 'SCOPE');
      expect(lines).toContain('    ◦ src/**');
      expect(lines).toContain('    ◦ test/**');
      // Joined with two spaces, but wrap() collapses whitespace, so the denied list is single-spaced.
      expect(lines).toContain('    package.json pnpm-lock.yaml .env* **/secrets/**');
    });

    it('says writable files only when nothing extra is readable', () => {
      const c = contract((x) => void (x.spec.scope.readable = []));
      expect(section(formatContract(view({}, c), plain), 'SCOPE')).toContain('    (writable files only)');
    });
  });

  describe('PERMISSIONS', () => {
    it("shows network 'none' when the contract denies it", () => {
      const lines = section(formatContract(view(), plain), 'PERMISSIONS');
      expect(lines[0]).toBe('  network       none');
      expect(lines.join('\n')).not.toContain('allowlist');
    });

    it('shows allowlisted hosts and the phases they apply to', () => {
      const c = contract((x) => void (x.spec.permissions = { network: { mode: 'allowlist', hosts: ['studio.example.dev:443', '*.api.example.com'] } }));
      const lines = section(formatContract(view({}, c), plain), 'PERMISSIONS');
      expect(lines[0]).toBe('  network       allowlist studio.example.dev:443, *.api.example.com (checks only; the model never has network)');
    });
  });

  describe('CHECKS', () => {
    it('shows each check with required/optional, its command and covers', () => {
      const c = contract((x) => void (x.spec.checks![0]!.covers = ['R1', 'R2']));
      const text = formatContract(view({}, c), plain);
      expect(text).toMatch(/^── CHECKS \(2\) ─+$/m);
      const lines = section(text, 'CHECKS');
      expect(lines).toContain(`  ● ${'unit'.padEnd(14)} required  node --test test/session.test.mjs`);
      expect(lines).toContain(`  ○ ${'has-metadata'.padEnd(14)} optional  node test/check-metadata.mjs`);
      expect(lines).toContain('      covers R1, R2');
    });

    it('shows env sources: literal values, $VAR and $VAR (secret)', () => {
      const c = contract((x) => {
        x.spec.commands!.unit!.env = {
          BASE_URL: { value: 'https://studio.example.dev' },
          OWNER_TOKEN: { fromEnv: 'STUDIO_OWNER_TOKEN', secret: true },
          PUBLIC_ID: { fromEnv: 'STUDIO_PUBLIC_ID', secret: false },
        };
      });
      const lines = section(formatContract(view({}, c), plain), 'CHECKS');
      expect(lines).toContain('      env BASE_URL = https://studio.example.dev');
      expect(lines).toContain('      env OWNER_TOKEN ← $STUDIO_OWNER_TOKEN (secret)');
      expect(lines).toContain('      env PUBLIC_ID ← $STUDIO_PUBLIC_ID');
    });

    it('warns when no checks are declared', () => {
      const c = contract((x) => {
        x.spec.checks = [];
      });
      expect(section(formatContract(view({}, c), plain), 'CHECKS')).toContain('  ▲ none declared: every requirement will stay UNVERIFIED and need manual review');
    });
  });

  it('shows limits, models and cache', () => {
    const lines = section(formatContract(view(), plain), 'LIMITS & MODELS');
    const c = contract();
    expect(lines[0]).toBe(`  budget  $0.50 implementation · $${c.spec.limits.prBudgetUsd.toFixed(2)} PR draft    caps 12 turns · 8 patches · ${c.spec.limits.maxVerificationAttempts} verifications · 30 min`);
    expect(lines[1]).toBe(`  models  ${c.spec.models.implement} (implement) · ${c.spec.models.prDraft} (PR)    cache ${c.spec.cache.enabled ? c.spec.cache.ttl : 'off'}`);
  });

  it("shows cache 'off' when disabled", () => {
    const c = contract((x) => void (x.spec.cache = { enabled: false }));
    expect(section(formatContract(view({}, c), plain), 'LIMITS & MODELS')[1]).toMatch(/cache off$/);
  });

  describe('REVIEW NOTES', () => {
    it('is omitted without notes or findings', () => {
      expect(formatContract(view({ notes: [], findings: [] }), plain)).not.toContain('REVIEW NOTES');
    });

    it('splits CODE: text notes, labels uncoded notes NOTE, and orders errors, warnings, notes', () => {
      const text = formatContract(
        view({
          notes: ['VAGUE_TICKET: The ticket does not say where metadata goes.', 'Free-form note without a code'],
          findings: [
            { level: 'warning', code: 'BROAD_SCOPE', message: 'writable covers a directory' },
            { level: 'error', code: 'UNKNOWN_COMMAND', message: 'check x has no command' },
          ],
        }),
        plain,
      );
      expect(section(text, 'REVIEW NOTES')).toEqual([
        '  ✗ UNKNOWN_COMMAND check x has no command',
        '  ▲ BROAD_SCOPE writable covers a directory',
        '  ℹ VAGUE_TICKET The ticket does not say where metadata goes.',
        '  ℹ NOTE Free-form note without a code',
      ]);
    });
  });

  describe('__EDIT_ME__ placeholders', () => {
    const c = () =>
      contract((x) => {
        x.spec.requirements[0]!.text = 'Store metadata in __EDIT_ME__';
        x.spec.scope.writable = ['src/api/session.ts', 'src/__EDIT_ME__.ts'];
      });

    it('are highlighted yellow+bold when color is on', () => {
      const text = formatContract(view({}, c()), color);
      expect(text).toContain(color(['yellow', 'bold'], 'Store metadata in __EDIT_ME__'));
      expect(text).toContain(color(['yellow', 'bold'], 'src/__EDIT_ME__.ts'));
      expect(text).toContain(color('green', 'src/api/session.ts'));
    });

    it('still appear verbatim without color', () => {
      const text = formatContract(view({}, c()), plain);
      expect(text).toContain('R1   Store metadata in __EDIT_ME__');
      expect(text).toContain('    ✎ src/__EDIT_ME__.ts');
    });
  });

  it('emits no ANSI codes when the style is disabled and colors when enabled', () => {
    const input = view({ notes: ['VAGUE_TICKET: x'], findings: [{ level: 'warning', code: 'W', message: 'w' }], existingPaths: new Set(['src/api/session.ts']) });
    const off = formatContract(input, plain);
    const on = formatContract(input, color);
    expect(off).not.toMatch(ANSI);
    expect(on).toMatch(ANSI);
    expect(on.replace(/\u001b\[[0-9;]*m/g, '')).toBe(off);
  });

  it('wraps long requirement text within the style width', () => {
    const c = contract((x) => void (x.spec.requirements[0]!.text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')));
    const lines = section(formatContract(view({}, c), createStyle(false, 60)), 'REQUIREMENTS').filter(Boolean);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
  });
});
