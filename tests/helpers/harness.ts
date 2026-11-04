import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseContract, parseUserConfig } from '../../packages/contracts/src/index.ts';
import { Harness } from '../../packages/core/src/index.ts';
import type { ContractInput } from '../../packages/contracts/src/index.ts';
import { createFixtureRepo, type FixtureRepo } from './repo.ts';
import type { TempDirs } from './tmp.ts';

export interface FixtureContractOptions {
  /** Extra `spec.commands` entries merged into the defaults. */
  extraCommands?: Record<string, { exec: string; args: string[]; timeoutSeconds?: number }>;
  /** Extra `spec.checks` entries appended to the defaults. */
  extraChecks?: Array<{ id: string; commandId: string; required: boolean }>;
}

/**
 * The contract used against the fixture repo: only `src/api/session.ts` (and its test) writable,
 * `src/**` + `test/**` readable, `package.json` / `.env*` / `**\/secrets/**` denied. Checks:
 * `unit` (required, passes at baseline) and `has-metadata` (not required, fails until the
 * permitted patch lands).
 */
export function fixtureContract(options: FixtureContractOptions = {}): ContractInput {
  return {
    apiVersion: 'aperture.dev/v1',
    kind: 'ExecutionContract',
    metadata: { id: 'LOCAL-142', source: { type: 'local' }, baselineRef: 'HEAD', title: 'Add optional session metadata' },
    spec: {
      goal: 'Accept and forward optional session metadata without changing existing behavior',
      requirements: [
        { id: 'R1', text: 'Accept an optional metadata field' },
        { id: 'R2', text: 'Preserve compatibility when omitted' },
      ],
      scope: {
        writable: ['src/api/session.ts', 'src/api/session.test.ts'],
        readable: ['src/**', 'test/**'],
        denied: ['package.json', 'pnpm-lock.yaml', '.env*', '**/secrets/**'],
      },
      commands: {
        unit: { exec: 'node', args: ['--test', 'test/session.test.mjs'], timeoutSeconds: 60 },
        'has-metadata': { exec: 'node', args: ['test/check-metadata.mjs'], timeoutSeconds: 60 },
        ...(options.extraCommands ?? {}),
      },
      checks: [
        { id: 'unit', commandId: 'unit', required: true },
        { id: 'has-metadata', commandId: 'has-metadata', required: false },
        ...(options.extraChecks ?? []),
      ],
      limits: { maxModelTurns: 12, maxPatchAttempts: 8, maxCostUsd: 0.5, maxWallClockMinutes: 30 },
    },
  };
}

export interface HarnessFixture {
  root: string;
  repo: FixtureRepo;
  storageDir: string;
  contractPath: string;
  harness: Harness;
}

/** Temp dir layout: `<root>/repo` (git), `<root>/contract.yaml`, and a separate storage dir. */
export function createHarnessFixture(tmp: TempDirs, contract: ContractInput = fixtureContract()): HarnessFixture {
  const root = tmp.make('aperture-repo-');
  const storageDir = tmp.make('aperture-storage-');
  const repo = createFixtureRepo(root);
  const harness = new Harness({ config: parseUserConfig({}), storageDir });
  const contractPath = join(root, 'contract.yaml');
  writeFileSync(contractPath, harness.contractYaml(parseContract(contract)));
  return { root, repo, storageDir, contractPath, harness };
}
