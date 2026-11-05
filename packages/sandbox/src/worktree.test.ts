import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixtureRepo, gitSync, setOriginHead, switchToUserBranch, type FixtureRepo } from '../../../tests/helpers/repo.ts';
import { TempDirs } from '../../../tests/helpers/tmp.ts';
import { WorktreeManager } from './worktree.ts';

const tmp = new TempDirs();
const worktrees = new WorktreeManager();
let repo: FixtureRepo;

beforeEach(() => {
  repo = createFixtureRepo(tmp.make('aperture-wt-'));
});
afterEach(() => tmp.cleanup());

describe('WorktreeManager.currentBranch', () => {
  it('returns the checked-out branch', async () => {
    expect(await worktrees.currentBranch(repo.path)).toBe('main');
    switchToUserBranch(repo.path, 'feature/x');
    expect(await worktrees.currentBranch(repo.path)).toBe('feature/x');
  });

  it('returns null for a detached HEAD', async () => {
    gitSync(repo.path, ['switch', '-q', '--detach', 'HEAD']);
    expect(await worktrees.currentBranch(repo.path)).toBeNull();
  });
});

describe('WorktreeManager.uncommittedPaths', () => {
  it('is empty for a clean checkout', async () => {
    expect(await worktrees.uncommittedPaths(repo.path)).toEqual([]);
  });

  it('lists unstaged, staged and untracked (nested) paths', async () => {
    writeFileSync(join(repo.path, 'README.md'), 'changed\n');
    writeFileSync(join(repo.path, 'staged.txt'), 'new\n');
    gitSync(repo.path, ['add', 'staged.txt']);
    mkdirSync(join(repo.path, 'deep/er'), { recursive: true });
    writeFileSync(join(repo.path, 'deep/er/untracked.ts'), 'x\n');
    expect((await worktrees.uncommittedPaths(repo.path)).sort()).toEqual(['README.md', 'deep/er/untracked.ts', 'staged.txt']);
  });

  it('lists deletions and keeps paths with spaces intact', async () => {
    gitSync(repo.path, ['rm', '-q', 'README.md']);
    writeFileSync(join(repo.path, 'with space.md'), 'x\n');
    expect((await worktrees.uncommittedPaths(repo.path)).sort()).toEqual(['README.md', 'with space.md']);
  });

  it('ignores git-ignored files (e.g. installed dependencies)', async () => {
    writeFileSync(join(repo.path, '.gitignore'), 'node_modules/\n');
    gitSync(repo.path, ['add', '.gitignore']);
    gitSync(repo.path, ['commit', '-q', '-m', 'ignore deps']);
    mkdirSync(join(repo.path, 'node_modules/dep'), { recursive: true });
    writeFileSync(join(repo.path, 'node_modules/dep/index.js'), 'x\n');
    expect(await worktrees.uncommittedPaths(repo.path)).toEqual([]);
  });

  // `git status --porcelain=v1 -z` emits a rename as "R  <new>\0<old>\0": the bare <old> field has
  // no status prefix and must be reported verbatim alongside <new>.
  it('reports both sides of a staged rename verbatim', async () => {
    gitSync(repo.path, ['mv', 'src/api/session.ts', 'src/api/renamed.ts']);
    expect((await worktrees.uncommittedPaths(repo.path)).sort()).toEqual(['src/api/renamed.ts', 'src/api/session.ts']);
  });

  it('keeps entries after a rename aligned (short original names are not skipped as prefixes)', async () => {
    writeFileSync(join(repo.path, 'a'), 'short name\n');
    gitSync(repo.path, ['add', 'a']);
    gitSync(repo.path, ['commit', '-q', '-m', 'add a']);
    gitSync(repo.path, ['mv', 'a', 'b']);
    writeFileSync(join(repo.path, 'README.md'), 'changed\n');
    expect((await worktrees.uncommittedPaths(repo.path)).sort()).toEqual(['README.md', 'a', 'b']);
  });
});

describe('WorktreeManager.remoteDefaultBranch', () => {
  it('is null without origin/HEAD', async () => {
    expect(await worktrees.remoteDefaultBranch(repo.path)).toBeNull();
    gitSync(repo.path, ['remote', 'add', 'origin', 'https://github.com/org/repo.git']);
    expect(await worktrees.remoteDefaultBranch(repo.path)).toBeNull();
  });

  it('strips the origin/ prefix from origin/HEAD', async () => {
    setOriginHead(repo.path, 'main');
    expect(await worktrees.remoteDefaultBranch(repo.path)).toBe('main');
    gitSync(repo.path, ['branch', 'trunk']);
    setOriginHead(repo.path, 'trunk');
    expect(await worktrees.remoteDefaultBranch(repo.path)).toBe('trunk');
  });
});
