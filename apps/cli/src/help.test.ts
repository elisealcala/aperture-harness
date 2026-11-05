import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_EXAMPLES, commandHelpText, mainHelpText } from './help.ts';
import { main } from './main.ts';

const ESC = '\u001b[';
const SECTIONS = ['Typical workflow', 'Task references', 'Inspect', 'Run browser keys', 'Setup', 'Exit codes'];

let savedEnv: NodeJS.ProcessEnv;
const savedTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function setStdoutTTY(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true, writable: true });
}

beforeEach(() => {
  savedEnv = { ...process.env };
  delete process.env.FORCE_COLOR;
  delete process.env.NO_COLOR;
  setStdoutTTY(false);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  if (savedTTY) Object.defineProperty(process.stdout, 'isTTY', savedTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
});

const stdout = () => vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0])).join('');
const stderr = () => vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0])).join('');
const argv = (...rest: string[]) => ['node', 'aperture', ...rest];

describe('mainHelpText', () => {
  it('contains every section title', () => {
    const text = mainHelpText();
    for (const title of SECTIONS) expect(text).toContain(`\n${title}\n`);
  });

  it('lists the exit codes 0-3 with their meaning', () => {
    const text = mainHelpText();
    expect(text).toMatch(/^ {2}0 {2}ready for review \/ completed \/ PR created$/m);
    expect(text).toMatch(/^ {2}1 {2}error$/m);
    expect(text).toMatch(/^ {2}2 {2}blocked, failed or canceled$/m);
    expect(text).toMatch(/^ {2}3 {2}waiting for a decision \(contract approval or a question\)$/m);
  });

  it('pads the left column to a common width within a section', () => {
    const text = mainHelpText();
    expect(text).toContain(`  ${'linear:ENG-123'.padEnd('github:owner/repo#N'.length)}  Linear issue (set LINEAR_API_KEY)`);
  });

  it('ends with the pointer to per-command help', () => {
    expect(mainHelpText().trimEnd().split('\n').at(-1)).toBe('Details for any command: aperture <command> --help    Docs: README.md, docs/system-design.md');
  });

  it('has no ANSI escapes with NO_COLOR=1 even on a terminal', () => {
    setStdoutTTY(true);
    process.env.NO_COLOR = '1';
    expect(mainHelpText()).not.toContain(ESC);
  });

  it('has no ANSI escapes when stdout is not a terminal', () => {
    expect(mainHelpText()).not.toContain(ESC);
  });

  it('is colored with FORCE_COLOR=1 off a terminal', () => {
    process.env.FORCE_COLOR = '1';
    const text = mainHelpText();
    expect(text).toContain(`${ESC}1mExit codes${ESC}0m`);
    expect(text).toContain(`${ESC}36m`);
    expect(text).toContain(`${ESC}90m`);
  });
});

describe('commandHelpText', () => {
  it.each(Object.keys(COMMAND_EXAMPLES))('returns an Examples section for `%s`', (name) => {
    const text = commandHelpText(name);
    expect(text.startsWith('\nExamples\n')).toBe(true);
    for (const [example, description] of COMMAND_EXAMPLES[name]!) {
      expect(text).toContain(example);
      expect(text).toContain(description);
    }
  });

  it.each(['init', 'status', 'pr', 'nope', ''])('returns an empty string for `%s` (no examples)', (name) => {
    expect(commandHelpText(name)).toBe('');
  });

  // Regression: COMMAND_EXAMPLES is a plain object; inherited keys such as `toString` must not count.
  it('does not treat Object.prototype keys as commands', () => {
    expect(commandHelpText('toString')).toBe('');
  });

  it('is colored with FORCE_COLOR=1 and plain otherwise', () => {
    expect(commandHelpText('run')).not.toContain(ESC);
    process.env.FORCE_COLOR = '1';
    expect(commandHelpText('run')).toContain(`${ESC}1mExamples${ESC}0m`);
  });
});

describe('main --help', () => {
  it('prints usage, the command list and the guide, and exits 0', async () => {
    expect(await main(argv('--help'))).toBe(0);
    const out = stdout();
    expect(out).toContain('Usage: aperture [options] [command]');
    expect(out).toMatch(/^Commands:$/m);
    for (const command of ['ui', 'init', 'run', 'status', 'logs', 'diff', 'resume', 'attach', 'answer', 'cancel', 'usage', 'review', 'pr']) {
      expect(out).toMatch(new RegExp(`^ {2}${command}\\b`, 'm'));
    }
    for (const title of SECTIONS) expect(out).toContain(title);
    expect(out.indexOf('Commands:')).toBeLessThan(out.indexOf('Typical workflow'));
    expect(out).not.toContain(ESC);
    expect(stderr()).toBe('');
  });

  it('accepts -h as well', async () => {
    expect(await main(argv('-h'))).toBe(0);
    expect(stdout()).toContain('Typical workflow');
  });

  it.each([
    [['run', '--help'], 'Usage: aperture run [options] <task>', 'run'],
    [['pr', 'create', '--help'], 'Usage: aperture pr create [options] <run-id>', 'create'],
    [['review', '--help'], 'Usage: aperture review [options] <run-id>', 'review'],
    [['pr', 'draft', '--help'], 'Usage: aperture pr draft [options] <run-id>', 'draft'],
  ])('`%j` prints the command usage followed by its Examples', async (args, usage, key) => {
    expect(await main(argv(...args))).toBe(0);
    const out = stdout();
    expect(out).toContain(usage);
    expect(out).toMatch(/^Examples$/m);
    for (const [example] of COMMAND_EXAMPLES[key]!) expect(out).toContain(example);
    expect(out.indexOf('Options:')).toBeLessThan(out.indexOf('Examples'));
    // The main guide belongs to `aperture --help` only.
    expect(out).not.toContain('Typical workflow');
  });

  it('`init --help` has no Examples section', async () => {
    expect(await main(argv('init', '--help'))).toBe(0);
    const out = stdout();
    expect(out).toContain('Usage: aperture init [options]');
    expect(out).not.toContain('Examples');
  });

  it('`pr --help` has no Examples section of its own', async () => {
    expect(await main(argv('pr', '--help'))).toBe(0);
    const out = stdout();
    expect(out).toContain('Usage: aperture pr [options] [command]');
    expect(out).not.toContain('Examples');
  });

  it('`pr help create` behaves like `pr create --help`', async () => {
    expect(await main(argv('pr', 'help', 'create'))).toBe(0);
    expect(stdout()).toContain('Usage: aperture pr create [options] <run-id>');
    expect(stdout()).toContain('Examples');
  });

  it('still exits 1 for an unknown option and shows help on stderr', async () => {
    expect(await main(argv('run', '--nope'))).toBe(1);
    expect(stderr()).toContain("error: unknown option '--nope'");
    expect(stderr()).toContain('Usage: aperture run');
  });
});

// Regression: the root program has a default action, which suppresses Commander's implicit
// `help` command unless it is enabled explicitly with `program.helpCommand(true)`.
describe('main help (command form)', () => {
  it('`help` behaves like --help', async () => {
    expect(await main(argv('help'))).toBe(0);
    expect(stdout()).toContain('Usage: aperture [options] [command]');
    expect(stdout()).toContain('Typical workflow');
  });

  it('`help run` behaves like `run --help`', async () => {
    expect(await main(argv('help', 'run'))).toBe(0);
    expect(stdout()).toContain('Usage: aperture run [options] <task>');
    expect(stdout()).toContain('Examples');
  });
});
