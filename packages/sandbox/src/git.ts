import { execFileBounded, type ExecResult } from './exec.ts';

export class GitError extends Error {
  constructor(
    message: string,
    readonly result: ExecResult,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Environment for harness-owned git invocations: no prompts, no user/system config that could add
 * hooks, aliases, pagers or credential helpers, and repository hooks disabled per-invocation.
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: base.PATH ?? '/usr/bin:/bin',
    HOME: base.HOME,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
  };
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
    if (base[key]) env[key] = base[key];
  }
  return env;
}

const SAFE_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'protocol.file.allow=user'];

export interface GitOptions {
  input?: string;
  allowFailure?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export async function git(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<ExecResult> {
  const result = await execFileBounded('git', [...SAFE_FLAGS, ...args], {
    cwd,
    env: options.env ?? gitEnv(),
    timeoutMs: options.timeoutMs ?? 60_000,
    maxOutputBytes: options.maxOutputBytes ?? 8 * 1024 * 1024,
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
  if (!options.allowFailure && result.exitCode !== 0) {
    throw new GitError(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`, result);
  }
  return result;
}

export async function gitStdout(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<string> {
  return (await git(cwd, args, options)).stdout;
}
