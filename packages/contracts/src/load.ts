import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { ExecutionContractSchema, type ExecutionContract } from './schema.ts';

export class ContractValidationError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[],
  ) {
    super(message);
    this.name = 'ContractValidationError';
  }
}

export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

/** Parses and validates an unknown value (already decoded from YAML/JSON) as an execution contract. */
export function parseContract(value: unknown): ExecutionContract {
  const result = ExecutionContractSchema.safeParse(value);
  if (!result.success) {
    const issues = formatZodIssues(result.error);
    throw new ContractValidationError(`invalid execution contract:\n  ${issues.join('\n  ')}`, issues);
  }
  return result.data;
}

export function parseContractText(text: string): ExecutionContract {
  let decoded: unknown;
  try {
    // YAML is a superset of JSON, so one parser handles both encodings. `maxAliasCount` guards
    // against alias-expansion bombs in untrusted files.
    decoded = parseYaml(text, { maxAliasCount: 50, uniqueKeys: true });
  } catch (err) {
    throw new ContractValidationError(`contract is not valid YAML/JSON: ${(err as Error).message}`, [(err as Error).message]);
  }
  return parseContract(decoded);
}

export function loadContractFile(path: string): ExecutionContract {
  return parseContractText(readFileSync(path, 'utf8'));
}
