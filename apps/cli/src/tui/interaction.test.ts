import { describe, expect, it } from 'vitest';
import type { ContractProposal, QuestionPrompt, ScopeChangePrompt } from '@aperture/core';
import { InkInteraction } from './interaction.ts';

const question: QuestionPrompt = { runId: 'run_1', questionId: 'q_1', question: 'Persist metadata?', choices: ['yes', 'no'], reason: 'unclear', requirementIds: ['R1'] };
const scope: ScopeChangePrompt = { runId: 'run_1', questionId: 'q_2', reason: 'types', additionalPaths: ['src/api/types.ts'], currentWritable: ['src/api/session.ts'] };
const proposal = { runId: 'run_1', version: 1, sha256: 'x', yaml: '', findings: [], notes: [] } as unknown as ContractProposal;

describe('InkInteraction', () => {
  it('is interactive and records its actor', () => {
    const ui = new InkInteraction('alice');
    expect(ui.interactive).toBe(true);
    expect(ui.actor).toBe('alice');
    expect(ui.pending).toBeNull();
  });

  it('exposes a question as pending until resolved, notifying subscribers each time', async () => {
    const ui = new InkInteraction('alice');
    const seen: Array<string | null> = [];
    ui.subscribe(() => seen.push(ui.pending?.kind ?? null));
    const answer = ui.askQuestion(question);
    expect(ui.pending).toMatchObject({ kind: 'question', prompt: question });
    if (ui.pending?.kind !== 'question') throw new Error('expected a question');
    ui.pending.resolve({ answer: 'no', choiceIndex: 1 });
    await expect(answer).resolves.toEqual({ answer: 'no', choiceIndex: 1 });
    expect(ui.pending).toBeNull();
    expect(seen).toEqual(['question', null]);
  });

  it('routes contract, scope and confirm prompts', async () => {
    const ui = new InkInteraction('alice');
    const contract = ui.reviewContract(proposal);
    expect(ui.pending).toMatchObject({ kind: 'contract', prompt: proposal });
    (ui.pending as { resolve: (v: unknown) => void }).resolve({ action: 'approve' });
    await expect(contract).resolves.toEqual({ action: 'approve' });

    const decision = ui.decideScopeChange(scope);
    expect(ui.pending).toMatchObject({ kind: 'scope', prompt: scope });
    (ui.pending as { resolve: (v: unknown) => void }).resolve({ approved: false });
    await expect(decision).resolves.toEqual({ approved: false });

    const confirmed = ui.confirm('Publish?', 'details here');
    expect(ui.pending).toMatchObject({ kind: 'confirm', prompt: { message: 'Publish?', details: 'details here' } });
    (ui.pending as { resolve: (v: unknown) => void }).resolve(true);
    await expect(confirmed).resolves.toBe(true);

    void ui.confirm('No details');
    expect(ui.pending?.prompt).toEqual({ message: 'No details' });
  });

  it('dismiss resolves prompts with "not now" (null) and confirms with false', async () => {
    const ui = new InkInteraction('alice');
    const q = ui.askQuestion(question);
    ui.dismiss();
    await expect(q).resolves.toBeNull();
    expect(ui.pending).toBeNull();

    const c = ui.confirm('Publish?');
    ui.dismiss();
    await expect(c).resolves.toBe(false);

    const r = ui.reviewContract(proposal);
    ui.dismiss();
    await expect(r).resolves.toBeNull();
  });

  it('dismiss is a no-op with nothing pending', () => {
    const ui = new InkInteraction('alice');
    const calls: number[] = [];
    ui.subscribe(() => calls.push(1));
    ui.dismiss();
    expect(calls).toEqual([]);
  });

  it('unsubscribe stops notifications', async () => {
    const ui = new InkInteraction('alice');
    let calls = 0;
    const off = ui.subscribe(() => calls++);
    off();
    const q = ui.askQuestion(question);
    ui.dismiss();
    await q;
    expect(calls).toBe(0);
  });
});
