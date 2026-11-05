import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useEffect, useState, type ReactNode } from 'react';
import { formatContract } from '../render/contract.ts';
import { createStyle } from '../render/style.ts';
import { formatEvent, usd } from '../render/text.ts';
import type { InkInteraction, PendingPrompt } from './interaction.ts';
import { ACTIVITY_FILTERS, bar, matchesFilter, requirementProgress, type ActivityFilter, type TuiSnapshot } from './model.ts';

const TABS = ['Overview', 'Activity', 'Diff', 'Checks', 'Costs', 'Questions'] as const;
type Tab = (typeof TABS)[number];

export interface AppProps {
  load: () => TuiSnapshot;
  interaction?: InkInteraction;
  pollMs?: number;
  initialShowModelText?: boolean;
  onQuit: () => void;
  /** When set (run browser), q/Esc return to the run list instead of exiting. */
  onBack?: () => void;
}

function stateColor(state: string): string {
  if (state === 'COMPLETED_LOCAL' || state === 'PR_CREATED' || state === 'READY_FOR_REVIEW') return 'green';
  if (state === 'BLOCKED' || state === 'FAILED' || state === 'CANCELED') return 'red';
  if (state === 'WAITING_FOR_USER' || state === 'NEEDS_CONTRACT_REVIEW' || state === 'PR_APPROVAL') return 'yellow';
  return 'cyan';
}

function eventColor(type: string): string | undefined {
  if (type === 'tool.rejected' || type === 'error' || type === 'budget.exhausted') return 'red';
  if (type.startsWith('question.') || type.startsWith('scope.') || type === 'budget.warning') return 'yellow';
  if (type === 'model.output.delta') return 'gray';
  return undefined;
}

function window<T>(items: readonly T[], height: number, offsetFromEnd: number): T[] {
  const end = Math.max(0, items.length - offsetFromEnd);
  return items.slice(Math.max(0, end - height), end);
}

