import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { compileGlobs } from '@aperture/contracts';
import type { ReasonCode } from '@aperture/events';

export type PathDecision =
  | { allowed: true; path: string; absPath: string; exists: boolean }
  | { allowed: false; reasonCode: ReasonCode; message: string; path?: string };

export interface ScopeGlobs {
  writable: readonly string[];
  readable: readonly string[];
  denied: readonly string[];
}

function deny(reasonCode: ReasonCode, message: string, path?: string): PathDecision {
  return path === undefined ? { allowed: false, reasonCode, message } : { allowed: false, reasonCode, message, path };
}

/**
 * Normalizes a model-supplied path to a clean repository-relative POSIX path, or explains why it is
 * unacceptable. Traversal is rejected outright, even when it would normalize back inside the repo.
 */
export function normalizeRepoPath(input: string): { ok: true; path: string } | { ok: false; reasonCode: ReasonCode; message: string } {
  if (input.length === 0 || input.length > 512) return { ok: false, reasonCode: 'PATH_INVALID', message: 'path must be 1-512 characters' };
  if (/[\u0000-\u001f\u007f]/.test(input)) return { ok: false, reasonCode: 'PATH_INVALID', message: 'path contains control characters' };
  if (input.includes('\\')) return { ok: false, reasonCode: 'PATH_INVALID', message: 'use forward slashes in paths' };
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input) || input.startsWith('~')) {
    return { ok: false, reasonCode: 'PATH_ABSOLUTE', message: 'absolute and home-relative paths are not allowed' };
  }
  const rawSegments = input.split('/');
  if (rawSegments.includes('..')) return { ok: false, reasonCode: 'PATH_TRAVERSAL', message: 'parent-directory segments (..) are not allowed' };
  const normalized = posix.normalize(input).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (normalized === '' || normalized === '.') return { ok: false, reasonCode: 'PATH_INVALID', message: 'path must name a file' };
  if (normalized.split('/').some((s) => s.toLowerCase() === '.git')) {
    return { ok: false, reasonCode: 'PATH_DENIED', message: 'the .git directory is never accessible' };
  }
  return { ok: true, path: normalized };
}

/**
 * Deterministic path authorization for one run. Denied patterns are matched case-insensitively and
 * always win; writable/readable patterns are matched case-sensitively and confirmed against the
 * filesystem's true case. Symlinks are resolved and must stay inside the worktree, and the resolved
 * path must itself be authorized; writes through any symlink are refused.
 */
export class PathPolicy {
  private readonly root: string;
  private readonly isWritable: (p: string) => boolean;
  private readonly isReadableGlob: (p: string) => boolean;
  private readonly isDenied: (p: string) => boolean;

  constructor(
    worktreePath: string,
    readonly scope: ScopeGlobs,
  ) {
    this.root = realpathSync.native(worktreePath);
    this.isWritable = compileGlobs(scope.writable);
    this.isReadableGlob = compileGlobs([...scope.readable, ...scope.writable]);
    this.isDenied = compileGlobs(scope.denied, { nocase: true });
  }

  get worktreeRoot(): string {
    return this.root;
  }

  denied(path: string): boolean {
    return this.isDenied(path);
  }

  writable(path: string): boolean {
    return !this.isDenied(path) && this.isWritable(path);
  }

  readable(path: string): boolean {
    return !this.isDenied(path) && this.isReadableGlob(path);
  }

  checkRead(input: string): PathDecision {
    const norm = normalizeRepoPath(input);
    if (!norm.ok) return deny(norm.reasonCode, norm.message);
    const path = norm.path;
    if (this.isDenied(path)) return deny('PATH_DENIED', `${path} is denied by the contract`, path);
    if (!this.isReadableGlob(path)) return deny('PATH_NOT_READABLE', `${path} is outside the readable scope`, path);
    const abs = join(this.root, ...path.split('/'));
    if (!existsSync(abs)) return { allowed: true, path, absPath: abs, exists: false };
    let real: string;
    try {
      real = realpathSync.native(abs);
    } catch {
      return deny('NOT_FOUND', `${path} cannot be resolved`, path);
    }
    const rel = this.relativeInside(real);
    if (rel === undefined) return deny('PATH_ESCAPES_WORKTREE', `${path} resolves outside the worktree`, path);
    if (rel !== path) {
      // A symlink or case alias: the real target must be independently readable.
      if (rel.toLowerCase() === path.toLowerCase()) return deny('PATH_CASE_MISMATCH', `${path} differs in case from the file on disk (${rel})`, path);
      if (this.isDenied(rel)) return deny('PATH_DENIED', `${path} resolves to denied path ${rel}`, path);
      if (!this.isReadableGlob(rel)) return deny('PATH_NOT_READABLE', `${path} resolves to ${rel}, which is outside the readable scope`, path);
    }
    return { allowed: true, path, absPath: real, exists: true };
  }

  checkWrite(input: string): PathDecision {
    const norm = normalizeRepoPath(input);
    if (!norm.ok) return deny(norm.reasonCode, norm.message);
    const path = norm.path;
    if (this.isDenied(path)) return deny('PATH_DENIED', `${path} is denied by the contract`, path);
    if (!this.isWritable(path)) return deny('PATH_NOT_WRITABLE', `${path} is not in the writable scope`, path);

    // Walk every existing component: none may be a symlink, and the true on-disk case must match.
    const segments = path.split('/');
    let current = this.root;
    for (let i = 0; i < segments.length; i++) {
      const next = join(current, segments[i]!);
      let stat;
      try {
        stat = lstatSync(next);
      } catch {
        // Component does not exist yet: the rest of the path will be created inside `current`.
        return { allowed: true, path, absPath: join(this.root, ...segments), exists: false };
      }
      if (stat.isSymbolicLink()) return deny('PATH_SYMLINK', `${segments.slice(0, i + 1).join('/')} is a symbolic link; writes through symlinks are refused`, path);
      const real = realpathSync.native(next);
      const rel = this.relativeInside(real);
      if (rel === undefined) return deny('PATH_ESCAPES_WORKTREE', `${path} resolves outside the worktree`, path);
      if (rel !== segments.slice(0, i + 1).join('/')) {
        return deny('PATH_CASE_MISMATCH', `${path} differs in case from the file on disk (${rel})`, path);
      }
      const isLast = i === segments.length - 1;
      if (!isLast && !stat.isDirectory()) return deny('PATH_INVALID', `${segments.slice(0, i + 1).join('/')} is not a directory`, path);
      if (isLast && !stat.isFile()) return deny('PATH_INVALID', `${path} is not a regular file`, path);
      current = next;
    }
    return { allowed: true, path, absPath: join(this.root, ...segments), exists: true };
  }

  private relativeInside(realPath: string): string | undefined {
    const rel = relative(this.root, realPath);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
    return rel.split(sep).join('/');
  }
}
