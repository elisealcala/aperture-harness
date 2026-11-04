import { resolve } from 'node:path';
import { canonicalJson, sha256Hex } from '@aperture/contracts';
import { SourceError, type NormalizedTask, type SourceRef } from './types.ts';

const GITHUB_REF = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)\/?$/;
const LINEAR_REF = /^linear:([A-Za-z][A-Za-z0-9]*-\d+)$/;
const LINEAR_URL = /^https:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/.*)?$/;

/** Parses `github:org/repo#142`, `org/repo#142`, GitHub/Linear issue URLs, `linear:ENG-123`, or a path. */
export function parseSourceRef(input: string, cwd: string = process.cwd()): SourceRef {
  const ref = input.trim();
  const gh = GITHUB_REF.exec(ref) ?? GITHUB_URL.exec(ref);
  if (gh) return { type: 'github', owner: gh[1]!, repo: gh[2]!, number: Number(gh[3]) };
  const lin = LINEAR_REF.exec(ref) ?? LINEAR_URL.exec(ref);
  if (lin) return { type: 'linear', identifier: lin[1]!.toUpperCase() };
  if (ref.startsWith('local:')) return { type: 'local', path: resolve(cwd, ref.slice('local:'.length)) };
  if (/\.(ya?ml|json)$/i.test(ref)) return { type: 'local', path: resolve(cwd, ref) };
  throw new SourceError(`unrecognized task reference ${JSON.stringify(input)}; expected github:owner/repo#N, linear:KEY-N, or a .yaml contract path`, 'INVALID_REF');
}

export function formatSourceRef(ref: SourceRef): string {
  switch (ref.type) {
    case 'github':
      return `github:${ref.owner}/${ref.repo}#${ref.number}`;
    case 'linear':
      return `linear:${ref.identifier}`;
    case 'local':
      return `local:${ref.path}`;
  }
}

/** Immutable snapshot of the normalized task, pinned for drift detection (§14). */
export function snapshotTask(task: NormalizedTask): { json: string; sha256: string } {
  const json = canonicalJson(task);
  return { json, sha256: sha256Hex(json) };
}

/** Content fingerprint that ignores fetch time, used to detect source drift mid-run. */
export function taskContentDigest(task: NormalizedTask): string {
  return sha256Hex(canonicalJson({ title: task.title, body: task.body, labels: [...task.labels].sort(), comments: task.comments }));
}
