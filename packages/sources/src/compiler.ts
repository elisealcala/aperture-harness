import { compileGlobs, isGlobPattern, parseContract, repoPatternProblem, type ExecutionContract, type UserConfig } from '@aperture/contracts';
import type { NormalizedTask } from './types.ts';

/** Marker for fields the approver must fill in; contract analysis refuses approval while present. */
export const EDIT_ME = '__EDIT_ME__';

/** Conservative default deny list applied to every compiled contract. */
export const DEFAULT_DENIED: readonly string[] = [
  '.env*',
  '**/.env*',
  '**/secrets/**',
  '**/*.pem',
  '**/*.key',
  '.git*/**',
  '.github/workflows/**',
  'package.json',
  '**/package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  '**/requirements*.txt',
  '**/pyproject.toml',
  '**/poetry.lock',
  '**/go.mod',
  '**/go.sum',
  '**/Cargo.toml',
  '**/Cargo.lock',
  '**/Gemfile',
  '**/Gemfile.lock',
];

export interface RepoContext {
  trackedFiles: readonly string[];
  baselineRef: string;
}

export interface CompiledProposal {
  contract: ExecutionContract;
  notes: string[];
}

const SECTION_HEADING = /^(?:#{1,6}\s*|\*\*)?\s*(acceptance criteria|acceptance|requirements|definition of done|expected behaviou?r|success criteria)\s*:?\s*(?:\*\*)?\s*:?\s*$/i;
const FILES_HEADING = /^(?:#{1,6}\s*|\*\*)?\s*(expected files|files to (?:change|modify|edit|create)|files|affected files|changed files)\b.*$/i;
const HOSTED_WORDING = /\b(deployed|hosted|production|staging|browser|screenshots?|live (?:site|service|environment))\b/i;
const ANY_HEADING = /^(#{1,6}\s+\S|\*\*[^*]+\*\*\s*:?\s*$|[A-Z][\w ]{2,40}:\s*$)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/;
const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+(.+)$/;
const PATH_TOKEN = /`([^`\s]+)`|(?:^|[\s(])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,6})(?=$|[\s),.:;])/g;

function stripMarkup(body: string): string {
  // Hidden HTML comments are a common injection vector; they never contribute to a contract.
  return body.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n');
}

function cleanItem(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** Extracts acceptance criteria: a dedicated section's list items, else checkbox items. */
export function extractRequirements(body: string): string[] {
  const lines = stripMarkup(body).split('\n');
  const items: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (SECTION_HEADING.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (inSection && ANY_HEADING.test(line.trim()) && !LIST_ITEM.test(line)) {
      if (items.length > 0) break;
      inSection = false;
      continue;
    }
    if (inSection) {
      const m = LIST_ITEM.exec(line);
      if (m) items.push(cleanItem(m[1]!));
    }
  }
  if (items.length === 0) {
    for (const line of lines) {
      const m = CHECKBOX.exec(line);
      if (m) items.push(cleanItem(m[1]!));
    }
  }
  return [...new Set(items.filter((i) => i.length > 0))].slice(0, 20);
}

/** List items under the first heading matching `heading`, until the next heading. */
export function sectionItems(body: string, heading: RegExp): string[] {
  const items: string[] = [];
  let inSection = false;
  for (const line of stripMarkup(body).split('\n')) {
    const trimmed = line.trim();
    if (!inSection && heading.test(trimmed) && !LIST_ITEM.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && ANY_HEADING.test(trimmed) && !LIST_ITEM.test(line)) break;
    if (inSection) {
      const m = LIST_ITEM.exec(line);
      if (m) items.push(m[1]!.trim());
    }
  }
  return items;
}

/**
 * Paths listed under an "Expected files" (or similar) section. They may not exist yet: tickets
 * often name the new test or evidence file to create. Globs and invalid paths are ignored.
 */
export function extractExpectedFiles(body: string): string[] {
  const found = new Set<string>();
  for (const item of sectionItems(body, FILES_HEADING)) {
    for (const match of item.matchAll(/`([^`\s]+)`/g)) {
      const path = match[1]!.replace(/^\.\//, '');
      if (path.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(path)) {
        if (!repoPatternProblem(path) && !isGlobPattern(path)) found.add(path);
      }
    }
  }
  return [...found];
}

