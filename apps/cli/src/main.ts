import { Command, CommanderError } from 'commander';
import type { GlobalOptions } from './context.ts';
import { initCommand } from './commands/init.ts';
import { diffCommand, logsCommand, statusCommand } from './commands/inspect.ts';
import { runCommand, type RunCommandOptions } from './commands/run.ts';

export function buildProgram(setExit: (code: number) => void): Command {
  const program = new Command();
  program
    .name('aperture')
    .description('Budget-controlled, contract-driven coding execution harness')
    .option('--config <path>', 'config file (default: ~/.config/aperture/config.yaml or $APERTURE_CONFIG)')
    .option('--home <dir>', 'storage directory (default: config storage.directory or $APERTURE_HOME)')
    .showHelpAfterError()
    .exitOverride();

  const globals = (): GlobalOptions => program.opts<GlobalOptions>();
  const wrap =
    <A extends unknown[]>(fn: (...args: A) => Promise<number>) =>
    async (...args: A) => {
      setExit(await fn(...args));
    };

  program.command('init').description('write a default config and create the storage directory').action(wrap(() => initCommand(globals())));

  program
    .command('run')
    .description('ingest a task (github:owner/repo#N, linear:KEY-N, or contract.yaml) and execute it')
    .argument('<task>', 'task reference')
    .option('--repo <path>', 'local git repository to work in (default: config mapping or cwd)')
    .option('--model <id>', 'implementation model id')
    .option('--budget <usd>', 'implementation budget in USD')
    .option('--cache <ttl>', 'prompt cache TTL: 5m, 1h, or off')
    .option('--no-interactive', 'never prompt; questions block the run (exit code 3/2)')
    .option('--reduced-security', 'allow running without an OS sandbox (explicit reduced-isolation mode)')
    .option('-y, --yes', 'approve the proposed contract without prompting')
    .option('--script <file>', 'replay tool calls from a YAML script instead of calling a model')
    .option('--show-model-text', 'stream the model\'s visible text output')
    .option('-v, --verbose', 'show every tool request and model turn')
    .option('-q, --quiet', 'print only the final summary')
    .option('--filter <types>', 'comma-separated event type prefixes to show (e.g. tool,check)')
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
