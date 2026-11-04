import { ScriptedExecutor, type Executor, type Harness } from '@aperture/core';

export interface ExecutorOptions {
  script?: string;
}

export function createExecutor(_harness: Harness, options: ExecutorOptions): Executor {
  if (options.script) return ScriptedExecutor.fromFile(options.script);
  throw new Error('no model executor is configured yet; pass --script <steps.yaml> to replay tool calls');
}