/** Repository paths mentioned in text that exist at the baseline. */
export function extractMentionedPaths(text: string, trackedFiles: readonly string[]): string[] {
  const tracked = new Set(trackedFiles);
  const found = new Set<string>();
  for (const match of stripMarkup(text).matchAll(PATH_TOKEN)) {
    const raw = (match[1] ?? match[2] ?? '').replace(/^\.\//, '').replace(/[),.:;]+$/, '');
    if (tracked.has(raw)) found.add(raw);
  }
  return [...found];
}

function siblingTests(path: string, tracked: ReadonlySet<string>): string[] {
  const m = /^(.*)\.([A-Za-z0-9]+)$/.exec(path);
  if (!m || /\.(test|spec)$/.test(m[1]!)) return [];
  return [`${m[1]}.test.${m[2]}`, `${m[1]}.spec.${m[2]}`].filter((p) => tracked.has(p));
}

/**
 * Deterministic ticket → proposed contract compiler (§6). It never invents behavior: when the
 * ticket lacks acceptance criteria or identifiable files, it leaves `__EDIT_ME__` placeholders that
 * block approval until a person fills them in (NEEDS_CONTRACT_REVIEW, AT-05). Paths the ticket
 * mentions that the deny list covers are dropped and reported (AT-15).
 */
export function compileContract(task: NormalizedTask, config: UserConfig, repo: RepoContext): CompiledProposal {
  const notes: string[] = ['Compiled deterministically from untrusted ticket text; review every field before approving.'];
  const tracked = new Set(repo.trackedFiles);
  const denied = compileGlobs(DEFAULT_DENIED, { nocase: true });

  let requirementTexts = extractRequirements(task.body);
  if (requirementTexts.length === 0) {
    notes.push('NO_ACCEPTANCE_CRITERIA: the ticket has no acceptance criteria; write the requirements yourself (or ask the ticket author) before approving.');
    requirementTexts = [`${EDIT_ME}: state the acceptance criteria for "${task.title.slice(0, 200)}"`];
  }

  const mentioned = extractMentionedPaths(`${task.title}\n${task.body}`, repo.trackedFiles);
  const expected = extractExpectedFiles(task.body);
  const droppedDenied = [...new Set([...mentioned, ...expected])].filter((p) => denied(p));
  if (droppedDenied.length > 0) notes.push(`FILTERED_DENIED_PATHS: the ticket mentions ${droppedDenied.join(', ')}, which the default deny list protects; they were not made writable.`);
  const writable = new Set<string>();
  const readOnlyMentions: string[] = [];
  if (expected.length > 0) {
    // An explicit file list defines the writable scope; other mentions are reading material only.
    for (const p of expected.filter((e) => !denied(e))) writable.add(p);
    const created = expected.filter((p) => !denied(p) && !tracked.has(p));
    if (created.length > 0) notes.push(`NEW_FILES: ${created.join(', ')} do not exist yet and will be created; confirm the locations.`);
    for (const p of mentioned.filter((m) => !denied(m) && !writable.has(m))) readOnlyMentions.push(p);
  } else {
    for (const p of mentioned.filter((m) => !denied(m))) {
      writable.add(p);
      for (const t of siblingTests(p, tracked)) writable.add(t);
    }
  }
  if (writable.size === 0) {
    notes.push('NO_FILES_IDENTIFIED: no existing repository files were named in the ticket; list the writable files explicitly.');
    writable.add(EDIT_ME);
  }
  const readable = [...new Set([...[...writable].filter((p) => p !== EDIT_ME && p.includes('/')).map((p) => `${p.slice(0, p.lastIndexOf('/'))}/**`), ...readOnlyMentions])];
  if (HOSTED_WORDING.test(`${task.title}\n${task.body}`)) {
    notes.push('HOSTED_VERIFICATION: the ticket refers to deployed/hosted/browser behavior. Add permissions.network (allowlisted hosts) and hosted check commands before approving, or those requirements will stay UNVERIFIED.');
  }

  const checks = Object.keys(config.commands).map((id) => ({ id, commandId: id, required: true }));
  if (checks.length === 0) notes.push('NO_CHECKS: no commands are configured (config.commands); add checks or every requirement will stay UNVERIFIED.');

  const source =
    task.sourceType === 'github'
      ? { type: 'github' as const, repository: task.repository!, issueNumber: Number(task.taskKey.replace(/^GH-/, '')), revision: task.revision }
      : task.sourceType === 'linear'
        ? { type: 'linear' as const, issueId: task.taskKey, ...(task.repository ? { repository: task.repository } : {}), revision: task.revision }
        : { type: 'local' as const };
  if (task.sourceType === 'linear' && !task.repository) notes.push('NO_REPOSITORY: this Linear team has no GitHub repository mapping (config.linear.teamRepositories); pull requests are disabled until one is associated.');

  const baselineRef = (task.repository ? config.repositories[task.repository]?.baseBranch : undefined) ?? repo.baselineRef;
  const contract = parseContract({
    apiVersion: 'aperture.dev/v1',
    kind: 'ExecutionContract',
    metadata: { id: task.taskKey.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64), source, baselineRef, title: task.title.slice(0, 500) || EDIT_ME },
    spec: {
      goal: task.title.slice(0, 4000) || EDIT_ME,
      requirements: requirementTexts.map((text, i) => ({ id: `R${i + 1}`, text })),
      scope: { writable: [...writable], readable, denied: [...DEFAULT_DENIED] },
      checks,
      limits: {
        maxModelTurns: config.limits.maxModelTurns,
        maxPatchAttempts: config.limits.maxPatchAttempts,
        maxCostUsd: config.limits.maxCostPerRunUsd,
        prBudgetUsd: config.limits.maxPrDraftCostUsd,
      },
      models: { implement: config.models.implementation, prDraft: config.models.prDraft },
      cache: { enabled: config.cache.enabled, ttl: config.cache.ttl },
    },
  });
  return { contract, notes };
}
