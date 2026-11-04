import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TempDirs } from '../../../tests/helpers/tmp.ts';
import { normalizeRepoPath, PathPolicy, type PathDecision } from './path-policy.ts';

describe('normalizeRepoPath', () => {
  it.each([
    ['src/api/session.ts', 'src/api/session.ts'],
    ['./src/api/session.ts', 'src/api/session.ts'],
    ['src//api/./session.ts', 'src/api/session.ts'],
    ['src/api/', 'src/api'],
    ['.env', '.env'],
    ['src/.gitignore', 'src/.gitignore'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeRepoPath(input)).toEqual({ ok: true, path: expected });
  });

  it.each([
    ['', 'PATH_INVALID'],
    ['x'.repeat(513), 'PATH_INVALID'],
    ['.', 'PATH_INVALID'],
    ['./', 'PATH_INVALID'],
    ['src/\u0000evil', 'PATH_INVALID'],
    ['src/\nevil', 'PATH_INVALID'],
    ['src\\api\\session.ts', 'PATH_INVALID'],
    ['/etc/passwd', 'PATH_ABSOLUTE'],
    ['C:/Windows/win.ini', 'PATH_ABSOLUTE'],
    ['~/.ssh/id_rsa', 'PATH_ABSOLUTE'],
    ['../outside.txt', 'PATH_TRAVERSAL'],
    ['src/../package.json', 'PATH_TRAVERSAL'],
    ['src/api/../../..', 'PATH_TRAVERSAL'],
    ['.git/config', 'PATH_DENIED'],
    ['.git', 'PATH_DENIED'],
    ['src/.GIT/hooks/pre-commit', 'PATH_DENIED'],
    ['./.Git/HEAD', 'PATH_DENIED'],
  ])('rejects %j with %s', (input, reasonCode) => {
    expect(normalizeRepoPath(input)).toMatchObject({ ok: false, reasonCode });
  });
});

function reason(decision: PathDecision): string {
  return decision.allowed ? 'ALLOWED' : decision.reasonCode;
}

