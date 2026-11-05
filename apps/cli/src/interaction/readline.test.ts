import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseContract } from '@aperture/contracts';
import type { ContractProposal } from '@aperture/core';
import { fixtureContract } from '../../../../tests/helpers/harness.ts';
import { ReadlineInteraction } from './readline.ts';

const ANSI = /\u001b\[[0-9;]*m/;
const YAML = 'apiVersion: aperture.dev/v1\nkind: ExecutionContract\n# yaml-marker\n';

function proposal(extra: Partial<ContractProposal> = {}): ContractProposal {
  return { runId: 'run_1', version: 1, contract: parseContract(fixtureContract()), yaml: YAML, sha256: 'a'.repeat(64), findings: [], notes: [], ...extra };
}

/**
 * A ReadlineInteraction over PassThrough streams. Each scripted answer is typed only once a prompt
 * (output ending in ": ") appears, as a user would; readline drops lines that arrive early.
 */
function terminal(answers: string[], options: { tty?: boolean } = {}): { ui: ReadlineInteraction; output: () => string; prompts: () => number; input: PassThrough } {
  const input = new PassThrough();
  const out = new PassThrough();
  if (options.tty) (out as unknown as { isTTY: boolean }).isTTY = true;
  let text = '';
  let prompts = 0;
  out.on('data', (chunk: Buffer) => {
    const s = String(chunk);
    text += s;
    if (s.endsWith(': ')) {
      prompts++;
      const next = answers.shift();
      if (next !== undefined) setImmediate(() => input.write(`${next}\n`));
    }
  });
  const ui = new ReadlineInteraction('alice', input, out);
  return { ui, output: () => text, prompts: () => prompts, input };
}

/** Ends the input and waits until readline has seen it (the interface closes on 'end'). */
async function closeInput(input: PassThrough): Promise<void> {
  const ended = new Promise<void>((resolve) => input.once('end', () => resolve()));
  input.end();
  await ended;
  await new Promise((resolve) => setImmediate(resolve));
}

let savedNoColor: string | undefined;
let ui: ReadlineInteraction | undefined;

beforeEach(() => {
  savedNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
});

afterEach(() => {
  ui?.close();
  ui = undefined;
  if (savedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedNoColor;
});

describe('ReadlineInteraction', () => {
  it('is interactive and records its actor', () => {
    const t = terminal([]);
    ui = t.ui;
    expect(ui.interactive).toBe(true);
    expect(ui.actor).toBe('alice');
  });

  describe('reviewContract', () => {
    it('prints the formatted contract before prompting, then approves on "a"', async () => {
      const t = terminal(['a']);
      ui = t.ui;
      await expect(ui.reviewContract(proposal())).resolves.toEqual({ action: 'approve' });
      const out = t.output();
      expect(out).toMatch(/╭─ Contract v1 · LOCAL-142 ─+╮/);
      for (const title of ['GOAL', 'REQUIREMENTS', 'SCOPE', 'PERMISSIONS', 'CHECKS', 'LIMITS & MODELS']) expect(out).toContain(`── ${title} `);
      expect(out.indexOf('── GOAL ')).toBeLessThan(out.indexOf('Approve this contract?'));
      expect(out).toContain('[a]pprove / [e]dit / [v]iew YAML / [r]eject / [d]efer: ');
      expect(out).not.toContain('yaml-marker');
      expect(t.prompts()).toBe(1);
    });

    it.each(['v', 'V', 'yaml'])('prints the YAML on %j and asks again', async (key) => {
      const t = terminal([key, 'approve']);
      ui = t.ui;
      await expect(ui.reviewContract(proposal())).resolves.toEqual({ action: 'approve' });
      const out = t.output();
      expect(out).toContain('apiVersion: aperture.dev/v1\nkind: ExecutionContract\n# yaml-marker\n');
      expect(out.split('Approve this contract?')).toHaveLength(3);
      expect(out.indexOf('# yaml-marker')).toBeGreaterThan(out.indexOf('Approve this contract?'));
      expect(t.prompts()).toBe(2);
    });

    it('marks writable paths missing from existingPaths as new files', async () => {
      const t = terminal(['d']);
      ui = t.ui;
      await ui.reviewContract(proposal({ existingPaths: ['src/api/session.ts'] }));
      expect(t.output()).toContain('✎ src/api/session.test.ts (new file)');
      expect(t.output()).not.toContain('✎ src/api/session.ts (new file)');
    });

    it('shows notes and findings in the contract view', async () => {
      const t = terminal(['d']);
      ui = t.ui;
      await ui.reviewContract(proposal({ notes: ['VAGUE_TICKET: unclear'], findings: [{ level: 'warning', code: 'BROAD_SCOPE', message: 'wide' }] }));
      expect(t.output()).toContain('ℹ VAGUE_TICKET unclear');
      expect(t.output()).toContain('▲ BROAD_SCOPE wide');
    });

    it('refuses to approve a contract with error findings and re-prompts', async () => {
      const t = terminal(['a', 'd']);
      ui = t.ui;
      await expect(ui.reviewContract(proposal({ findings: [{ level: 'error', code: 'UNKNOWN_COMMAND', message: 'check x has no command' }] }))).resolves.toBeNull();
      expect(t.output()).toContain('The contract has errors and cannot be approved; edit it first.');
      expect(t.prompts()).toBe(2);
    });

    it('rejects with a reason, or without one when left empty', async () => {
      const withReason = terminal(['r', 'scope too wide']);
      ui = withReason.ui;
      await expect(ui.reviewContract(proposal())).resolves.toEqual({ action: 'reject', reason: 'scope too wide' });
      ui.close();

      const without = terminal(['reject', '']);
      ui = without.ui;
      await expect(ui.reviewContract(proposal())).resolves.toEqual({ action: 'reject' });
    });

    it.each(['d', 'defer', ''])('defers (null) on %j', async (key) => {
      const t = terminal([key]);
      ui = t.ui;
      await expect(ui.reviewContract(proposal())).resolves.toBeNull();
    });

    it('ignores unknown answers and asks again', async () => {
      const t = terminal(['x', 'maybe', 'a']);
      ui = t.ui;
      await expect(ui.reviewContract(proposal())).resolves.toEqual({ action: 'approve' });
      expect(t.prompts()).toBe(3);
    });

    it('defers when asked after the input has closed', async () => {
      const t = terminal(['a']);
      ui = t.ui;
      await ui.choose('first: ', ['a']);
      await closeInput(t.input);
      await expect(ui.reviewContract(proposal())).resolves.toBeNull();
    });

    // Regression: on Node 22 a pending readline/promises question() never settles when the input
    // ends (EOF / Ctrl-D); ask() resolves on the interface's close event so the prompt defers.
    it('defers when the input closes while the prompt is pending', async () => {
      const t = terminal([]);
      ui = t.ui;
      const result = ui.reviewContract(proposal());
      t.input.end();
      await expect(Promise.race([result, new Promise((resolve) => setTimeout(() => resolve('still pending'), 300))])).resolves.toBeNull();
    });

    it('prints without ANSI codes to a non-TTY stream', async () => {
      const t = terminal(['d']);
      ui = t.ui;
      await ui.reviewContract(proposal());
      expect(t.output()).not.toMatch(ANSI);
    });

    it('colors a TTY unless NO_COLOR is set', async () => {
      const colored = terminal(['d'], { tty: true });
      ui = colored.ui;
      await ui.reviewContract(proposal());
      expect(colored.output()).toMatch(ANSI);
      ui.close();

      process.env.NO_COLOR = '1';
      const plain = terminal(['d'], { tty: true });
      ui = plain.ui;
      await ui.reviewContract(proposal());
      expect(plain.output()).not.toMatch(ANSI);
    });
  });

  describe('choose', () => {
    it('returns the chosen key, case-insensitively', async () => {
      const t = terminal(['R']);
      ui = t.ui;
      await expect(ui.choose('Next? [a]/[r]: ', ['a', 'r'])).resolves.toBe('r');
      expect(t.output()).toContain('Next? [a]/[r]: ');
    });

    it('re-prompts until a listed key is given', async () => {
      const t = terminal(['x', 'yes', 'a']);
      ui = t.ui;
      await expect(ui.choose('Next? [a]/[r]: ', ['a', 'r'])).resolves.toBe('a');
      expect(t.prompts()).toBe(3);
    });

    it('returns an empty string on a bare enter', async () => {
      const t = terminal(['']);
      ui = t.ui;
      await expect(ui.choose('Next? [a]/[r]: ', ['a', 'r'])).resolves.toBe('');
    });

    it('returns an empty string when asked after the input has closed', async () => {
      const t = terminal(['a']);
      ui = t.ui;
      await expect(ui.choose('first: ', ['a'])).resolves.toBe('a');
      await closeInput(t.input);
      await expect(ui.choose('Next? [a]/[r]: ', ['a', 'r'])).resolves.toBe('');
    });
  });
});
