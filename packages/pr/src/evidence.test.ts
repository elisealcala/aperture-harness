import { describe, expect, it } from 'vitest';
import { excerptDiff, issueReferenceFor } from './evidence.ts';

function fileDiff(path: string, bodyChars: number): string {
  const header = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n`;
  return `${header}+${'x'.repeat(Math.max(0, bodyChars - header.length - 2))}\n`;
}

describe('excerptDiff', () => {
  it('returns a small diff unchanged', () => {
    const diff = fileDiff('a.ts', 200) + fileDiff('b.ts', 200);
    expect(excerptDiff(diff)).toBe(diff);
  });

  it('returns an empty string for an empty diff', () => {
    expect(excerptDiff('')).toBe('');
    expect(excerptDiff('\n\n')).toBe('');
  });

  it('truncates a single file past the per-file limit but keeps its header', () => {
    const big = fileDiff('big.ts', 500);
    const out = excerptDiff(big, 10_000, 100);
    expect(out).toBe(`${big.slice(0, 100)}\n… [diff truncated]\n`);
    expect(out.startsWith('diff --git a/big.ts b/big.ts')).toBe(true);
  });

  it('omits remaining files once the total budget is reached', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((p) => fileDiff(p, 100));
    const out = excerptDiff(files.join(''), 250, 1_000);
    expect(out).toBe(`${files[0]}${files[1]}… [2 more file diffs omitted]\n`);
  });

  it('applies both bounds by default (8000 total, 2500 per file)', () => {
    const files = Array.from({ length: 6 }, (_, i) => fileDiff(`f${i}.ts`, 3_000));
    const out = excerptDiff(files.join(''));
    expect(out.length).toBeLessThanOrEqual(8_000 + 100);
    expect(out.match(/… \[diff truncated\]/g)).toHaveLength(3);
    expect(out.endsWith('… [3 more file diffs omitted]\n')).toBe(true);
  });
});

describe('issueReferenceFor', () => {
  const gh = { sourceType: 'github' as const, sourceRef: 'github:org/repo#142', taskKey: 'GH-142', repository: 'org/repo' };

  it('closes a GitHub issue in the same repository', () => {
    expect(issueReferenceFor(gh, 'org/repo')).toBe('Closes #142');
  });

  it('only refers to a GitHub issue in another repository (or with no target)', () => {
    expect(issueReferenceFor(gh, 'org/other')).toBe('Refs org/repo#142');
    expect(issueReferenceFor(gh, null)).toBe('Refs org/repo#142');
  });

  it('refers to Linear issues by identifier', () => {
    expect(issueReferenceFor({ sourceType: 'linear', sourceRef: 'linear:ENG-1', taskKey: 'ENG-1', repository: 'org/repo' }, 'org/repo')).toBe('Refs ENG-1');
  });

  it('names the contract for local tasks', () => {
    expect(issueReferenceFor({ sourceType: 'local', sourceRef: 'local:/x.yaml', taskKey: 'LOCAL-1', repository: null }, null)).toBe('Contract LOCAL-1');
  });
});
