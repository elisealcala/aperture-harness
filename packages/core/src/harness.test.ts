import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseUserConfig } from '../../contracts/src/index.ts';
import { prepareRun, type PreparedRun } from '../../../tests/helpers/harness.ts';
import { TempDirs } from '../../../tests/helpers/tmp.ts';
import { Harness } from './harness.ts';

const tmp = new TempDirs();
let p: PreparedRun | undefined;
let extra: Harness | undefined;

afterEach(() => {
  extra?.close();
  extra = undefined;
  p?.fx.harness.close();
  p = undefined;
  tmp.cleanup();
});

describe('Harness extraHiddenPaths', () => {
  it('appends extraHiddenPaths to the sandbox hiddenPaths of createRunner', async () => {
    p = await prepareRun(tmp);
    const secretDir = tmp.make('aperture-secrets-');
    const hidden = [join(secretDir, '.env'), join(secretDir, 'other.env')];
    p.fx.harness.close();
    extra = new Harness({ config: parseUserConfig({}), storageDir: p.fx.storageDir, extraHiddenPaths: hidden });
    // The fixture's harness is already closed; avoid closing it twice.
    p.fx.harness = extra;
    extra = undefined;

    const withExtra = p.fx.harness.createRunner(p.fx.harness.getRun(p.run.runId)).effectivePolicy.hiddenPaths;
    expect(withExtra.slice(-hidden.length)).toEqual(hidden);
    expect(withExtra).toContain(join(p.fx.storageDir, 'runs'));
  });

  it('adds nothing beyond the defaults when extraHiddenPaths is omitted', async () => {
    p = await prepareRun(tmp);
    const base = p.fx.harness.createRunner(p.run).effectivePolicy.hiddenPaths;
    expect(base.at(-1)).toBe(join(p.fx.storageDir, 'runs'));
  });
});