function Overview({ s }: { s: TuiSnapshot }): ReactNode {
  const budget = s.contract?.budgetUsd ?? 0;
  const cacheRead = s.usage.reduce((n, u) => n + u.cacheRead, 0);
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>GOAL </Text>
        {s.contract?.goal ?? s.title}
      </Text>
      <Text>
        <Text bold>SOURCE </Text>
        {s.sourceRef}
      </Text>
      <Text>
        <Text bold>CONTRACT </Text>
        {s.contract ? `v${s.contract.version} sha256:${s.contract.sha256.slice(0, 16)}` : 'pending'}
        {s.run.contractId ? '' : ' (not approved)'}
      </Text>
      <Text>
        <Text bold>WORKTREE </Text>
        {s.run.worktreePath ?? '-'} @ {s.run.baselineSha?.slice(0, 10) ?? '-'}
      </Text>
      <Text>
        <Text bold>PROGRESS </Text>
        turns {s.run.turns} · patches {s.run.patchAttempts} · verifications {s.run.verificationAttempts}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {requirementProgress(s).map((r) => (
          <Text key={r.id} color={r.mark === '✓' ? 'green' : r.mark === '✗' ? 'red' : undefined}>
            [{r.mark}] {r.id} {r.text}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text>
          Budget {bar(budget > 0 ? s.spent.implementation / budget : 0)} {usd(s.spent.implementation)} / {usd(budget)} · PR {usd(s.spent.pr)} / {usd(s.contract?.prBudgetUsd ?? 0)} · cache reads {cacheRead.toLocaleString('en-US')} tokens
        </Text>
      </Box>
      {s.run.terminalReason ? <Text color={stateColor(s.run.state)}>{s.run.terminalReason}</Text> : null}
    </Box>
  );
}

function Activity({ s, filter, verbose, showModelText, height, offset }: { s: TuiSnapshot; filter: ActivityFilter; verbose: boolean; showModelText: boolean; height: number; offset: number }): ReactNode {
  const lines: Array<{ key: string; text: string; color: string | undefined }> = [];
  for (const e of s.events) {
    if (!matchesFilter(e, filter)) continue;
    const text = formatEvent(e, { verbose, showModelText });
    if (text === null) continue;
    for (const [i, line] of text.split('\n').entries()) lines.push({ key: `${e.sequence}-${i}`, text: `${i === 0 ? e.timestamp.slice(11, 19) : '        '} ${line}`, color: eventColor(e.type) });
  }
  return (
    <Box flexDirection="column">
      {window(lines, height, offset).map((l) => (
        <Text key={l.key} color={l.color} wrap="truncate-end">
          {l.text}
        </Text>
      ))}
      {lines.length === 0 ? <Text dimColor>no events for filter "{filter}"</Text> : null}
    </Box>
  );
}

function Diff({ s, height, offset }: { s: TuiSnapshot; height: number; offset: number }): ReactNode {
  const lines = s.diff.split('\n');
  const start = Math.min(offset, Math.max(0, lines.length - height));
  const rejected = s.events.filter((e) => e.type === 'tool.rejected' && (e.payload as { name?: string }).name === 'propose_patch');
  return (
    <Box flexDirection="column">
      {s.diff.trim() === '' ? <Text dimColor>no changes yet</Text> : null}
      {lines.slice(start, start + height - rejected.length).map((line, i) => (
        <Text key={i} color={line.startsWith('+') ? 'green' : line.startsWith('-') ? 'red' : line.startsWith('@@') ? 'cyan' : undefined} wrap="truncate-end">
          {line}
        </Text>
      ))}
      {rejected.map((e) => (
        <Text key={e.eventId} color="red">
          policy rejected {String((e.payload as { path?: string }).path ?? '')}: {String((e.payload as { reasonCode?: string }).reasonCode)}
        </Text>
      ))}
    </Box>
  );
}

function Checks({ s }: { s: TuiSnapshot }): ReactNode {
  return (
    <Box flexDirection="column">
      {s.checks.map((c) => (
        <Text key={c.checkRunId} color={c.status === 'PASS' ? 'green' : c.status === 'RUNNING' ? 'yellow' : 'red'}>
          {c.attempt === 0 ? 'agent   ' : `verify ${c.attempt}`} {c.checkId.padEnd(16)} {c.status.padEnd(8)} exit {c.exitCode ?? '-'}
        </Text>
      ))}
      {s.checks.length === 0 ? <Text dimColor>no checks have run</Text> : null}
      {s.verification ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>
            Verification {s.verification.attempt}: {s.verification.result} — {s.verification.summary}
          </Text>
          {s.verification.requirements.map((r) => (
            <Text key={r.id} color={r.status === 'VERIFIED' ? 'green' : r.status === 'FAILED' ? 'red' : 'yellow'}>
              {r.id} {r.status}: {r.note}
            </Text>
          ))}
          {s.verification.violations.map((v) => (
            <Text key={`${v.path}-${v.code}`} color="red">
              {v.code} {v.path}: {v.detail}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function Costs({ s }: { s: TuiSnapshot }): ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold>{'PHASE          MODEL               INPUT  OUTPUT CACHE_W CACHE_R     COST  EST.MAX'}</Text>
      {s.usage.map((u) => (
        <Text key={u.requestId}>
          {u.phase.padEnd(14)} {u.modelId.padEnd(18)} {String(u.input).padStart(6)} {String(u.output).padStart(7)} {String(u.cacheWrite).padStart(7)} {String(u.cacheRead).padStart(7)} {usd(u.costUsd).padStart(8)} {u.estimatedUsd !== null ? usd(u.estimatedUsd).padStart(8) : '       -'}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text>
          implementation {usd(s.spent.implementation)} / {usd(s.contract?.budgetUsd ?? 0)} · PR drafting {usd(s.spent.pr)} / {usd(s.contract?.prBudgetUsd ?? 0)}
        </Text>
      </Box>
    </Box>
  );
}

function PromptView({ pending, typing }: { pending: PendingPrompt; typing: string | null }): ReactNode {
  switch (pending.kind) {
    case 'contract':
      return (
        <Box flexDirection="column">
          {formatContract(
            { contract: pending.prompt.contract, version: pending.prompt.version, sha256: pending.prompt.sha256, findings: pending.prompt.findings, notes: pending.prompt.notes, ...(pending.prompt.existingPaths ? { existingPaths: new Set(pending.prompt.existingPaths) } : {}) },
            createStyle(true, (process.stdout.columns ?? 100) - 2),
          )
            .split('\n')
            .map((l, i) => (
              <Text key={i}>{l}</Text>
            ))}
          <Text>[a] approve · [r] reject · [d] decide later (edit the contract with the text UI: run without --tui)</Text>
        </Box>
      );
    case 'question':
      return (
        <Box flexDirection="column">
          <Text bold color="yellow">
            [?] {pending.prompt.question}
          </Text>
          <Text dimColor>
            why: {pending.prompt.reason} {pending.prompt.requirementIds.length > 0 ? `(${pending.prompt.requirementIds.join(', ')})` : ''}
          </Text>
          {pending.prompt.choices.map((c, i) => (
            <Text key={i}>
              {i + 1}) {c}
            </Text>
          ))}
          {typing !== null ? <Text>{`> ${typing}█`}</Text> : <Text>[1-9] choose · [t] type an answer · [d] answer later</Text>}
        </Box>
      );
    case 'scope':
      return (
        <Box flexDirection="column">
          <Text bold color="yellow">
            [?] Scope change: write access to {pending.prompt.additionalPaths.join(', ')}
          </Text>
          <Text>reason: {pending.prompt.reason}</Text>
          <Text dimColor>currently writable: {pending.prompt.currentWritable.join(', ')}</Text>
          <Text>[y] approve new contract revision · [n] deny · [d] decide later</Text>
        </Box>
      );
    case 'confirm':
      return (
        <Box flexDirection="column">
          {pending.prompt.details ? <Text>{pending.prompt.details}</Text> : null}
          <Text bold color="yellow">
            {pending.prompt.message} [y/n]
          </Text>
        </Box>
      );
  }
}

function Questions({ s, pending, typing }: { s: TuiSnapshot; pending: PendingPrompt | null; typing: string | null }): ReactNode {
  if (pending) return <PromptView pending={pending} typing={typing} />;
  return (
    <Box flexDirection="column">
      {s.questions.length === 0 ? <Text dimColor>no open questions</Text> : null}
      {s.questions.map((q) => (
        <Text key={q.questionId} color="yellow">
          {q.questionId}: {q.payload.type === 'question' ? q.payload.question : `scope change → ${q.payload.additionalPaths.join(', ')}`} — answer with `aperture answer {s.run.runId} {q.questionId}`
        </Text>
      ))}
    </Box>
  );
}

/** Six-panel run view (§10). Renders persisted state only; never shows hidden reasoning. */
export function App({ load, interaction, pollMs = 400, initialShowModelText = false, onQuit, onBack }: AppProps): ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [snapshot, setSnapshot] = useState<TuiSnapshot>(() => load());
  const [tab, setTab] = useState<Tab>('Overview');
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [verbose, setVerbose] = useState(false);
  const [showModelText, setShowModelText] = useState(initialShowModelText);
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<PendingPrompt | null>(interaction?.pending ?? null);
  const [typing, setTyping] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      try {
        setSnapshot(load());
      } catch {
        // keep the last good snapshot
      }
    }, pollMs);
    return () => clearInterval(timer);
  }, [load, pollMs]);

  useEffect(() => {
    if (!interaction) return undefined;
    return interaction.subscribe(() => {
      setPending(interaction.pending);
      setTyping(null);
      if (interaction.pending) setTab('Questions');
    });
  }, [interaction]);

  useInput((input, key) => {
    if (pending && typing !== null) {
      if (key.return) {
        if (pending.kind === 'question' && typing.trim()) pending.resolve({ answer: typing.trim() });
        setTyping(null);
      } else if (key.escape) setTyping(null);
      else if (key.backspace || key.delete) setTyping(typing.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setTyping(typing + input);
      return;
    }
    if (pending) {
      if (pending.kind === 'contract') {
        if (input === 'a') return pending.resolve({ action: 'approve' });
        if (input === 'r') return pending.resolve({ action: 'reject', reason: 'rejected in TUI' });
        if (input === 'd') return pending.resolve(null);
      } else if (pending.kind === 'question') {
        const n = Number(input);
        if (Number.isInteger(n) && n >= 1 && n <= pending.prompt.choices.length) return pending.resolve({ answer: pending.prompt.choices[n - 1]!, choiceIndex: n - 1 });
        if (input === 't') return setTyping('');
        if (input === 'd') return pending.resolve(null);
      } else if (pending.kind === 'scope') {
        if (input === 'y') return pending.resolve({ approved: true, rationale: 'approved in TUI' });
        if (input === 'n') return pending.resolve({ approved: false, rationale: 'denied in TUI' });
        if (input === 'd') return pending.resolve(null);
      } else if (pending.kind === 'confirm') {
        if (input === 'y') return pending.resolve(true);
        if (input === 'n') return pending.resolve(false);
      }
    }
    if (onBack && !pending && (input === 'q' || key.escape)) {
      onBack();
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) {
      interaction?.dismiss();
      onQuit();
      exit();
      return;
    }
    const index = Number(input);
    if (Number.isInteger(index) && index >= 1 && index <= TABS.length && !pending) {
      setTab(TABS[index - 1]!);
      setOffset(0);
    }
    if (key.tab || key.rightArrow) setTab(TABS[(TABS.indexOf(tab) + 1) % TABS.length]!);
    if (key.leftArrow) setTab(TABS[(TABS.indexOf(tab) + TABS.length - 1) % TABS.length]!);
    if (input === 'f') setFilter(ACTIVITY_FILTERS[(ACTIVITY_FILTERS.indexOf(filter) + 1) % ACTIVITY_FILTERS.length]!);
    if (input === 'v') setVerbose(!verbose);
    if (input === 'm') setShowModelText(!showModelText);
    if (key.upArrow) setOffset(tab === 'Diff' ? Math.max(0, offset - 1) : offset + 1);
    if (key.downArrow) setOffset(tab === 'Diff' ? offset + 1 : Math.max(0, offset - 1));
  });

  const height = Math.max(8, ((stdout as NodeJS.WriteStream).rows ?? 30) - 7);
  const s = snapshot;
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>RUN </Text>
        {s.run.runId}
        {'  '}
        <Text bold>STATE </Text>
        <Text color={stateColor(s.run.state)}>{s.run.state}</Text>
        {'  '}
        <Text bold>MODEL </Text>
        {s.run.modelId}
      </Text>
      <Text>
        {TABS.map((t, i) => (
          <Text key={t} inverse={t === tab}>
            {` ${i + 1} ${t}${t === 'Questions' && (s.questions.length > 0 || pending) ? ' (!)' : ''} `}
          </Text>
        ))}
      </Text>
      <Box flexDirection="column" height={height} overflow="hidden">
        {tab === 'Overview' ? <Overview s={s} /> : null}
        {tab === 'Activity' ? <Activity s={s} filter={filter} verbose={verbose} showModelText={showModelText} height={height} offset={offset} /> : null}
        {tab === 'Diff' ? <Diff s={s} height={height} offset={offset} /> : null}
        {tab === 'Checks' ? <Checks s={s} /> : null}
        {tab === 'Costs' ? <Costs s={s} /> : null}
        {tab === 'Questions' ? <Questions s={s} pending={pending} typing={typing} /> : null}
      </Box>
      <Text dimColor>
        1-6/tab panels · f filter [{filter}] · v verbose [{verbose ? 'on' : 'off'}] · m model text [{showModelText ? 'on' : 'off'}] · ↑↓ scroll · q {onBack ? 'back to runs' : interaction ? 'interrupt' : 'detach'}
      </Text>
    </Box>
  );
}
