import { describe, expect, it } from 'vitest';
import { redact, redactString } from './redact.ts';

const ANTHROPIC_KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv_wx-yz0123456789';
const GITHUB_PAT = 'ghp_0123456789abcdefghijABCDEFGHIJ012345';

describe('redactString', () => {
  it.each([
    ['Anthropic key', `key=${ANTHROPIC_KEY} done`, 'key=[REDACTED] done'],
    ['GitHub classic token', `token ${GITHUB_PAT}`, 'token [REDACTED]'],
    ['GitHub fine-grained token', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop', '[REDACTED]'],
    ['GitHub server token', 'ghs_0123456789abcdefghijABCDEFGH', '[REDACTED]'],
    ['Linear key', 'lin_api_0123456789abcdefghijABCDEFGH', '[REDACTED]'],
    ['AWS access key id', 'AKIAABCDEFGHIJKLMNOP', '[REDACTED]'],
    ['Slack token', 'xoxb-1234567890-abcdefghij', '[REDACTED]'],
  ])('scrubs a %s', (_label, input, expected) => {
    expect(redactString(input)).toBe(expected);
  });

  it('keeps the header name when scrubbing an authorization value', () => {
    expect(redactString('authorization: Bearer abcdefgh12345678')).toBe('authorization: [REDACTED]');
    expect(redactString('Authorization=token abcdefgh12345678 next')).toBe('Authorization=[REDACTED] next');
  });

  it('scrubs PEM private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    expect(redactString(`before\n${pem}\nafter`)).toBe('before\n[REDACTED]\nafter');
  });

  it('scrubs every occurrence', () => {
    expect(redactString(`${ANTHROPIC_KEY} and ${ANTHROPIC_KEY}`)).toBe('[REDACTED] and [REDACTED]');
  });

  it('scrubs caller-supplied literals of at least 8 characters', () => {
    expect(redactString('value=my-own-secret-123;', { literals: ['my-own-secret-123'] })).toBe('value=[REDACTED];');
    expect(redactString('short=abc', { literals: ['abc'] })).toBe('short=abc');
  });

  it('leaves ordinary text alone', () => {
    const text = 'the token budget is 16000; sk-ant is a prefix; ghp_short';
    expect(redactString(text)).toBe(text);
  });

  it('truncates long strings with a digest of the full value', () => {
    const out = redactString('x'.repeat(100), { maxStringLength: 10 });
    expect(out).toMatch(/^x{10}…\[truncated 90 chars, sha256:[0-9a-f]{16}\]$/);
    expect(redactString('x'.repeat(10), { maxStringLength: 10 })).toBe('x'.repeat(10));
  });

  it('redacts before truncating, so a secret straddling the cut is not partially leaked', () => {
    const out = redactString(`aaaa ${ANTHROPIC_KEY}`, { maxStringLength: 20 });
    expect(out).not.toContain('sk-ant-api03-AbC');
    expect(out.startsWith('aaaa [REDACTED]')).toBe(true);
  });
});

describe('redact', () => {
  it('masks string values under secret-looking keys regardless of content', () => {
    const out = redact({
      apiKey: 'plain',
      api_key: 'plain',
      'x-api-key': 'plain',
      GITHUB_TOKEN: 'plain',
      password: 'plain',
      cookie: 'plain',
      authorization: 'plain',
      privateKey: 'plain',
      path: 'src/api/session.ts',
      tokens: 'not a secret key name',
    });
    expect(out).toEqual({
      apiKey: '[REDACTED]',
      api_key: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      GITHUB_TOKEN: '[REDACTED]',
      password: '[REDACTED]',
      cookie: '[REDACTED]',
      authorization: '[REDACTED]',
      privateKey: '[REDACTED]',
      path: 'src/api/session.ts',
      tokens: 'not a secret key name',
    });
  });

  it('keeps non-string values under secret-looking keys (e.g. token counts)', () => {
    expect(redact({ token: 1234, secret: null, password: true })).toEqual({ token: 1234, secret: null, password: true });
  });

  it('recurses into nested objects and arrays', () => {
    const out = redact({ a: [{ headers: { Authorization: 'Bearer x' } }, `see ${GITHUB_PAT}`], n: 1 });
    expect(out).toEqual({ a: [{ headers: { Authorization: '[REDACTED]' } }, 'see [REDACTED]'], n: 1 });
  });

  it('does not mutate its input', () => {
    const input = { apiKey: 'plain', nested: { text: ANTHROPIC_KEY } };
    redact(input);
    expect(input).toEqual({ apiKey: 'plain', nested: { text: ANTHROPIC_KEY } });
  });

  it('bounds recursion depth', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 40; i++) deep = { d: deep };
    expect(JSON.stringify(redact(deep))).toContain('[REDACTED: too deep]');
  });
});
