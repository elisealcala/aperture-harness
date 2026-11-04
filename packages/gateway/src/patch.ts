import type { ReasonCode } from '@aperture/events';
import { normalizeRepoPath } from './path-policy.ts';

export interface ParsedPatch {
  /** Canonical single-file patch with harness-written headers. */
  canonical: string;
  kind: 'modify' | 'create' | 'delete';
  added: number;
  removed: number;
  hunks: number;
}

export type PatchParseResult = { ok: true; patch: ParsedPatch } | { ok: false; reasonCode: ReasonCode; message: string };

const FORBIDDEN_HEADERS: ReadonlyArray<[RegExp, string]> = [
  [/^GIT binary patch/, 'binary patches are not allowed'],
  [/^Binary files /, 'binary changes are not allowed'],
  [/^(old|new) mode /, 'file mode changes are not allowed'],
  [/^deleted file mode (?!100644$)/, 'only regular files can be deleted'],
  [/^new file mode (?!100644$)/, 'only regular non-executable files can be created (no symlinks, submodules or executables)'],
  [/^(rename|copy) (from|to) /, 'renames and copies are not allowed; patch one file at a time'],
  [/^similarity index /, 'renames and copies are not allowed'],
  [/^dissimilarity index /, 'rewrites with dissimilarity headers are not allowed'],
];

function headerPath(raw: string): string | null | undefined {
  const value = raw.replace(/\t.*$/, '').trim();
  if (value === '/dev/null') return null;
  const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  const stripped = unquoted.replace(/^[ab]\//, '');
  const norm = normalizeRepoPath(stripped);
  return norm.ok ? norm.path : undefined;
}

/**
 * Validates a model-supplied unified diff against the single declared path and re-emits it with
 * canonical headers. The patch text is data: nothing inside it is executed or interpreted beyond
 * diff syntax, and any header that would rename, re-mode, symlink or binary-patch a file is refused.
 */
export function parseSingleFilePatch(declaredPath: string, diff: string): PatchParseResult {
  if (diff.includes('\0')) return { ok: false, reasonCode: 'PATCH_UNSUPPORTED', message: 'patch contains NUL bytes' };
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();

  let oldPath: string | null | undefined;
  let newPath: string | null | undefined;
  let sawOld = false;
  let sawNew = false;
  let sections = 0;
  const body: string[] = [];
  let inHunk = false;
  let hunks = 0;
  let added = 0;
  let removed = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    // Inside a hunk, "--- x" is a removed line ("-- x") unless it starts a new file section.
    const startsFileHeader = line.startsWith('--- ') && (!inHunk || (lines[index + 1] ?? '').startsWith('+++ '));
    if (line.startsWith('diff --git ')) {
      sections++;
      if (sections > 1) return { ok: false, reasonCode: 'PATCH_PATH_MISMATCH', message: 'patch touches more than one file; send one propose_patch per file' };
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      for (const [pattern, message] of FORBIDDEN_HEADERS) {
        if (pattern.test(line)) return { ok: false, reasonCode: 'PATCH_UNSUPPORTED', message };
      }
    }
    if (startsFileHeader) {
      if (sawOld && sawNew) return { ok: false, reasonCode: 'PATCH_PATH_MISMATCH', message: 'patch touches more than one file; send one propose_patch per file' };
      oldPath = headerPath(line.slice(4));
      sawOld = true;
      inHunk = false;
      continue;
    }
    if (line.startsWith('+++ ') && sawOld && !sawNew) {
      newPath = headerPath(line.slice(4));
      sawNew = true;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!sawOld || !sawNew) return { ok: false, reasonCode: 'PATCH_UNSUPPORTED', message: 'hunk appears before ---/+++ file headers' };
      if (!/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(line)) return { ok: false, reasonCode: 'PATCH_UNSUPPORTED', message: `malformed hunk header: ${line.slice(0, 80)}` };
      inHunk = true;
      hunks++;
      body.push(line);
      continue;
    }
    if (inHunk) {
      const marker = line[0];
      if (marker === '+') added++;
      else if (marker === '-') removed++;
      else if (marker !== ' ' && marker !== '\\' && line !== '') {
        return { ok: false, reasonCode: 'PATCH_UNSUPPORTED', message: `unexpected line inside hunk: ${line.slice(0, 80)}` };
      }
      body.push(line === '' ? ' ' : line);
      continue;
    }
    // Extended git headers (index ..., new file mode 100644, deleted file mode 100644) are allowed and dropped.
    if (/^(index [0-9a-f]+\.\.[0-9a-f]+( \d+)?|new file mode 100644|deleted file mode 100644)$/.test(line)) continue;
    if (line.trim() === '') continue;
    return { ok: false, reasonCode: 'PATCH_UNSUPPORTED', message: `unexpected line outside a hunk: ${line.slice(0, 80)}` };
  }

  if (!sawOld || !sawNew) return { ok: false, reasonCode: 'PATCH_UNSUPPORTED', message: 'patch must include --- and +++ file headers' };
  if (hunks === 0) return { ok: false, reasonCode: 'PATCH_UNSUPPORTED', message: 'patch contains no hunks' };
  if (oldPath === undefined || newPath === undefined) {
    return { ok: false, reasonCode: 'PATCH_PATH_MISMATCH', message: 'patch headers name an invalid path' };
  }
  if (oldPath === null && newPath === null) return { ok: false, reasonCode: 'PATCH_UNSUPPORTED', message: 'both sides of the patch are /dev/null' };
  for (const p of [oldPath, newPath]) {
    if (p !== null && p !== declaredPath) {
      return { ok: false, reasonCode: 'PATCH_PATH_MISMATCH', message: `patch header names ${p} but the declared path is ${declaredPath}` };
    }
  }

  const kind: ParsedPatch['kind'] = oldPath === null ? 'create' : newPath === null ? 'delete' : 'modify';
  const header = [
    `diff --git a/${declaredPath} b/${declaredPath}`,
    ...(kind === 'create' ? ['new file mode 100644'] : kind === 'delete' ? ['deleted file mode 100644'] : []),
    `--- ${kind === 'create' ? '/dev/null' : `a/${declaredPath}`}`,
    `+++ ${kind === 'delete' ? '/dev/null' : `b/${declaredPath}`}`,
  ];
  return { ok: true, patch: { canonical: `${[...header, ...body].join('\n')}\n`, kind, added, removed, hunks } };
}
