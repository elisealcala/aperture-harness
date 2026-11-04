import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFileBounded, type ExecResult } from './exec.ts';

export type IsolationMode = 'macos-seatbelt' | 'linux-bwrap' | 'reduced';

export class IsolationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolationUnavailableError';
  }
}

export interface SandboxPolicy {
  /** The only tree the process may write (plus `tmpDir`). */
  worktreePath: string;
  /** Per-run scratch directory; becomes HOME and TMPDIR inside the sandbox. */
  tmpDir: string;
  /** Directories whose contents must not be readable (aperture storage, credentials). */
  hiddenPaths: readonly string[];
}

export interface SandboxCommand {
  exec: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes?: number;
}

export interface SandboxResult extends ExecResult {
  isolation: IsolationMode;
}

const SEATBELT = '/usr/bin/sandbox-exec';

/** Sensitive per-user locations hidden from sandboxed commands when they exist. */
export function defaultHiddenPaths(home: string = homedir()): string[] {
  return [
    '.ssh',
    '.aws',
    '.azure',
    '.gnupg',
    '.netrc',
    '.npmrc',
    '.pypirc',
    '.docker',
    '.kube',
    '.config/gh',
    '.config/gcloud',
    '.config/aperture',
    '.config/anthropic',
    '.git-credentials',
    'Library/Keychains',
  ].map((p) => join(home, p));
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function detectIsolation(env: NodeJS.ProcessEnv = process.env): IsolationMode | null {
  if (platform() === 'darwin' && existsSync(SEATBELT)) return 'macos-seatbelt';
  if (platform() === 'linux' && findOnPath('bwrap', env)) return 'linux-bwrap';
  return null;
}

/**
 * Chooses the isolation mode. `required` fails closed when no OS sandbox exists; `reduced` is the
 * explicit, user-selected degraded mode (§9 Isolation).
 */
export function resolveIsolation(requested: 'required' | 'reduced', env: NodeJS.ProcessEnv = process.env): IsolationMode {
  if (requested === 'reduced') return 'reduced';
  const mode = detectIsolation(env);
  if (!mode) {
    throw new IsolationUnavailableError(
      'no OS sandbox is available (need macOS sandbox-exec or Linux bubblewrap). Re-run with --reduced-security to accept a reduced-isolation local mode.',
    );
  }
  return mode;
}

/** Minimal environment: no inherited tokens, HOME/TMPDIR pointed at the run scratch directory. */
export function sandboxEnv(policy: SandboxPolicy, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: base.PATH ?? '/usr/bin:/bin',
    HOME: policy.tmpDir,
    TMPDIR: policy.tmpDir,
    LANG: base.LANG ?? 'en_US.UTF-8',
    CI: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    npm_config_offline: 'true',
    npm_config_ignore_scripts: 'true',
    NODE_OPTIONS: '',
  };
}

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Seatbelt profile: no IP networking, writes confined to worktree + tmp, secrets unreadable. */
export function seatbeltProfile(policy: SandboxPolicy): string {
  const writable = [policy.worktreePath, policy.tmpDir].map((p) => `(subpath ${sbplString(p)})`).join(' ');
  const hidden = policy.hiddenPaths.map((p) => `(subpath ${sbplString(p)})`).join(' ');
  return [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound (remote ip))',
    '(deny network-inbound (local ip))',
    '(deny network-bind (local ip))',
    '(deny file-write*)',
    `(allow file-write* ${writable} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/"))`,
    hidden ? `(deny file-read* file-write* ${hidden})` : '',
    // Later rules win: re-allow the worktree and scratch dir even if they sit under a hidden root.
    `(allow file-read* file-write* ${writable})`,
    '',
  ].join('\n');
}

export function bwrapArgs(policy: SandboxPolicy, command: SandboxCommand): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  for (const hidden of policy.hiddenPaths) {
    if (existsSync(hidden)) args.push('--tmpfs', hidden);
  }
  args.push('--bind', policy.worktreePath, policy.worktreePath, '--bind', policy.tmpDir, policy.tmpDir);
  args.push('--unshare-net', '--unshare-pid', '--die-with-parent', '--new-session', '--chdir', policy.worktreePath, '--', command.exec, ...command.args);
  return args;
}

/**
 * Runs approved check commands. The model never reaches this class directly: the gateway maps a
 * contract `checkId` to a fixed `{exec, args}` first.
 */
export class SandboxRunner {
  constructor(
    readonly mode: IsolationMode,
    private readonly policy: SandboxPolicy,
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
  ) {
    mkdirSync(policy.tmpDir, { recursive: true, mode: 0o700 });
    this.policy = { ...policy, worktreePath: realpathSync(policy.worktreePath), tmpDir: realpathSync(policy.tmpDir) };
  }

  get effectivePolicy(): SandboxPolicy {
    return this.policy;
  }

  async run(command: SandboxCommand): Promise<SandboxResult> {
    const env = sandboxEnv(this.policy, this.baseEnv);
    const common = { cwd: this.policy.worktreePath, env, timeoutMs: command.timeoutMs, maxOutputBytes: command.maxOutputBytes ?? 512 * 1024 };
    let result: ExecResult;
    switch (this.mode) {
      case 'macos-seatbelt': {
        const profilePath = join(this.policy.tmpDir, '.aperture-sandbox.sb');
        writeFileSync(profilePath, seatbeltProfile(this.policy), { mode: 0o600 });
        result = await execFileBounded(SEATBELT, ['-f', profilePath, command.exec, ...command.args], common);
        break;
      }
      case 'linux-bwrap':
        result = await execFileBounded('bwrap', bwrapArgs(this.policy, command), common);
        break;
      case 'reduced':
        result = await execFileBounded(command.exec, command.args, common);
        break;
    }
    return { ...result, isolation: this.mode };
  }
}
