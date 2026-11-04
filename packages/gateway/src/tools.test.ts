import { describe, expect, it } from 'vitest';
import { parseToolRequest, TOOL_NAMES, toolDefinitions } from './tools.ts';

describe('parseToolRequest', () => {
  it('parses each supported tool', () => {
    expect(parseToolRequest({ id: 'c1', name: 'read_file', input: { path: 'src/a.ts', startLine: 1, endLine: 10 } })).toEqual({
      ok: true,
      request: { id: 'c1', name: 'read_file', input: { path: 'src/a.ts', startLine: 1, endLine: 10 } },
    });
    expect(parseToolRequest({ id: 'c2', name: 'search_code', input: { pattern: 'createSession', within: ['src/api'] } }).ok).toBe(true);
    expect(parseToolRequest({ id: 'c3', name: 'propose_patch', input: { path: 'src/a.ts', unifiedDiff: '--- a\n', requirementIds: ['R1'] } }).ok).toBe(true);
    expect(parseToolRequest({ id: 'c4', name: 'run_check', input: { checkId: 'unit' } }).ok).toBe(true);
    expect(parseToolRequest({ id: 'c5', name: 'request_scope_change', input: { reason: 'need types', additionalPaths: ['src/types/a.ts'] } }).ok).toBe(true);
    expect(parseToolRequest({ id: 'c6', name: 'report_blocked', input: { reason: 'cannot' } }).ok).toBe(true);
  });

  it('applies defaults (ask_user requirementIds)', () => {
    const parsed = parseToolRequest({ id: 'c1', name: 'ask_user', input: { question: 'Which?', reason: 'ambiguous', blocking: true } });
    expect(parsed.ok && parsed.request.input).toEqual({ question: 'Which?', reason: 'ambiguous', blocking: true, requirementIds: [] });
  });

  it.each(['shell', 'bash', 'write_file', 'exec', '', 'READ_FILE'])('rejects unsupported tool %j', (name) => {
    expect(parseToolRequest({ id: 'c1', name, input: {} })).toMatchObject({ ok: false, reasonCode: 'UNKNOWN_TOOL' });
  });

  // BUG: `raw.name in ToolInputSchemas` also matches inherited Object.prototype members, so a tool
  // named "constructor"/"toString"/"__proto__" reaches `ToolInputSchemas[name].safeParse` and throws a
  // TypeError instead of returning UNKNOWN_TOOL (gateway.execute would then throw mid-run).
  // Remove `.fails` once tools.ts uses Object.hasOwn.
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('rejects prototype member %j as UNKNOWN_TOOL', (name) => {
    expect(parseToolRequest({ id: 'c1', name, input: {} })).toMatchObject({ ok: false, reasonCode: 'UNKNOWN_TOOL' });
  });

  it.each([
    ['read_file', { }, /path/],
    ['read_file', { path: '' }, /path/],
    ['read_file', { path: 'a', startLine: 0 }, /startLine/],
    ['read_file', { path: 'a', startLine: 1.5 }, /startLine/],
    ['read_file', { path: 'a', mode: 'w' }, /mode|Unrecognized/],
    ['search_code', { pattern: '' }, /pattern/],
    ['search_code', { pattern: 'x'.repeat(201) }, /pattern/],
    ['propose_patch', { path: 'a', unifiedDiff: 'x', requirementIds: [] }, /requirementIds/],
    ['propose_patch', { path: 'a', unifiedDiff: 'x' }, /requirementIds/],
    ['run_check', { checkId: 'unit', command: 'rm -rf /' }, /command|Unrecognized/],
    ['run_check', { command: 'npm test' }, /checkId/],
    ['ask_user', { question: 'q', reason: 'r', blocking: false }, /blocking/],
    ['request_scope_change', { reason: 'r', additionalPaths: [] }, /additionalPaths/],
  ] as const)('rejects invalid %s input %j', (name, input, issue) => {
    const parsed = parseToolRequest({ id: 'c1', name, input });
    expect(parsed).toMatchObject({ ok: false, reasonCode: 'INVALID_INPUT' });
    expect(parsed.ok ? '' : parsed.message).toMatch(issue);
  });

  it.each([null, 'path=src/a.ts', 42, []])('rejects non-object input %j', (input) => {
    expect(parseToolRequest({ id: 'c1', name: 'read_file', input })).toMatchObject({ ok: false, reasonCode: 'INVALID_INPUT' });
  });
});

describe('toolDefinitions', () => {
  it('exposes exactly the seven §9 tools in a stable order', () => {
    expect(TOOL_NAMES).toEqual(['read_file', 'search_code', 'propose_patch', 'run_check', 'ask_user', 'request_scope_change', 'report_blocked']);
    expect(toolDefinitions().map((d) => d.name)).toEqual(TOOL_NAMES);
    expect(JSON.stringify(toolDefinitions())).toBe(JSON.stringify(toolDefinitions()));
  });
});
