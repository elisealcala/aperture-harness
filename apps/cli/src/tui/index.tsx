import { render } from 'ink';
import type { Harness } from '@aperture/core';
import { App } from './App.tsx';
import { RunBrowser } from './RunBrowser.tsx';
import type { InkInteraction } from './interaction.ts';
import { loadSnapshot } from './model.ts';

export interface TuiHandle {
  /** Stops rendering and restores the terminal. */
  close(): void;
  waitUntilExit(): Promise<unknown>;
}

export function startTui(harness: Harness, runId: () => string | undefined, options: { interaction?: InkInteraction; showModelText?: boolean; onQuit: () => void }): TuiHandle {
  const load = () => {
    const id = runId();
    if (!id) throw new Error('run not created yet');
    return loadSnapshot(harness, id);
  };
  const instance = render(<App load={load} {...(options.interaction ? { interaction: options.interaction } : {})} initialShowModelText={options.showModelText ?? false} onQuit={options.onQuit} />, {
    exitOnCtrlC: false,
  });
  return {
    close: () => instance.unmount(),
    waitUntilExit: () => instance.waitUntilExit(),
  };
}

/** Full-screen run browser (`aperture ui`): run list → per-run panels → back. Read-only. */
export function startRunBrowser(harness: Harness, options: { initialRunId?: string } = {}): TuiHandle {
  const instance = render(
    <RunBrowser listRuns={() => harness.store.runSummaries(200)} loadRun={(id) => loadSnapshot(harness, id)} {...(options.initialRunId ? { initialRunId: options.initialRunId } : {})} />,
    { exitOnCtrlC: false },
  );
  return { close: () => instance.unmount(), waitUntilExit: () => instance.waitUntilExit() };
}
