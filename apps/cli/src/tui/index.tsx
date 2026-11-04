import { render } from 'ink';
import type { Harness } from '@aperture/core';
import { App } from './App.tsx';
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
