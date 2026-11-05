import { createStyle, shouldColor, type Style } from './render/style.ts';

function style(): Style {
  return createStyle(shouldColor());
}

function section(s: Style, title: string, rows: ReadonlyArray<readonly [string, string]>): string {
  const width = Math.max(...rows.map(([left]) => left.length));
  return [`${s('bold', title)}`, ...rows.map(([left, right]) => `  ${s('cyan', left.padEnd(width))}  ${s('gray', right)}`)].join('\n');
}

/** Extra guidance appended to `aperture --help`. */
export function mainHelpText(): string {
  const s = style();
  return [
    '',
    section(s, 'Typical workflow', [
      ['git switch -c my-branch', '1. in the target repo: a clean branch for the task (in-place default)'],
      ['aperture run github:org/repo#142 --repo ~/code/repo', '2. ingest → approve the contract → model implements → verification'],
      ['aperture answer <run> <question> "..."', '   answer a blocking question (or answer it in the prompt), then `resume`'],
      ['aperture review <run>', '3. evidence + diff; [a]ccept locally, [p]R, [r]eject'],
      ['aperture pr draft <run> && aperture pr create <run>', '4. Haiku drafts the PR; you approve publishing'],
    ]),
    '',
    section(s, 'Task references', [
      ['github:owner/repo#N', 'GitHub issue (also owner/repo#N or the issue URL)'],
      ['linear:ENG-123', 'Linear issue (set LINEAR_API_KEY)'],
      ['./task.yaml', 'local ExecutionContract (preapproved with --no-interactive)'],
    ]),
    '',
    section(s, 'Inspect', [
      ['aperture', 'run browser (same as `aperture ui`)'],
      ['aperture status [run]', 'list runs, or one run in detail'],
      ['aperture attach <run>', 'live six-panel view of one run'],
      ['aperture logs <run> -f', 'event log (text or --format jsonl)'],
      ['aperture diff <run> · usage <run>', 'colored diff · token/cache/cost ledger'],
      ['aperture cancel <run> --reason "..."', 'dismiss a run (final; your files are not touched)'],
    ]),
    '',
    section(s, 'Run browser keys', [
      ['↑↓ / j k · g G', 'move · first/last'],
      ['/ · Esc', 'filter (all words must match) · clear'],
      ['Enter · q / Esc', 'open run · back to the list'],
      ['1-6 · f · v · m', 'panels · activity filter · verbose · model text (inside a run)'],
    ]),
    '',
    section(s, 'Setup', [
      ['cp .env.example .env', 'ANTHROPIC_API_KEY (GITHUB_TOKEN / gh auth, LINEAR_API_KEY optional)'],
      ['aperture init', 'writes ~/.config/aperture/config.yaml and checks keys and sandbox'],
      ['config: commands, repositories', 'trusted check commands; local clones for GitHub repos'],
    ]),
    '',
    section(s, 'Exit codes', [
      ['0', 'ready for review / completed / PR created'],
      ['1', 'error'],
      ['2', 'blocked, failed or canceled'],
      ['3', 'waiting for a decision (contract approval or a question)'],
    ]),
    '',
    `${s('gray', 'Details for any command:')} aperture <command> --help    ${s('gray', 'Docs:')} README.md, docs/system-design.md`,
  ].join('\n');
}

/** Per-command examples appended to `aperture <command> --help`. */
export const COMMAND_EXAMPLES: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  run: [
    ['aperture run github:org/repo#142 --repo ~/code/repo', 'interactive: review the contract, then execute'],
    ['aperture run linear:ENG-123 --budget 0.75 --tui', 'full-screen view with a larger budget'],
    ['aperture run ./task.yaml --no-interactive --answers answers.yaml', 'unattended; questions use preauthorized answers or block'],
    ['aperture run ./task.yaml --script steps.yaml --reduced-security', 'offline dry run that replays tool calls (no model cost)'],
  ],
  review: [
    ['aperture review <run>', 'interactive: [d]iff, [a]ccept locally, [p]R, [r]eject'],
    ['aperture review <run> --accept-local --acknowledge-unverified', 'non-interactive acceptance incl. unverified requirements'],
  ],
  resume: [
    ['aperture resume <run>', 'continue after Ctrl-C, a crash, or an answered question'],
    ['aperture resume <run> --script steps.yaml', 'continue a run that was started with --script'],
  ],
  answer: [
    ['aperture answer <run> <question> "Reject with 400"', 'free-form answer'],
    ['aperture answer <run> <question> --choice 1', 'pick an offered choice'],
    ['aperture answer <run> <question> --approve --rationale "needed for types"', 'approve a scope change (new contract revision)'],
  ],
  cancel: [
    ['aperture cancel <run> --reason "superseded"', 'final; in-place work on your branch is left as is'],
    ['aperture cancel <run> --cleanup', 'also remove the worktree (worktree mode only)'],
  ],
  ui: [
    ['aperture', 'open the run browser'],
    ['aperture ui <run>', 'open one run directly; q returns to the list'],
  ],
  logs: [
    ['aperture logs <run> --follow', 'stream new events until the run finishes'],
    ['aperture logs <run> --filter tool.rejected,network', 'only denied actions and egress'],
  ],
  draft: [
    ['aperture pr draft <run>', 'Haiku drafts title/body from verified evidence'],
    ['aperture pr draft <run> --repository org/repo', 'associate a repo (e.g. unmapped Linear team)'],
  ],
  create: [
    ['aperture pr create <run>', 'shows branch, base, files, title/body and asks to publish'],
    ['aperture pr create <run> --yes', 'approve publishing without the prompt'],
  ],
};

export function commandHelpText(name: string): string {
  if (!Object.hasOwn(COMMAND_EXAMPLES, name)) return '';
  const rows = COMMAND_EXAMPLES[name]!;
  return `\n${section(style(), 'Examples', rows)}`;
}
