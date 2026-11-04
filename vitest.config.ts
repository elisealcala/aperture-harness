import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
// Workspace packages export TypeScript source; map @aperture/* so root-level tests resolve them.
const alias = Object.fromEntries(
  readdirSync(`${root}packages`).map((name) => [`@aperture/${name}`, `${root}packages/${name}/src/index.ts`]),
);

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
