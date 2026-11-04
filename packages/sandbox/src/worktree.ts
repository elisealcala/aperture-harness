import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { git, gitStdout } from './git.ts';

export interface WorktreeInfo {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baselineRef: string;
  baselineSha: string;
  baselineTreeSha: string;
}

export interface ChangedPath {
  status: string; // A, M, D, R100, T ...
  path: string;
  oldPath?: string;
}

export interface NumstatEntry {
  path: string;
  added: number | null; // null => binary
  deleted: number | null;
}

/**
 * Disposable git worktrees, one per run. The user's checkout is never touched: the worktree is
 * created detached from the pinned baseline commit on a dedicated `aperture/<run>` branch.
 */
export class WorktreeManager {
  async resolveRepoRoot(path: string): Promise<string> {
    const root = (await gitStdout(path, ['rev-parse', '--show-toplevel'])).trim();
    return realpathSync(root);
  }

  async resolveCommit(repoPath: string, ref: string): Promise<string> {
    if (ref.startsWith('-')) throw new Error(`invalid baseline ref ${ref}`);
    return (await gitStdout(repoPath, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
  }

  async create(options: { repoPath: string; baselineRef: string; worktreePath: string; branch: string }): Promise<WorktreeInfo> {
    const repoPath = await this.resolveRepoRoot(options.repoPath);
    const baselineSha = await this.resolveCommit(repoPath, options.baselineRef);
    const baselineTreeSha = (await gitStdout(repoPath, ['rev-parse', `${baselineSha}^{tree}`])).trim();
    if (existsSync(options.worktreePath)) throw new Error(`worktree path already exists: ${options.worktreePath}`);
    mkdirSync(dirname(options.worktreePath), { recursive: true, mode: 0o700 });
    await git(repoPath, ['worktree', 'add', '--no-track', '-b', options.branch, options.worktreePath, baselineSha]);
    return {
      repoPath,
      worktreePath: realpathSync(options.worktreePath),
      branch: options.branch,
      baselineRef: options.baselineRef,
      baselineSha,
      baselineTreeSha,
    };
  }

  async remove(repoPath: string, worktreePath: string, branch?: string): Promise<void> {
    await git(repoPath, ['worktree', 'remove', '--force', worktreePath], { allowFailure: true });
    if (branch) await git(repoPath, ['branch', '-D', branch], { allowFailure: true });
  }

  async headSha(worktreePath: string): Promise<string> {
    return (await gitStdout(worktreePath, ['rev-parse', 'HEAD'])).trim();
  }

  /** Blob ids of tracked files at the baseline, used as the hash snapshot (§3 step 4). */
  async snapshotHashes(worktreePath: string, baselineSha: string): Promise<Record<string, string>> {
    const out = await gitStdout(worktreePath, ['ls-tree', '-r', '-z', '--full-tree', baselineSha]);
    const hashes: Record<string, string> = {};
    for (const entry of out.split('\0')) {
      if (!entry) continue;
      const tab = entry.indexOf('\t');
      const [, , sha] = entry.slice(0, tab).split(' ');
      hashes[entry.slice(tab + 1)] = sha!;
    }
    return hashes;
  }

  /** Full binary-safe diff of the worktree (tracked + intent-to-add files) against the baseline. */
  async diff(worktreePath: string, baselineSha: string, paths: readonly string[] = []): Promise<string> {
    return gitStdout(worktreePath, ['diff', '--binary', '--no-color', '--no-ext-diff', '--no-renames', baselineSha, '--', ...paths]);
  }

  async nameStatus(worktreePath: string, baselineSha: string): Promise<ChangedPath[]> {
    const out = await gitStdout(worktreePath, ['diff', '--name-status', '-z', '--no-renames', baselineSha]);
    const parts = out.split('\0').filter((p) => p.length > 0);
    const changes: ChangedPath[] = [];
    for (let i = 0; i < parts.length; ) {
      const status = parts[i++]!;
      if (status.startsWith('R') || status.startsWith('C')) {
        const oldPath = parts[i++]!;
        changes.push({ status, path: parts[i++]!, oldPath });
      } else {
        changes.push({ status, path: parts[i++]! });
      }
    }
    return changes;
  }

  async numstat(worktreePath: string, baselineSha: string): Promise<NumstatEntry[]> {
    const out = await gitStdout(worktreePath, ['diff', '--numstat', '-z', '--no-renames', baselineSha]);
    return out
      .split('\0')
      .filter((l) => l.length > 0)
      .map((line) => {
        const [added, deleted, ...rest] = line.split('\t');
        return { path: rest.join('\t'), added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted) };
      });
  }

  /** Mode changes, symlinks, and similar header-level changes (`git diff --summary`). */
  async summary(worktreePath: string, baselineSha: string): Promise<string[]> {
    const out = await gitStdout(worktreePath, ['diff', '--summary', '--no-renames', baselineSha]);
    return out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  }

  async untracked(worktreePath: string): Promise<string[]> {
    const out = await gitStdout(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']);
    return out.split('\0').filter((p) => p.length > 0);
  }

  /** Files whose mode in the worktree index is a symlink (120000) or gitlink (160000). */
  async specialModes(worktreePath: string): Promise<Array<{ path: string; mode: string }>> {
    const out = await gitStdout(worktreePath, ['ls-files', '-s', '-z']);
    const result: Array<{ path: string; mode: string }> = [];
    for (const entry of out.split('\0')) {
      if (!entry) continue;
      const tab = entry.indexOf('\t');
      const mode = entry.slice(0, tab).split(' ')[0]!;
      if (mode === '120000' || mode === '160000') result.push({ path: entry.slice(tab + 1), mode });
    }
    return result;
  }
}
