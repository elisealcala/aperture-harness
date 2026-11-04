import type { ContractInput } from '../../packages/contracts/src/index.ts';

/**
 * A small, valid contract input (pre-defaults). Tests clone it and change one field to exercise a
 * single validation branch.
 */
export function validContractInput(): ContractInput {
  return {
    apiVersion: 'aperture.dev/v1',
    kind: 'ExecutionContract',
    metadata: {
      id: 'LOCAL-1',
      source: { type: 'local' },
      baselineRef: 'HEAD',
      title: 'Add optional session metadata',
    },
    spec: {
      goal: 'Accept optional session metadata',
      requirements: [
        { id: 'R1', text: 'Accept an optional metadata field' },
        { id: 'R2', text: 'Preserve compatibility when omitted' },
      ],
      scope: {
        writable: ['src/api/session.ts'],
        readable: ['src/**'],
        denied: ['package.json', '.env*', '**/secrets/**'],
      },
      commands: {
        unit: { exec: 'node', args: ['--test'], timeoutSeconds: 60 },
      },
      checks: [{ id: 'unit', commandId: 'unit', required: true, covers: ['R1'] }],
    },
  };
}

/**
 * Returns a clone of the valid contract with the value at `path` replaced (or added). The result is
 * `unknown` on purpose: it is fed to the parser, which is what decides whether it is valid.
 */
export function contractWith(path: ReadonlyArray<string | number>, value: unknown): unknown {
  const root = structuredClone(validContractInput()) as unknown as Record<string | number, unknown>;
  let node: Record<string | number, unknown> = root;
  for (const key of path.slice(0, -1)) {
    node = node[key] as Record<string | number, unknown>;
  }
  node[path[path.length - 1]!] = value;
  return root;
}
