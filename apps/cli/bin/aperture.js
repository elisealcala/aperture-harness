#!/usr/bin/env node
// Entry shim: hide node:sqlite's ExperimentalWarning, then load the TypeScript CLI through tsx.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function emitWarning(warning, ...rest) {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (/SQLite is an experimental feature/.test(text)) return;
  return originalEmitWarning.call(process, warning, ...rest);
};

const { register } = await import('tsx/esm/api');
register();
const { main } = await import('../src/main.ts');
process.exitCode = await main(process.argv);
