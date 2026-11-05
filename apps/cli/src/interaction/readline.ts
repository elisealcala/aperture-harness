import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { parseContractText, ContractValidationError } from '@aperture/contracts';
import { formatContract } from '../render/contract.ts';
import { createStyle } from '../render/style.ts';
import type { ContractProposal, ContractReviewResult, Interaction, QuestionAnswer, QuestionPrompt, ScopeChangePrompt, ScopeDecision } from '@aperture/core';

export function defaultActor(): string {
  try {
    return `user:${userInfo().username}`;
  } catch {
    return 'user:unknown';
  }
}

/** Line-oriented prompts on stdin/stdout for interactive terminals. */
export class ReadlineInteraction implements Interaction {
  readonly interactive = true;
  private rl: Interface | undefined;

  constructor(
    readonly actor: string = defaultActor(),
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {}

  private get prompt(): Interface {
    this.rl ??= createInterface({ input: this.input, output: this.output, terminal: Boolean((this.input as NodeJS.ReadStream).isTTY) });
    return this.rl;
  }

  close(): void {
    this.rl?.close();
    this.rl = undefined;
  }

  private write(text: string): void {
    this.output.write(`${text}\n`);
  }

  private async ask(question: string): Promise<string> {
    try {
      return (await this.prompt.question(question)).trim();
    } catch {
      return '';
    }
  }

  async reviewContract(proposal: ContractProposal): Promise<ContractReviewResult | null> {
    const style = createStyle(Boolean((this.output as NodeJS.WriteStream).isTTY) && !process.env.NO_COLOR);
    this.write('');
    this.write(
      formatContract(
        { contract: proposal.contract, version: proposal.version, sha256: proposal.sha256, findings: proposal.findings, notes: proposal.notes, ...(proposal.existingPaths ? { existingPaths: new Set(proposal.existingPaths) } : {}) },
        style,
      ),
    );
    for (;;) {
      const answer = (await this.ask(`\n${style('bold', 'Approve this contract?')} ${style('green', '[a]pprove')} / ${style('cyan', '[e]dit')} / ${style('gray', '[v]iew YAML')} / ${style('red', '[r]eject')} / [d]efer: `)).toLowerCase();
      if (answer === 'v' || answer === 'yaml') {
        this.write(proposal.yaml.trimEnd());
        continue;
      }
      if (answer === 'a' || answer === 'approve') {
        if (proposal.findings.some((f) => f.level === 'error')) {
          this.write('The contract has errors and cannot be approved; edit it first.');
          continue;
        }
        return { action: 'approve' };
      }
      if (answer === 'r' || answer === 'reject') {
        const reason = await this.ask('Reason (optional): ');
        return reason ? { action: 'reject', reason } : { action: 'reject' };
      }
      if (answer === 'd' || answer === 'defer' || answer === '') return null;
      if (answer === 'e' || answer === 'edit') {
        const edited = await this.editInEditor(proposal.yaml);
        if (edited) return { action: 'edit', contract: edited };
      }
    }
  }

  private async editInEditor(yaml: string): Promise<ReturnType<typeof parseContractText> | null> {
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'vi';
    const dir = mkdtempSync(join(tmpdir(), 'aperture-contract-'));
    const file = join(dir, 'contract.yaml');
    writeFileSync(file, yaml, { mode: 0o600 });
    try {
      for (;;) {
        // The editor is the user's own configured program, attached to their terminal.
        const result = spawnSync(editor, [file], { stdio: 'inherit' });
        if (result.status !== 0) {
          this.write(`editor exited with ${result.status}; keeping the previous proposal`);
          return null;
        }
        try {
          return parseContractText(readFileSync(file, 'utf8'));
        } catch (err) {
          this.write(err instanceof ContractValidationError ? err.message : String(err));
          const again = (await this.ask('Re-open the editor to fix it? [Y/n]: ')).toLowerCase();
          if (again === 'n' || again === 'no') return null;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async askQuestion(prompt: QuestionPrompt): Promise<QuestionAnswer | null> {
    this.write(`\n[?] ${prompt.question}`);
    this.write(`    why it blocks: ${prompt.reason}${prompt.requirementIds.length ? ` (affects ${prompt.requirementIds.join(', ')})` : ''}`);
    prompt.choices.forEach((choice, i) => this.write(`    ${i + 1}) ${choice}`));
    if (prompt.choices.length > 0) this.write(`    ${prompt.choices.length + 1}) Other`);
    const raw = await this.ask('> answer (number or text, empty to answer later): ');
    if (!raw) return null;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= prompt.choices.length) return { answer: prompt.choices[n - 1]!, choiceIndex: n - 1 };
    if (Number.isInteger(n) && n === prompt.choices.length + 1) {
      const other = await this.ask('> your answer: ');
      return other ? { answer: other } : null;
    }
    return { answer: raw };
  }

  async decideScopeChange(prompt: ScopeChangePrompt): Promise<ScopeDecision | null> {
    this.write(`\n[?] The agent requests write access to: ${prompt.additionalPaths.join(', ')}`);
    this.write(`    reason: ${prompt.reason}`);
    this.write(`    currently writable: ${prompt.currentWritable.join(', ')}`);
    const raw = (await this.ask('Approve a new contract revision with these paths? [y]es / [n]o / [d]efer: ')).toLowerCase();
    if (raw === 'd' || raw === '') return null;
    const rationale = await this.ask('Rationale (recorded): ');
    return { approved: raw === 'y' || raw === 'yes', ...(rationale ? { rationale } : {}) };
  }

  /** Single-key menu; returns the chosen key, or '' when the user just presses enter. */
  async choose(message: string, keys: readonly string[]): Promise<string> {
    for (;;) {
      const raw = (await this.ask(message)).toLowerCase();
      if (raw === '' || keys.includes(raw)) return raw;
    }
  }

  async confirm(message: string, details?: string): Promise<boolean> {
    if (details) this.write(details);
    const raw = (await this.ask(`${message} [y/N]: `)).toLowerCase();
    return raw === 'y' || raw === 'yes';
  }
}
