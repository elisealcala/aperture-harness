import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import type { VerificationReport } from '@aperture/verifier';
import { runRecord } from '../../../../tests/helpers/records.ts';
import { App } from './App.tsx';
import { InkInteraction } from './interaction.ts';
import type { TuiSnapshot } from './model.ts';

// renderToString shows the initial render only, so these cover the header, tab bar and Overview.
function snapshot(overrides: Partial<TuiSnapshot> = {}): TuiSnapshot {
  return {
    run: runRecord('run_01TUI', 'task_1', { state: 'READY_FOR_REVIEW', contractId: 'task_1.v1', worktreePath: '/tmp/wt', baselineSha: '0123456789abcdef', turns: 3, patchAttempts: 1, verificationAttempts: 1 }),
    title: 'Add optional session metadata',
    sourceRef: 'github:org/repo#142',
    contract: {
      version: 2,
      sha256: 'f'.repeat(64),
      goal: 'Accept optional session metadata',
      requirements: [
        { id: 'R1', text: 'Accept a metadata field' },
        { id: 'R2', text: 'Preserve compatibility' },
      ],
      budgetUsd: 0.5,
      prBudgetUsd: 0.02,
    },
    events: [],
    checks: [],
    verification: { requirements: [{ id: 'R1', status: 'VERIFIED' }, { id: 'R2', status: 'UNVERIFIED' }] } as unknown as VerificationReport,
    usage: [],
    spent: { implementation: 0.25, pr: 0.001 },
    questions: [],
    diff: '',
    ...overrides,
  };
}

function render(s: TuiSnapshot, interaction?: InkInteraction): string {
  return renderToString(<App load={() => s} onQuit={() => {}} {...(interaction ? { interaction } : {})} />, { columns: 200 });
}

describe('App', () => {
  it('renders the header, tab bar and Overview panel from the snapshot', () => {
    const out = render(snapshot());
    expect(out).toContain('RUN run_01TUI');
    expect(out).toContain('STATE READY_FOR_REVIEW');
    expect(out).toContain('MODEL claude-sonnet-5-5');
    expect(out).toMatch(/1 Overview\s+2 Activity\s+3 Diff\s+4 Checks\s+5 Costs\s+6 Questions/);
    expect(out).toContain('GOAL Accept optional session metadata');
    expect(out).toContain('SOURCE github:org/repo#142');
    expect(out).toContain(`CONTRACT v2 sha256:${'f'.repeat(16)}`);
    expect(out).not.toContain('(not approved)');
    expect(out).toContain('WORKTREE /tmp/wt @ 0123456789');
    expect(out).toContain('turns 3 · patches 1 · verifications 1');
    expect(out).toContain('[✓] R1 Accept a metadata field');
    expect(out).toContain('[~] R2 Preserve compatibility');
    expect(out).toContain(`Budget ${'█'.repeat(10)}${'░'.repeat(10)} $0.250 / $0.500 · PR $0.001 / $0.020`);
    expect(out).toContain('q detach');
  });

  it('marks an unapproved contract and a missing worktree', () => {
    const s = snapshot();
    s.run = { ...s.run, contractId: null, worktreePath: null, baselineSha: null };
    const out = render(s);
    expect(out).toContain('(not approved)');
    expect(out).toContain('WORKTREE - @ -');
  });

  it('shows "pending" without any contract and the terminal reason when set', () => {
    const s = snapshot({ contract: undefined });
    s.run = { ...s.run, state: 'BLOCKED', terminalReason: 'STALLED: identical failure repeated' };
    const out = render(s);
    expect(out).toContain('CONTRACT pending');
    expect(out).toContain('GOAL Add optional session metadata');
    expect(out).toContain('STALLED: identical failure repeated');
  });

  it('flags the Questions tab when questions are open or a prompt is pending', () => {
    expect(render(snapshot())).not.toContain('(!)');
    const withQuestion = snapshot({ questions: [{ questionId: 'q_1', payload: { type: 'question', toolCallId: 't', question: 'Persist?', choices: [], reason: 'r', requirementIds: [] } }] });
    expect(render(withQuestion)).toContain('6 Questions (!)');

    const ui = new InkInteraction('alice');
    void ui.confirm('Publish?');
    const out = render(snapshot(), ui);
    expect(out).toContain('6 Questions (!)');
    expect(out).toContain('q interrupt');
    ui.dismiss();
  });
});
