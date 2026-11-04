import { Orchestrator, type Executor, type Harness, type Interaction, type PreauthorizedAnswer } from '@aperture/core';
import type { RunRecord } from '@aperture/storage';
import { createInteraction, PreapprovedContract } from '../interaction/factory.ts';
import { defaultActor } from '../interaction/readline.ts';
import type { TextRenderOptions } from '../render/text.ts';
import { InkInteraction } from '../tui/interaction.ts';
import { startTui } from '../tui/index.tsx';
import { attachRenderer } from './run.ts';

export interface DriveUiOptions {
  executor: Executor;
  interactive: boolean;
  preapproveContract: boolean;
  tui?: boolean;
  preauthorized?: readonly PreauthorizedAnswer[];
  render: TextRenderOptions & { quiet?: boolean };
  mode: 'drive' | 'resume';
}

/**
 * Runs the orchestrator with either the streaming text renderer + readline prompts, or the Ink TUI
 * (`--tui`, interactive terminals only). Ctrl-C / `q` interrupts without losing persisted state.
 */
export async function driveWithUi(harness: Harness, runId: string, options: DriveUiOptions): Promise<RunRecord> {
  const controller = new AbortController();
  const useTui = Boolean(options.tui) && options.interactive && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  let interaction: Interaction;
  let cleanup: () => void;
  if (useTui) {
    const ink = new InkInteraction(defaultActor());
    interaction = options.preapproveContract ? new PreapprovedContract(ink) : ink;
    const tui = startTui(harness, () => runId, { interaction: ink, ...(options.render.showModelText !== undefined ? { showModelText: options.render.showModelText } : {}), onQuit: () => controller.abort() });
    cleanup = () => tui.close();
  } else {
    const choice = createInteraction({ interactive: options.interactive, preapproveContract: options.preapproveContract });
    interaction = choice.interaction;
    const detach = attachRenderer(harness, options.render);
    cleanup = () => {
      choice.close();
      detach();
    };
  }
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130);
    if (!useTui) process.stderr.write('\ninterrupting… (state is persisted; continue with `aperture resume <run-id>`)\n');
    controller.abort();
  };
  process.on('SIGINT', onSigint);
  try {
    const orchestrator = new Orchestrator(harness);
    const drive = { executor: options.executor, interaction, signal: controller.signal, ...(options.preauthorized ? { preauthorized: options.preauthorized } : {}) };
    return options.mode === 'resume' ? await orchestrator.resume(runId, drive) : await orchestrator.drive(runId, drive);
  } finally {
    process.off('SIGINT', onSigint);
    cleanup();
  }
}