describe('PathPolicy', () => {
  const tmp = new TempDirs();
  let root: string;
  let outside: string;
  let policy: PathPolicy;
  let caseInsensitiveFs = false;

  beforeAll(() => {
    const base = tmp.make('aperture-policy-');
    root = join(base, 'worktree');
    outside = join(base, 'outside');
    mkdirSync(join(root, 'src', 'api'), { recursive: true });
    mkdirSync(join(root, 'src', 'secrets'), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    mkdirSync(outside, { recursive: true });

    writeFileSync(join(root, 'src', 'api', 'session.ts'), 'export {};\n');
    writeFileSync(join(root, 'src', 'api', 'helper.ts'), 'export {};\n');
    writeFileSync(join(root, 'src', 'secrets', 'key.ts'), 'export const KEY = 1;\n');
    writeFileSync(join(root, 'package.json'), '{}\n');
    writeFileSync(join(root, '.env'), 'TOKEN=1\n');
    writeFileSync(join(root, 'docs', 'notes.md'), '# notes\n');
    writeFileSync(join(outside, 'secret.txt'), 'outside the worktree\n');

    // Symlinked file whose apparent path is writable by glob (AT-04).
    symlinkSync('session.ts', join(root, 'src', 'api', 'link.ts'));
    // Symlinked parent directory: src/link -> src/api, so src/link/session.ts names a real file.
    symlinkSync('api', join(root, 'src', 'link'));
    // Symlink inside the readable scope pointing outside the worktree.
    symlinkSync(join(outside, 'secret.txt'), join(root, 'src', 'api', 'outside.ts'));
    // Symlinked directory pointing outside the worktree.
    symlinkSync(outside, join(root, 'src', 'escape'));
    // Symlinks inside the readable scope pointing at a denied file / a non-readable file.
    symlinkSync('../../package.json', join(root, 'src', 'api', 'pkg.json'));
    symlinkSync('../../.env', join(root, 'src', 'api', 'env.ts'));
    symlinkSync('../../docs/notes.md', join(root, 'src', 'api', 'notes.ts'));
    // A symlink inside the scope pointing to another readable file is fine for reads.
    symlinkSync('helper.ts', join(root, 'src', 'api', 'alias.ts'));

    caseInsensitiveFs = existsSync(join(root, 'SRC', 'API', 'SESSION.TS'));

    policy = new PathPolicy(root, {
      writable: [
        'src/api/session.ts',
        'src/api/new-file.ts',
        'src/api/new-dir/deep.ts',
        'src/api/link.ts',
        'src/link/session.ts',
        'src/escape/secret.txt',
        'src/api/Session.ts',
        'src/api',
        'src/api/session.ts/child.ts',
        'package.json',
      ],
      readable: ['src/**'],
      denied: ['package.json', '.env*', '**/secrets/**'],
    });
  });

  afterAll(() => tmp.cleanup());

  describe('checkWrite', () => {
    it('allows an existing writable file and reports its absolute path', () => {
      const decision = policy.checkWrite('src/api/session.ts');
      expect(decision).toEqual({ allowed: true, path: 'src/api/session.ts', absPath: join(policy.worktreeRoot, 'src', 'api', 'session.ts'), exists: true });
    });

    it('allows a writable file that does not exist yet, including in a new directory', () => {
      expect(policy.checkWrite('src/api/new-file.ts')).toMatchObject({ allowed: true, exists: false });
      expect(policy.checkWrite('./src/api/new-dir/deep.ts')).toMatchObject({ allowed: true, path: 'src/api/new-dir/deep.ts', exists: false });
    });

    it.each([
      ['../outside.txt', 'PATH_TRAVERSAL'],
      ['src/api/../../package.json', 'PATH_TRAVERSAL'],
      ['/etc/passwd', 'PATH_ABSOLUTE'],
      ['src\\api\\session.ts', 'PATH_INVALID'],
      ['.git/config', 'PATH_DENIED'],
      ['.git/hooks/post-checkout', 'PATH_DENIED'],
    ])('rejects %j with %s before touching the filesystem', (input, code) => {
      expect(reason(policy.checkWrite(input))).toBe(code);
    });

    it('lets deny win over an explicit writable entry', () => {
      expect(policy.checkWrite('package.json')).toMatchObject({ allowed: false, reasonCode: 'PATH_DENIED', path: 'package.json' });
      expect(policy.writable('package.json')).toBe(false);
    });

    it.each(['PACKAGE.JSON', 'Package.Json', '.ENV', '.Env.local', 'src/SECRETS/key.ts'])('matches denied globs case-insensitively: %j', (input) => {
      expect(reason(policy.checkWrite(input))).toBe('PATH_DENIED');
      expect(reason(policy.checkRead(input))).toBe('PATH_DENIED');
    });

    it('rejects files outside the writable scope', () => {
      expect(reason(policy.checkWrite('src/api/helper.ts'))).toBe('PATH_NOT_WRITABLE');
      expect(reason(policy.checkWrite('docs/notes.md'))).toBe('PATH_NOT_WRITABLE');
    });

    it('refuses to write through a symlinked file even when the glob matches (AT-04)', () => {
      expect(policy.checkWrite('src/api/link.ts')).toMatchObject({ allowed: false, reasonCode: 'PATH_SYMLINK', path: 'src/api/link.ts' });
    });

    it('refuses to write through a symlinked parent directory even when the glob matches (AT-04)', () => {
      const decision = policy.checkWrite('src/link/session.ts');
      expect(decision).toMatchObject({ allowed: false, reasonCode: 'PATH_SYMLINK' });
      expect(decision.allowed ? '' : decision.message).toMatch(/^src\/link is a symbolic link/);
    });

    it('refuses to write through a symlinked directory that leaves the worktree', () => {
      expect(reason(policy.checkWrite('src/escape/secret.txt'))).toBe('PATH_SYMLINK');
    });

    it('rejects a directory or a path below a regular file', () => {
      expect(reason(policy.checkWrite('src/api'))).toBe('PATH_INVALID');
      expect(reason(policy.checkWrite('src/api/session.ts/child.ts'))).toBe('PATH_INVALID');
    });

    it('rejects a case alias of an existing file on case-insensitive filesystems', ({ skip }) => {
      if (!caseInsensitiveFs) skip('filesystem is case-sensitive');
      // `src/api/Session.ts` is writable by glob, but on disk it is `session.ts`.
      expect(reason(policy.checkWrite('src/api/Session.ts'))).toBe('PATH_CASE_MISMATCH');
    });
  });

  describe('checkRead', () => {
    it('allows a readable file and resolves its real path', () => {
      expect(policy.checkRead('src/api/helper.ts')).toEqual({ allowed: true, path: 'src/api/helper.ts', absPath: join(policy.worktreeRoot, 'src', 'api', 'helper.ts'), exists: true });
    });

    it('treats writable paths as readable', () => {
      expect(policy.readable('src/api/session.ts')).toBe(true);
      expect(reason(policy.checkRead('src/api/session.ts'))).toBe('ALLOWED');
    });

    it('reports a readable but missing file as allowed with exists=false', () => {
      expect(policy.checkRead('src/api/missing.ts')).toMatchObject({ allowed: true, exists: false });
    });

    it('rejects files outside the readable scope', () => {
      expect(policy.checkRead('docs/notes.md')).toMatchObject({ allowed: false, reasonCode: 'PATH_NOT_READABLE' });
    });

    it('rejects denied files inside the readable scope', () => {
      expect(reason(policy.checkRead('src/secrets/key.ts'))).toBe('PATH_DENIED');
      expect(reason(policy.checkRead('package.json'))).toBe('PATH_DENIED');
    });

    it('rejects a symlink that resolves outside the worktree', () => {
      expect(policy.checkRead('src/api/outside.ts')).toMatchObject({ allowed: false, reasonCode: 'PATH_ESCAPES_WORKTREE', path: 'src/api/outside.ts' });
      expect(reason(policy.checkRead('src/escape/secret.txt'))).toBe('PATH_ESCAPES_WORKTREE');
    });

    it('rejects a readable-looking symlink whose target is denied', () => {
      expect(policy.checkRead('src/api/pkg.json')).toMatchObject({ allowed: false, reasonCode: 'PATH_DENIED' });
      expect(reason(policy.checkRead('src/api/env.ts'))).toBe('PATH_DENIED');
    });

    it('rejects a readable-looking symlink whose target is outside the readable scope', () => {
      expect(reason(policy.checkRead('src/api/notes.ts'))).toBe('PATH_NOT_READABLE');
    });

    it('allows a symlink whose target is itself readable, returning the target path', () => {
      expect(policy.checkRead('src/api/alias.ts')).toMatchObject({ allowed: true, path: 'src/api/alias.ts', absPath: join(policy.worktreeRoot, 'src', 'api', 'helper.ts') });
    });

    it.each([
      ['../outside/secret.txt', 'PATH_TRAVERSAL'],
      ['/etc/hosts', 'PATH_ABSOLUTE'],
      ['.git/HEAD', 'PATH_DENIED'],
    ])('rejects %j with %s', (input, code) => {
      expect(reason(policy.checkRead(input))).toBe(code);
    });
  });
});
