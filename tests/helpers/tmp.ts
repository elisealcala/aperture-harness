import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Tracks temporary directories created by a test file so they can be removed in `afterEach` /
 * `afterAll`. Paths are realpath'd (macOS `/var` -> `/private/var`) so they compare equal to paths
 * the harness resolves itself.
 */
export class TempDirs {
  private readonly dirs: string[] = [];

  make(prefix = 'aperture-test-'): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    this.dirs.push(dir);
    return dir;
  }

  cleanup(): void {
    for (const dir of this.dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
}
