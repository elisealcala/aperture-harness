import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useEffect, useState, type ReactNode } from 'react';
import type { RunSummary } from '@aperture/storage';
import { App } from './App.tsx';
import type { TuiSnapshot } from './model.ts';
import { clampSelection, filterRuns, relativeTime, stateColor, truncate, visibleWindow } from './runs-model.ts';

export interface RunBrowserProps {
  listRuns: () => RunSummary[];
  loadRun: (runId: string) => TuiSnapshot;
  pollMs?: number;
  /** Open this run directly (still returns to the list on q/Esc). */
  initialRunId?: string;
}

/**
 * Run list → six-panel run view. Read-only: it renders persisted state and never drives a run, so it
 * is safe to keep open next to an active `aperture run`.
 */
export function RunBrowser({ listRuns, loadRun, pollMs = 1000, initialRunId }: RunBrowserProps): ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [runs, setRuns] = useState<RunSummary[]>(() => listRuns());
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | undefined>(initialRunId);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (openRunId) return undefined;
    const timer = setInterval(() => {
      try {
        setRuns(listRuns());
        setNow(Date.now());
      } catch {
        // keep the last good list
      }
    }, pollMs);
    return () => clearInterval(timer);
  }, [listRuns, pollMs, openRunId]);

  const visible = filterRuns(runs, query);
  const current = clampSelection(selected, visible.length);

  useInput(
    (input, key) => {
      if (editing) {
        if (key.return || key.escape) setEditing(false);
        if (key.escape) setQuery('');
        else if (key.backspace || key.delete) setQuery(query.slice(0, -1));
        else if (input && !key.ctrl && !key.meta && !key.return) setQuery(query + input);
        setSelected(0);
        return;
      }
      if (input === 'q' || (key.ctrl && input === 'c')) {
        exit();
        return;
      }
      if (input === '/') {
        setEditing(true);
        return;
      }
      if (key.escape && query) {
        setQuery('');
        return;
      }
      if (key.upArrow || input === 'k') setSelected(Math.max(0, current - 1));
      if (key.downArrow || input === 'j') setSelected(clampSelection(current + 1, visible.length));
      if (key.pageUp) setSelected(Math.max(0, current - 10));
      if (key.pageDown) setSelected(clampSelection(current + 10, visible.length));
      if (input === 'g') setSelected(0);
      if (input === 'G') setSelected(Math.max(0, visible.length - 1));
      if (input === 'r') setRuns(listRuns());
      if (key.return && visible[current]) setOpenRunId(visible[current]!.runId);
    },
    { isActive: !openRunId },
  );

  if (openRunId) {
    return (
      <App
        load={() => loadRun(openRunId)}
        onQuit={() => undefined}
        onBack={() => {
          setOpenRunId(undefined);
          setRuns(listRuns());
        }}
      />
    );
  }

  const columns = (stdout as NodeJS.WriteStream).columns ?? 100;
  const height = Math.max(5, ((stdout as NodeJS.WriteStream).rows ?? 30) - 9);
  const { start, end } = visibleWindow(current, visible.length, height);
  const titleWidth = Math.max(20, columns - 46);
  const chosen = visible[current];

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>RUNS </Text>
        <Text dimColor>
          {visible.length === runs.length ? `${runs.length}` : `${visible.length} of ${runs.length}`} · ↑↓ select · enter open · / filter · r refresh · q quit
        </Text>
      </Text>
      <Text>
        {editing || query ? (
          <Text color={editing ? 'cyan' : undefined}>
            filter: {query}
            {editing ? '█' : ''}
          </Text>
        ) : (
          <Text dimColor> </Text>
        )}
      </Text>
      <Text bold>{`  ${'STATE'.padEnd(22)} ${'COST'.padStart(7)}  ${'WHEN'.padEnd(9)} TITLE`}</Text>
      {visible.length === 0 ? <Text dimColor>{runs.length === 0 ? '  no runs yet — start one with `aperture run <task>`' : '  no runs match the filter'}</Text> : null}
      {visible.slice(start, end).map((run, i) => {
        const index = start + i;
        const isSelected = index === current;
        return (
          <Text key={run.runId} inverse={isSelected}>
            {isSelected ? '▶ ' : '  '}
            <Text color={stateColor(run.state)}>{run.state.padEnd(22)}</Text> {`$${run.costUsd.toFixed(3)}`.padStart(7)}  {relativeTime(run.startedAt, now).padEnd(9)} {truncate(run.title, titleWidth)}
          </Text>
        );
      })}
      {chosen ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            {chosen.runId} · {chosen.sourceRef} · {chosen.workspace}
            {chosen.branch ? ` ${chosen.branch}` : ''} · {chosen.modelId}
          </Text>
          {chosen.terminalReason ? <Text color={stateColor(chosen.state)}>{truncate(chosen.terminalReason, columns - 2)}</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
}
