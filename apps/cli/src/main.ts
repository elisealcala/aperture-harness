import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { envFileCandidates, loadEnvFiles } from './env-file.ts';
import type { GlobalOptions } from './context.ts';
import { initCommand } from './commands/init.ts';
import { diffCommand, logsCommand, statusCommand, uiCommand } from './commands/inspect.ts';
import { answerCommand, attachCommand, cancelCommand, resumeCommand, reviewCommand, usageCommand, type AnswerOptions, type ResumeOptions, type ReviewOptions } from './commands/lifecycle.ts';
import { prCreateCommand, prDraftCommand } from './commands/pr.ts';
import { runCommand, type RunCommandOptions } from './commands/run.ts';

/** Root of the harness checkout (apps/cli/src → ../../..). */
export const HARNESS_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export function buildProgram(setExit: (code: number) => void): Command {
  const program = new Command();
  program
    .name('aperture')
    .description('Budget-controlled, contract-driven coding execution harness')
    .option('--config <path>', 'config file (default: ~/.config/aperture/config.yaml or $APERTURE_CONFIG)')
    .option('--home <dir>', 'storage directory (default: config storage.directory or $APERTURE_HOME)')
    .option('--env-file <path>', 'load KEY=value secrets from this file (default: <harness>/.env, then ~/.config/aperture/.env)')
    .showHelpAfterError()
    .exitOverride();

  const globals = (): GlobalOptions => program.opts<GlobalOptions>();
  // Load env files before any command opens the harness, so keys and redaction see them.
  program.hook('preAction', () => {
    const explicit = program.opts<{ envFile?: string }>().envFile;
    const paths = envFileCandidates({ harnessRoot: HARNESS_ROOT, ...(explicit ? { explicit } : {}) });
    for (const result of loadEnvFiles(paths, process.env, { required: Boolean(explicit ?? process.env.APERTURE_ENV_FILE) })) {
      for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
    }
    // Record an explicit file so the harness also hides it from sandboxed checks.
    if (explicit) process.env.APERTURE_ENV_FILE = paths[0];
  });
  const wrap =
    <A extends unknown[]>(fn: (...args: A) => Promise<number>) =>
    async (...args: A) => {
      setExit(await fn(...args));
    };

  // `aperture` with no command opens the run browser (plain list when not on a terminal).
  program.action(wrap(() => uiCommand(undefined, globals())));

  program
    .command('ui')
    .description('browse runs: list → overview, activity, diff, checks, costs, questions')
    .argument('[run-id]', 'open this run directly')
    .action(wrap((runId: string | undefined) => uiCommand(runId, globals())));

  program.command('init').description('write a default config and create the storage directory').action(wrap(() => initCommand(globals())));

  program
    .command('run')
    .description('ingest a task (github:owner/repo#N, linear:KEY-N, or contract.yaml) and execute it')
    .argument('<task>', 'task reference')
    .option('--repo <path>', 'local git repository to work in (default: config mapping or cwd)')
    .option('--workspace <mode>', 'in-place (default: your checked-out branch, which must be clean) or worktree')
    .option('--model <id>', 'implementation model id')
    .option('--budget <usd>', 'implementation budget in USD')
    .option('--cache <ttl>', 'prompt cache TTL: 5m, 1h, or off')
    .option('--no-interactive', 'never prompt; questions block the run (exit code 3/2)')
    .option('--reduced-security', 'allow running without an OS sandbox (explicit reduced-isolation mode)')
    .option('-y, --yes', 'approve the proposed contract without prompting')
    .option('--script <file>', 'replay tool calls from a YAML script instead of calling a model')
    .option('--answers <file>', 'YAML list of preauthorized answers ({match, answer}) for noninteractive runs')
    .option('--show-model-text', 'stream the model\'s visible text output')
    .option('-v, --verbose', 'show every tool request and model turn')
    .option('-q, --quiet', 'print only the final summary')
    .option('--filter <types>', 'comma-separated event type prefixes to show (e.g. tool,check)')
    .option('--tui', 'full-screen Ink interface (interactive terminals)')
    .action(wrap((task: string, opts: RunCommandOptions) => runCommand(task, opts, globals())));

  program
    .command('status')
    .description('show a run, or list recent runs')
    .argument('[run-id]')
    .action(wrap((runId: string | undefined) => statusCommand(runId, globals())));

  program
    .command('logs')
    .description('print the event log of a run')
    .argument('<run-id>')
    .option('--format <format>', 'text or jsonl', 'text')
    .option('-f, --follow', 'keep printing new events until the run finishes')
    .option('-v, --verbose', 'include every event')
    .option('--show-model-text', 'include model text output')
    .option('--filter <types>', 'comma-separated event type prefixes')
    .action(wrap((runId: string, opts) => logsCommand(runId, opts, globals())));

  program
    .command('diff')
    .description('show the run worktree diff against its baseline')
    .argument('<run-id>')
    .action(wrap((runId: string) => diffCommand(runId, globals())));

  program
    .command('resume')
    .description('continue an interrupted or paused run from its persisted state')
    .argument('<run-id>')
    .option('--script <file>', 'replay tool calls from a YAML script (for runs started with --script)')
    .option('--no-interactive', 'never prompt')
    .option('--answers <file>', 'YAML list of preauthorized answers ({match, answer})')
    .option('--show-model-text', 'stream the model\'s visible text output')
    .option('-v, --verbose', 'show every tool request and model turn')
    .option('-q, --quiet', 'print only the final summary')
    .option('--filter <types>', 'comma-separated event type prefixes to show')
    .option('--tui', 'full-screen Ink interface (interactive terminals)')
    .action(wrap((runId: string, opts: ResumeOptions) => resumeCommand(runId, opts, globals())));

  program
    .command('attach')
    .description('live read-only TUI for a run (overview, activity, diff, checks, costs, questions)')
    .argument('<run-id>')
    .option('--show-model-text', 'start with model text visible')
    .action(wrap((runId: string, opts: { showModelText?: boolean }) => attachCommand(runId, opts, globals())));

  program
    .command('answer')
    .description('answer an open question or decide a scope request')
    .argument('<run-id>')
    .argument('<question-id>')
    .argument('[answer...]', 'free-form answer text')
    .option('--choice <n>', 'pick one of the offered choices (1-based)')
    .option('--approve', 'approve a scope change request (creates a new contract revision)')
    .option('--deny', 'deny a scope change request')
    .option('--rationale <text>', 'recorded rationale')
    .action(wrap((runId: string, questionId: string, words: string[], opts: AnswerOptions) => answerCommand(runId, questionId, words, opts, globals())));

  program
    .command('cancel')
    .description('cancel a run')
    .argument('<run-id>')
    .option('--reason <text>', 'recorded reason')
    .option('--cleanup', 'also remove the run worktree and branch')
    .action(wrap((runId: string, opts: { reason?: string; cleanup?: boolean }) => cancelCommand(runId, opts, globals())));

  program
    .command('usage')
    .description('per-request token, cache and cost ledger for a run')
    .argument('<run-id>')
    .option('--format <format>', 'text or json', 'text')
    .action(wrap((runId: string, opts: { format?: string }) => usageCommand(runId, opts, globals())));

  program
    .command('review')
    .description('review verification evidence and approve the diff')
    .argument('<run-id>')
    .option('--accept-local', 'accept the result locally (COMPLETED_LOCAL)')
    .option('--approve', 'approve the diff for a pull request')
    .option('--acknowledge-unverified', 'accept unverified requirements on manual review')
    .option('--reject', 'reject the diff and cancel the run')
    .action(wrap((runId: string, opts: ReviewOptions) => reviewCommand(runId, opts, globals())));

  const pr = program.command('pr').description('pull request drafting and publication');
  pr.command('draft')
    .description('draft PR title/body with the PR model from verified evidence')
    .argument('<run-id>')
    .option('--model <id>', 'PR drafting model (default: contract models.prDraft)')
    .option('--repository <owner/repo>', 'associate a GitHub repository (required for unmapped Linear tasks)')
    .option('--no-draft-pr', 'open a ready-for-review PR instead of a draft PR')
    .action(wrap((runId: string, opts: { model?: string; repository?: string; draftPr: boolean }) => prDraftCommand(runId, opts, globals())));
  pr.command('create')
    .description('commit, push and open the PR after explicit approval')
    .argument('<run-id>')
    .option('-y, --yes', 'approve publication without prompting')
    .action(wrap((runId: string, opts: { yes?: boolean }) => prCreateCommand(runId, opts, globals())));

  return program;
}

export async function main(argv: string[]): Promise<number> {
  let code = 0;
  const program = buildProgram((c) => {
    code = c;
  });
  try {
    await program.parseAsync(argv);
    return code;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode === 0 ? 0 : 1;
    process.stderr.write(`aperture: ${(err as Error).message}\n`);
    if (process.env.APERTURE_DEBUG) process.stderr.write(`${(err as Error).stack}\n`);
    return 1;
  }
}
