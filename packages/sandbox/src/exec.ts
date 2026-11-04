import { spawn } from 'node:child_process';

export interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Bytes of stdout/stderr retained (head + tail). */
  maxOutputBytes?: number;
  input?: string;
}

export interface ExecResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  /** True when output exceeded `maxOutputBytes` and the middle was elided. */
  truncated: boolean;
}

class BoundedBuffer {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    const half = Math.floor(this.limit / 2);
    if (this.headBytes < half) {
      const take = chunk.subarray(0, half - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      chunk = chunk.subarray(take.length);
    }
    if (chunk.length === 0) return;
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes > half && this.tail.length > 0) {
      this.truncated = true;
      const first = this.tail[0]!;
      const excess = this.tailBytes - half;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
      }
    }
  }

  toString(): string {
    const head = Buffer.concat(this.head).toString('utf8');
    const tail = Buffer.concat(this.tail).toString('utf8');
    return this.truncated ? `${head}\n…[output truncated]…\n${tail}` : head + tail;
  }
}

/**
 * Spawns an executable with an argument array — never through a shell — in its own process group
 * so a timeout kills every descendant.
 */
export function execFileBounded(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
  const started = Date.now();
  const limit = options.maxOutputBytes ?? 256 * 1024;
  return new Promise((resolvePromise) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      shell: false,
    });
    const stdout = new BoundedBuffer(limit);
    const stderr = new BoundedBuffer(limit);
    let timedOut = false;
    let settled = false;

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    };

    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            killGroup('SIGTERM');
            setTimeout(() => killGroup('SIGKILL'), 2000).unref();
          }, options.timeoutMs)
        : undefined;

    child.stdout.on('data', (c: Buffer) => stdout.push(c));
    child.stderr.on('data', (c: Buffer) => stderr.push(c));
    child.stdin.on('error', () => undefined);
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, errorText?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({
        exitCode,
        signal,
        stdout: stdout.toString(),
        stderr: errorText ? `${stderr.toString()}${errorText}` : stderr.toString(),
        timedOut,
        durationMs: Date.now() - started,
        truncated: stdout.truncated || stderr.truncated,
      });
    };

    child.on('error', (err) => finish(127, null, `spawn failed: ${err.message}`));
    child.on('close', (code, signal) => finish(code, signal));
  });
}
