import type { EventEnvelope, EventType } from '@aperture/events';

export interface TextRenderOptions {
  verbose?: boolean;
  showModelText?: boolean;
  color?: boolean;
  /** Restrict output to these event categories (prefix match, e.g. `tool`, `check`, `model`). */
  filters?: readonly string[];
}

const COLORS = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, dim: 2, bold: 1 } as const;

function paint(enabled: boolean | undefined, color: keyof typeof COLORS, text: string): string {
  return enabled ? `\u001b[${COLORS[color]}m${text}\u001b[0m` : text;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

export function usd(value: number): string {
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

function toolTarget(payload: Record<string, unknown>): string {
  const input = (payload.input ?? {}) as Record<string, unknown>;
  return str(payload.path ?? input.path ?? payload.checkId ?? input.checkId ?? input.pattern ?? '');
}

/**
 * Formats one persisted event as a terminal line (or `null` to skip it). The renderer only shows
 * observable model output and tool activity; it never labels model text as internal reasoning.
 */
export function formatEvent(event: EventEnvelope, options: TextRenderOptions = {}): string | null {
  const c = options.color;
  const p = event.payload as Record<string, unknown>;
  if (options.filters && options.filters.length > 0 && !options.filters.some((f) => event.type.startsWith(f))) return null;
  const type: EventType = event.type;
  switch (type) {
    case 'run.created':
      return `${paint(c, 'bold', 'RUN')}  ${event.runId}  ${str(p.sourceRef)}\n${paint(c, 'bold', 'GOAL')} ${str(p.title)}`;
    case 'contract.proposed':
      return `[ ] Contract v${num(p.version)} proposed (sha256 ${str(p.sha256).slice(0, 12)})`;
    case 'contract.approved':
      return paint(c, 'green', `[✓] Contract approved (v${num(p.version)}) by ${str(p.approvedBy)}`);
    case 'contract.rejected':
      return paint(c, 'red', `[✗] Contract rejected: ${str(p.reason)}`);
    case 'contract.amended':
      return paint(c, 'yellow', `[~] Contract amended to v${num(p.version)}: ${str(p.reason)}`);
    case 'state.changed':
      return `${paint(c, 'cyan', 'STATE')} ${str(p.from)} → ${paint(c, 'bold', str(p.to))}${p.reason ? `  ${paint(c, 'dim', str(p.reason))}` : ''}`;
    case 'sandbox.prepared':
      return `[✓] Worktree ${str(p.worktreePath)} @ ${str(p.baselineSha).slice(0, 10)} (isolation: ${str(p.isolation)})`;
    case 'model.request.started':
      return options.verbose ? paint(c, 'dim', `[>] ${str(p.modelId)} turn ${num(p.turn)} (est. ≤ ${usd(num(p.estimatedMaxUsd))})`) : null;
    case 'model.output.delta':
      return options.showModelText ? paint(c, 'dim', `    model: ${str(p.text).replace(/\n/g, '\n           ')}`) : null;
    case 'model.response.completed':
      return options.verbose ? paint(c, 'dim', `[·] model stop: ${str(p.stopReason)}`) : null;
    case 'model.usage.recorded':
      return `Budget: ${usd(num(p.spentUsd))} / ${usd(num(p.budgetUsd))}    Cache reads: ${num(p.cacheRead).toLocaleString('en-US')} tokens    Cache writes: ${num(p.cacheWrite).toLocaleString('en-US')} tokens`;
    case 'tool.requested':
      return options.verbose ? paint(c, 'dim', `[>] ${str(p.name)} ${toolTarget(p)}`) : null;
    case 'tool.approved':
      return null;
    case 'tool.rejected':
      return paint(c, 'red', `[!] Policy denied: ${str(p.name)} ${str(p.path ?? '')} (${str(p.reasonCode)}) ${str(p.message)}`.replace(/\s+/g, ' ').trim());
    case 'tool.completed': {
      const name = str(p.name);
      if (name === 'propose_patch') return paint(c, 'green', `[✓] Patch ${str(p.path)} (+${num(p.added)} -${num(p.removed)}) [${(p.requirementIds as string[] | undefined)?.join(', ') ?? ''}]${p.recovered ? ' (recovered)' : ''}`);
      if (name === 'read_file') return `[✓] Read ${str(p.path)} (${num(p.startLine)}-${num(p.endLine)})`;
      if (name === 'search_code') return `[✓] Search ${JSON.stringify(str(p.pattern))}: ${num(p.matches)} matches`;
      if (name === 'run_check') return null; // check.completed carries it
      return options.verbose ? `[✓] ${name}` : null;
    }
    case 'check.started':
      return `[>] Running ${str(p.checkId)}${num(p.attempt) > 0 ? ` (verification ${num(p.attempt)})` : ''}`;
    case 'check.completed': {
      const ok = p.status === 'PASS';
      const line = `${ok ? '[✓]' : '[✗]'} ${str(p.checkId)} ${str(p.status)} (exit ${str(p.exitCode ?? 'none')}, ${num(p.durationMs)}ms)`;
      return paint(c, ok ? 'green' : 'red', options.verbose && !ok ? `${line}\n${str(p.outputTail)}` : line);
    }
    case 'format.completed':
      if (p.status === 'SKIPPED') return null;
      return paint(c, p.status === 'FORMATTED' ? 'green' : 'yellow', `[${p.status === 'FORMATTED' ? '✓' : '!'}] Formatted ${(p.files as string[] | undefined)?.length ?? 0} file(s) with ${str(p.formatterId)}${p.status === 'FAILED' ? ` — exit ${str(p.exitCode ?? 'none (timed out or killed)')}` : ''}`);
    case 'network.allowed':
      return options.verbose ? paint(c, 'dim', `[·] egress ${str(p.method)} ${str(p.host)}:${num(p.port)} allowed (${str(p.checkId)})`) : null;
    case 'network.denied':
      return paint(c, 'red', `[!] Egress denied: ${str(p.host)}:${num(p.port)} (${str(p.checkId)}) — ${str(p.reason)}`);
    case 'question.asked':
      return paint(c, 'yellow', `[?] Clarification (${str(p.questionId)}): ${str(p.question)}${Array.isArray(p.choices) && p.choices.length > 0 ? `\n    ${(p.choices as string[]).map((ch, i) => `${i + 1}) ${ch}`).join('   ')}` : ''}`);
    case 'question.answered':
      return `[✓] Answered ${str(p.questionId)}: ${str(p.answer)} (${str(p.actor)})`;
    case 'scope.change.requested':
      return paint(c, 'yellow', `[?] Scope change requested (${str(p.questionId)}): ${(p.additionalPaths as string[] | undefined)?.join(', ') ?? ''} — ${str(p.reason)}`);
    case 'scope.change.decided':
      return `${p.approved ? '[✓] Scope change approved' : '[✗] Scope change denied'}${p.rationale ? `: ${str(p.rationale)}` : ''}`;
    case 'verification.started':
      return `[>] Verification attempt ${num(p.attempt)}`;
    case 'verification.completed':
      return paint(c, p.result === 'PASS' ? 'green' : 'yellow', `[${p.result === 'PASS' ? '✓' : '!'}] Verification ${str(p.result)}${p.summary ? `: ${str(p.summary)}` : ''}`);
    case 'budget.warning':
      return paint(c, 'yellow', `[!] Budget warning: ${usd(num(p.spentUsd))} of ${usd(num(p.budgetUsd))} spent`);
    case 'budget.exhausted':
      return paint(c, 'red', `[!] Budget exhausted: ${str(p.reason)}`);
    case 'review.approved':
      return paint(c, 'green', `[✓] Diff approved by ${str(p.actor)}`);
    case 'pr.draft.created':
      return `[✓] PR draft: ${str(p.title)} (${str(p.modelId)}${p.fallback ? ', fallback template' : ''})`;
    case 'pr.approval.requested':
      return `[?] PR publish approval requested`;
    case 'pr.approval.granted':
      return `[✓] PR publish approved by ${str(p.actor)}`;
    case 'pr.published':
      return paint(c, 'green', `[✓] PR ${p.existing ? 'found' : 'created'}: ${str(p.url)}`);
    case 'recovery.reconciled':
      return paint(c, 'yellow', `[~] Recovered ${str(p.toolCallId)} ${str(p.path ?? '')}: ${str(p.state)}`);
    case 'run.resumed':
      return `[~] Run resumed from ${str(p.state)}`;
    case 'run.finished':
      return paint(c, p.state === 'COMPLETED_LOCAL' || p.state === 'PR_CREATED' ? 'green' : 'yellow', `RUN FINISHED ${str(p.state)}${p.reason ? ` — ${str(p.reason)}` : ''}`);
    case 'error':
      return paint(c, 'red', `[✗] ${str(p.message)}`);
    default:
      return options.verbose ? `[${event.type}] ${JSON.stringify(p)}` : null;
  }
}

export function formatTimestamped(event: EventEnvelope, options: TextRenderOptions = {}): string | null {
  const line = formatEvent(event, options);
  if (line === null) return null;
  const time = event.timestamp.slice(11, 19);
  return line
    .split('\n')
    .map((l, i) => (i === 0 ? `${time} ${l}` : `         ${l}`))
    .join('\n');
}
