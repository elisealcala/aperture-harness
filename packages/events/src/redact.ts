import { createHash } from 'node:crypto';

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}\b/g, // Linear
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(authorization\s*[:=]\s*)(?:bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

const SECRET_KEY = /^(?:.*[_-])?(?:api[_-]?key|apikey|token|secret|password|passwd|authorization|cookie|private[_-]?key)$/i;

export interface RedactOptions {
  /** Strings longer than this are truncated (with a digest of the full value). */
  maxStringLength?: number;
  /** Extra literal values to scrub, e.g. the resolved API keys of this process. */
  literals?: readonly string[];
}

export function redactString(value: string, options: RedactOptions = {}): string {
  let out = value;
  for (const literal of options.literals ?? []) {
    if (literal.length >= 8) out = out.split(literal).join('[REDACTED]');
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, (match, prefix: unknown) => (typeof prefix === 'string' && match.toLowerCase().startsWith(prefix.toLowerCase()) ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
  const max = options.maxStringLength;
  if (max !== undefined && out.length > max) {
    const digest = createHash('sha256').update(out).digest('hex').slice(0, 16);
    out = `${out.slice(0, max)}…[truncated ${out.length - max} chars, sha256:${digest}]`;
  }
  return out;
}

/** Deep-redacts a JSON-like value: secret-looking keys are masked, secret-looking values scrubbed. */
export function redact<T>(value: T, options: RedactOptions = {}): T {
  return redactValue(value, options, 0) as T;
}

function redactValue(value: unknown, options: RedactOptions, depth: number): unknown {
  if (depth > 32) return '[REDACTED: too deep]';
  if (typeof value === 'string') return redactString(value, options);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, options, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && typeof v === 'string' ? '[REDACTED]' : redactValue(v, options, depth + 1);
    }
    return out;
  }
  return value;
}
