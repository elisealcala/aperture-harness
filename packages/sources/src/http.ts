import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SourceError } from './types.ts';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export const defaultFetch: FetchLike = (url, init) => fetch(url, init);

const MAX_RESPONSE_CHARS = 2_000_000;

export async function requestJson<T>(fetchImpl: FetchLike, url: string, init: { method?: string; headers: Record<string, string>; body?: unknown; timeoutMs?: number }): Promise<{ status: number; data: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000);
  let response;
  try {
    response = await fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: { accept: 'application/json', ...init.headers, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    throw new SourceError(`request to ${new URL(url).host} failed: ${(err as Error).message}`, 'TRANSPORT');
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) throw new SourceError(`response from ${new URL(url).host} is too large`, 'INVALID_CONTENT');
  if (response.status === 401 || response.status === 403) throw new SourceError(`${new URL(url).host} rejected the credentials (HTTP ${response.status})`, 'AUTH');
  if (response.status === 404) throw new SourceError(`not found: ${url}`, 'NOT_FOUND');
  let data: T;
  try {
    data = (text ? JSON.parse(text) : null) as T;
  } catch {
    throw new SourceError(`invalid JSON from ${new URL(url).host} (HTTP ${response.status})`, 'INVALID_CONTENT');
  }
  if (!response.ok && response.status !== 422) throw new SourceError(`HTTP ${response.status} from ${new URL(url).host}`, 'TRANSPORT');
  return { status: response.status, data };
}

const execFileAsync = promisify(execFile);

/**
 * Resolves a GitHub token for the *harness* process only (never passed to the sandbox or model):
 * the configured env var first, then `gh auth token` when allowed.
 */
export async function resolveGitHubToken(env: NodeJS.ProcessEnv, options: { tokenEnv: string; useGhCli: boolean }): Promise<string | undefined> {
  const fromEnv = env[options.tokenEnv] ?? env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  if (!options.useGhCli) return undefined;
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 10_000, env: { PATH: env.PATH ?? '/usr/bin:/bin', HOME: env.HOME ?? '' } });
    const token = stdout.trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}
