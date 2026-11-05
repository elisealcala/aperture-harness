import type { ContractFinding, ExecutionContract } from '@aperture/contracts';
import { banner, createStyle, heading, wrap, type Style } from './style.ts';

export interface ContractViewInput {
  contract: ExecutionContract;
  version: number;
  sha256: string;
  findings?: readonly ContractFinding[];
  notes?: readonly string[];
  /** Tracked files at the baseline; writable paths outside it are marked as new. */
  existingPaths?: ReadonlySet<string>;
}

function sourceLabel(contract: ExecutionContract): string {
  const s = contract.metadata.source;
  if (s.type === 'github') return `github:${s.repository}#${s.issueNumber}`;
  if (s.type === 'linear') return `linear:${s.issueId}${s.repository ? ` → ${s.repository}` : ''}`;
  return 'local contract';
}

function usd(v: number): string {
  return `$${v.toFixed(2)}`;
}

/** Splits `CODE: message` notes from the compiler so the code can be highlighted. */
function splitNote(note: string): { code: string | null; text: string } {
  const m = /^([A-Z][A-Z_]+):\s*(.*)$/s.exec(note);
  return m ? { code: m[1]!, text: m[2]! } : { code: null, text: note };
}

/**
 * Sectioned, color-coded rendering of a contract for approval. Scope is the part reviewers most need
 * to get right, so writable paths are green, denied paths red, and any network grant yellow.
 */
export function formatContract(input: ContractViewInput, style: Style = createStyle()): string {
  const { contract } = input;
  const { spec, metadata } = contract;
  const w = style.width;
  const out: string[] = [];

  out.push(
    banner(style, `Contract v${input.version} · ${metadata.id}`, [
      style('bold', wrap(metadata.title, w - 6, 2)),
      `${style('gray', 'source')} ${sourceLabel(contract)}   ${style('gray', 'baseline')} ${metadata.baselineRef}   ${style('gray', 'sha256')} ${style('dim', input.sha256.slice(0, 16))}`,
    ]),
  );

  out.push('', heading(style, 'GOAL'), `  ${wrap(spec.goal, w - 2, 2)}`);

  out.push('', heading(style, 'REQUIREMENTS', style('gray', `(${spec.requirements.length})`)));
  for (const r of spec.requirements) {
    const text = r.text.includes('__EDIT_ME__') ? style(['yellow', 'bold'], wrap(r.text, w - 8, 7)) : wrap(r.text, w - 8, 7);
    out.push(`  ${style(['bold', 'cyan'], r.id.padEnd(4))} ${text}`);
  }

  out.push('', heading(style, 'SCOPE'));
  out.push(`  ${style(['bold', 'green'], 'writable')}  ${style('gray', 'the only files the agent may change')}`);
  for (const p of spec.scope.writable) {
    const isNew = input.existingPaths ? !input.existingPaths.has(p) && !/[*?[{]/.test(p) : false;
    const label = p.includes('__EDIT_ME__') ? style(['yellow', 'bold'], p) : style('green', p);
    out.push(`    ${style('green', '✎')} ${label}${isNew ? ` ${style('yellow', '(new file)')}` : ''}`);
  }
  out.push(`  ${style('bold', 'readable')}  ${style('gray', 'in addition to the writable files')}`);
  if (spec.scope.readable.length === 0) out.push(`    ${style('gray', '(writable files only)')}`);
  for (const p of spec.scope.readable) out.push(`    ${style('gray', '◦')} ${p}`);
  out.push(`  ${style(['bold', 'red'], 'denied')}    ${style('gray', 'never readable or writable; always wins')}`);
  out.push(`    ${style('red', wrap(spec.scope.denied.join('  '), w - 6, 4)) || style('gray', '(none)')}`);

  out.push('', heading(style, 'PERMISSIONS'));
  const network = spec.permissions.network;
  out.push(
    network === 'deny'
      ? `  ${style('gray', 'network')}       ${style('green', 'none')}`
      : `  ${style('gray', 'network')}       ${style(['yellow', 'bold'], 'allowlist')} ${style('yellow', network.hosts.join(', '))} ${style('gray', `(${network.phases.join(', ')} only; the model never has network)`)}`,
  );
  out.push(`  ${style('gray', 'dependencies')}  ${spec.permissions.dependencies}    ${style('gray', 'shell')} ${spec.permissions.shell}    ${style('gray', 'issues')} ${spec.permissions.issueWrites}    ${style('gray', 'pull request')} ${spec.permissions.pullRequestCreate}`);

  out.push('', heading(style, 'CHECKS', style('gray', `(${spec.checks.length})`)));
  if (spec.checks.length === 0) out.push(`  ${style('yellow', '▲ none declared: every requirement will stay UNVERIFIED and need manual review')}`);
  for (const check of spec.checks) {
    const command = spec.commands[check.commandId];
    const cmd = command ? [command.exec, ...command.args].join(' ') : style('gray', `(${check.commandId} from user config)`);
    out.push(`  ${check.required ? style('bold', '●') : style('gray', '○')} ${style('bold', check.id.padEnd(14))} ${check.required ? 'required' : style('gray', 'optional')}  ${style('cyan', cmd)}`);
    if (check.covers) out.push(`      ${style('gray', 'covers')} ${check.covers.join(', ')}`);
    for (const [name, value] of Object.entries(command?.env ?? {})) {
      out.push(`      ${style('gray', 'env')} ${name} ${'value' in value ? `= ${value.value}` : style('yellow', `← $${value.fromEnv}${value.secret ? ' (secret)' : ''}`)}`);
    }
  }

  out.push('', heading(style, 'LIMITS & MODELS'));
  const l = spec.limits;
  out.push(`  ${style('gray', 'budget')}  ${style('bold', usd(l.maxCostUsd))} implementation · ${usd(l.prBudgetUsd)} PR draft    ${style('gray', 'caps')} ${l.maxModelTurns} turns · ${l.maxPatchAttempts} patches · ${l.maxVerificationAttempts} verifications · ${l.maxWallClockMinutes} min`);
  out.push(`  ${style('gray', 'models')}  ${spec.models.implement} (implement) · ${spec.models.prDraft} (PR)    ${style('gray', 'cache')} ${spec.cache.enabled ? spec.cache.ttl : 'off'}`);

  const notes = input.notes ?? [];
  const findings = input.findings ?? [];
  if (notes.length + findings.length > 0) {
    out.push('', heading(style, 'REVIEW NOTES'));
    for (const f of findings.filter((x) => x.level === 'error')) out.push(`  ${style(['red', 'bold'], `✗ ${f.code}`)} ${wrap(f.message, w - f.code.length - 6, 4)}`);
    for (const f of findings.filter((x) => x.level === 'warning')) out.push(`  ${style('yellow', `▲ ${f.code}`)} ${wrap(f.message, w - f.code.length - 6, 4)}`);
    for (const note of notes) {
      const { code, text } = splitNote(note);
      out.push(`  ${style('cyan', `ℹ ${code ?? 'NOTE'}`)} ${wrap(text, w - (code ?? 'NOTE').length - 6, 4)}`);
    }
  }
  return out.join('\n');
}
