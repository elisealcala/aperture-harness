import { z } from 'zod';

const RelPath = z.string().min(1).max(512);
const ReqIds = z.array(z.string().min(1).max(32)).min(1).max(16);

export const ToolInputSchemas = {
  read_file: z.strictObject({
    path: RelPath.describe('Repository-relative file path.'),
    startLine: z.number().int().positive().optional().describe('First line to return (1-based).'),
    endLine: z.number().int().positive().optional().describe('Last line to return (inclusive).'),
  }),
  search_code: z.strictObject({
    pattern: z.string().min(1).max(200).describe('Extended regular expression (git grep -E).'),
    within: z.array(RelPath).max(16).optional().describe('Optional repository-relative directories or files to restrict the search to.'),
  }),
  propose_patch: z.strictObject({
    path: RelPath.describe('The single repository-relative file this patch modifies or creates.'),
    unifiedDiff: z.string().min(1).max(200_000).describe('A unified diff for exactly this one file (---/+++ headers and @@ hunks).'),
    requirementIds: ReqIds.describe('Contract requirement ids this change implements, e.g. ["R1"].'),
  }),
  run_check: z.strictObject({
    checkId: z.string().min(1).max(64).describe('Id of a check declared in the approved contract.'),
  }),
  ask_user: z.strictObject({
    question: z.string().min(1).max(2000),
    choices: z.array(z.string().min(1).max(300)).max(8).optional(),
    reason: z.string().min(1).max(1000).describe('Why this blocks completion.'),
    requirementIds: z.array(z.string().min(1).max(32)).max(16).default([]),
    blocking: z.literal(true),
  }),
  request_scope_change: z.strictObject({
    reason: z.string().min(1).max(2000),
    additionalPaths: z.array(RelPath).min(1).max(16),
  }),
  report_blocked: z.strictObject({
    reason: z.string().min(1).max(2000),
    evidence: z.array(z.string().max(2000)).max(16).optional(),
  }),
} as const;

export type ToolName = keyof typeof ToolInputSchemas;
export const TOOL_NAMES = Object.keys(ToolInputSchemas) as ToolName[];

export type ToolInput<N extends ToolName> = z.infer<(typeof ToolInputSchemas)[N]>;

/** The §9 typed tool protocol as a discriminated union. */
export type ToolRequest = { [N in ToolName]: { id: string; name: N; input: ToolInput<N> } }[ToolName];

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  read_file:
    'Read a file inside the approved readable scope. Returns lines prefixed with their line numbers and a tab; the prefixes are not part of the file. Use startLine/endLine for large files.',
  search_code: 'Search approved readable files with an extended regular expression. Results are bounded; narrow with `within` when needed.',
  propose_patch:
    'Propose a change to ONE writable file as a unified diff. Use "--- /dev/null" to create a new file. Must cite the requirement ids it implements. The harness validates the path and applies the patch; edits outside the writable scope are rejected.',
  run_check: 'Run one of the checks declared in the approved contract by its id. You cannot run arbitrary commands.',
  ask_user:
    'Ask the user a blocking product question when the contract leaves a decision open. Include why it blocks completion and the affected requirement ids. Do not ask for permission to expand scope here.',
  request_scope_change: 'Request that additional files become writable. Pauses execution until the user approves a new contract revision.',
  report_blocked: 'Stop and report that the task cannot be completed within the contract, with evidence.',
};

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Provider-neutral tool definitions. Order and bytes are stable, which keeps prompt caching effective. */
export function toolDefinitions(): ToolDefinition[] {
  return TOOL_NAMES.map((name) => {
    const schema = z.toJSONSchema(ToolInputSchemas[name], { io: 'input' }) as Record<string, unknown>;
    delete schema.$schema;
    return { name, description: TOOL_DESCRIPTIONS[name], inputSchema: schema };
  });
}

export type ParsedToolRequest =
  | { ok: true; request: ToolRequest }
  | { ok: false; reasonCode: 'UNKNOWN_TOOL' | 'INVALID_INPUT'; message: string };

/** Rejects unsupported tools and malformed arguments before anything executes. */
export function parseToolRequest(raw: { id: string; name: string; input: unknown }): ParsedToolRequest {
  if (!Object.hasOwn(ToolInputSchemas, raw.name)) {
    return { ok: false, reasonCode: 'UNKNOWN_TOOL', message: `unsupported tool ${JSON.stringify(raw.name)}; available: ${TOOL_NAMES.join(', ')}` };
  }
  const name = raw.name as ToolName;
  const parsed = ToolInputSchemas[name].safeParse(raw.input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ');
    return { ok: false, reasonCode: 'INVALID_INPUT', message: `invalid input for ${name}: ${issues}` };
  }
  return { ok: true, request: { id: raw.id, name, input: parsed.data } as ToolRequest };
}
