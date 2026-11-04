import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { ApprovedContract } from '@aperture/contracts';
import type { PauseRequest, ToolGateway } from '@aperture/gateway';
import type { RunRecord } from '@aperture/storage';
import type { Harness } from './harness.ts';

export interface ExecutionContext {
  harness: Harness;
  run: RunRecord;
  contract: ApprovedContract;
  gateway: ToolGateway;
  signal: AbortSignal;
}

export type ExecutorOutcome =
  | { type: 'candidate'; summary?: string }
  | { type: 'paused'; pause: PauseRequest }
  | { type: 'blocked'; code: string; reason: string }
  | { type: 'failed'; reason: string }
  | { type: 'interrupted'; reason?: string };

/** A replaceable execution worker. It proposes; the harness decides. */
export interface Executor {
  readonly modelId: string;
  run(ctx: ExecutionContext): Promise<ExecutorOutcome>;
}

export interface ScriptStep {
  tool: string;
  input: unknown;
}

/**
 * Replays a fixed list of tool calls through the gateway. Used for the Phase 1 vertical slice,
 * adversarial tests, and offline dry runs. Tool call ids are deterministic (`script_<n>`), so a
 * resumed run receives the recorded results for steps that already executed instead of re-running them.
 */
export class ScriptedExecutor implements Executor {
  readonly modelId = 'scripted';

  constructor(private readonly steps: readonly ScriptStep[]) {}

  static fromFile(path: string): ScriptedExecutor {
    const raw = parseYaml(readFileSync(path, 'utf8')) as unknown;
    const steps = (Array.isArray(raw) ? raw : (raw as { steps?: unknown })?.steps) as unknown;
    if (!Array.isArray(steps)) throw new Error(`script ${path} must be a list of {tool, input} steps`);
    return new ScriptedExecutor(steps.map((s, i) => {
      const step = s as Partial<ScriptStep>;
      if (typeof step.tool !== 'string') throw new Error(`script step ${i} is missing "tool"`);
      return { tool: step.tool, input: step.input ?? {} };
    }));
  }

  async run(ctx: ExecutionContext): Promise<ExecutorOutcome> {
    for (const [index, step] of this.steps.entries()) {
      if (ctx.signal.aborted) return { type: 'interrupted' };
      const id = `script_${index}`;
      const outcome = await ctx.gateway.execute({ id, name: step.tool, input: step.input });
      // Pauses resolved earlier were recorded by the gateway and come back as plain results.
      if (outcome.kind === 'pause') {
        if (outcome.pause.type === 'blocked') return { type: 'blocked', code: 'AGENT_REPORTED_BLOCKED', reason: outcome.pause.reason };
        return { type: 'paused', pause: outcome.pause };
      }
    }
    return { type: 'candidate', summary: `script completed ${this.steps.length} steps` };
  }
}
