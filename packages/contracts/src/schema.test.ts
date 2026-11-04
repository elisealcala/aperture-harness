import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contractWith, validContractInput } from '../../../tests/helpers/contracts.ts';
import { ContractValidationError, loadContractFile, parseContract, parseContractText } from './load.ts';
import { repoPatternProblem } from './schema.ts';

const SAMPLE_CONTRACT = fileURLToPath(new URL('../../../fixtures/sample-contract.yaml', import.meta.url));

function issuesOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ContractValidationError);
    return (err as ContractValidationError).issues;
  }
  throw new Error('expected a ContractValidationError');
}

describe('ExecutionContract schema', () => {
  describe('valid contracts', () => {
    it('parses fixtures/sample-contract.yaml', () => {
      const contract = loadContractFile(SAMPLE_CONTRACT);
      expect(contract.metadata.id).toBe('GH-142');
      expect(contract.metadata.source).toEqual({ type: 'github', repository: 'org/repo', issueNumber: 142 });
      expect(contract.spec.requirements.map((r) => r.id)).toEqual(['R1', 'R2', 'R3']);
      expect(contract.spec.scope.denied).toContain('package.json');
      expect(contract.spec.commands['unit-session']).toEqual({ exec: 'node', args: ['--test', 'src/api/session.test.ts'], timeoutSeconds: 120 });
      expect(contract.spec.checks.map((c) => c.id)).toEqual(['unit', 'typecheck']);
    });

    it('applies defaults for omitted sections', () => {
      const contract = parseContract(validContractInput());
      expect(contract.spec.permissions).toEqual({
        network: 'deny',
        dependencies: 'deny',
        shell: 'approved-checks-only',
        issueWrites: 'deny',
        pullRequestCreate: 'approval-required',
      });
      expect(contract.spec.limits.maxVerificationAttempts).toBe(3);
      expect(contract.spec.models).toEqual({ implement: 'claude-sonnet-5-5', prDraft: 'claude-haiku-5-5' });
      expect(contract.spec.cache).toEqual({ enabled: true, ttl: '5m' });
    });

    it('accepts JSON text as well as YAML', () => {
      const contract = parseContractText(JSON.stringify(validContractInput()));
      expect(contract.metadata.id).toBe('LOCAL-1');
    });

    it('accepts pullRequestCreate: deny (the other restrictive value)', () => {
      const contract = parseContract(contractWith(['spec', 'permissions'], { pullRequestCreate: 'deny' }));
      expect(contract.spec.permissions.pullRequestCreate).toBe('deny');
    });

    it('accepts checks that cover declared requirements', () => {
      const contract = parseContract(contractWith(['spec', 'checks'], [{ id: 'unit', commandId: 'unit', covers: ['R1', 'R2'] }]));
      expect(contract.spec.checks[0]?.covers).toEqual(['R1', 'R2']);
    });
  });

  describe('text decoding errors', () => {
    it('rejects malformed YAML', () => {
      expect(() => parseContractText('spec: [unclosed')).toThrow(ContractValidationError);
    });

    it('rejects duplicate YAML keys', () => {
      expect(() => parseContractText('apiVersion: aperture.dev/v1\napiVersion: aperture.dev/v2\n')).toThrow(/not valid YAML/);
    });
  });

  describe('scope globs', () => {
    it.each([
      ['/etc/passwd', /absolute/],
      ['C:/Windows/system32', /absolute/],
      ['~/.ssh/id_rsa', /home-relative/],
      ['../outside.txt', /traversal/],
      ['src/../../outside.txt', /traversal/],
      ['.git/config', /\.git/],
      ['src/.git/hooks/pre-commit', /\.git/],
      ['src\\api\\session.ts', /backslash/],
      ['src/\u0001evil', /control/],
    ])('rejects writable entry %j', (glob, message) => {
      const issues = issuesOf(() => parseContract(contractWith(['spec', 'scope', 'writable'], [glob])));
      expect(issues.join('\n')).toMatch(message);
    });

    it.each(['readable', 'denied'] as const)('validates %s globs too', (field) => {
      const issues = issuesOf(() => parseContract(contractWith(['spec', 'scope', field], ['../x'])));
      expect(issues[0]).toMatch(new RegExp(`spec\\.scope\\.${field}\\.0`));
    });

    it('requires at least one writable path', () => {
      expect(() => parseContract(contractWith(['spec', 'scope', 'writable'], []))).toThrow(ContractValidationError);
    });

    it('repoPatternProblem accepts ordinary globs', () => {
      expect(repoPatternProblem('src/**/*.ts')).toBeUndefined();
      expect(repoPatternProblem('.env*')).toBeUndefined();
      expect(repoPatternProblem('**/secrets/**')).toBeUndefined();
    });
  });

  describe('requirements and checks', () => {
    it('rejects duplicate requirement ids', () => {
      const issues = issuesOf(() =>
        parseContract(contractWith(['spec', 'requirements'], [
          { id: 'R1', text: 'a' },
          { id: 'R1', text: 'b' },
        ])),
      );
      expect(issues).toContainEqual(expect.stringMatching(/duplicate requirement id R1/));
    });

    it('rejects an empty requirement list', () => {
      expect(() => parseContract(contractWith(['spec', 'requirements'], []))).toThrow(/at least one requirement/);
    });

    it('rejects malformed requirement ids', () => {
      expect(() => parseContract(contractWith(['spec', 'requirements'], [{ id: '1 bad id', text: 'a' }]))).toThrow(ContractValidationError);
    });

    it('rejects checks covering unknown requirements', () => {
      const issues = issuesOf(() => parseContract(contractWith(['spec', 'checks'], [{ id: 'unit', commandId: 'unit', covers: ['R9'] }])));
      expect(issues).toContainEqual(expect.stringMatching(/spec\.checks\.0\.covers: check unit covers unknown requirement R9/));
    });

    it('rejects duplicate check ids', () => {
      const issues = issuesOf(() =>
        parseContract(contractWith(['spec', 'checks'], [
          { id: 'unit', commandId: 'unit' },
          { id: 'unit', commandId: 'unit' },
        ])),
      );
      expect(issues).toContainEqual(expect.stringMatching(/duplicate check id unit/));
    });

    it.each(['sh -c "rm -rf /"', 'node;curl', '$(whoami)', 'a|b'])('rejects command exec with shell syntax %j', (exec) => {
      expect(() => parseContract(contractWith(['spec', 'commands', 'unit', 'exec'], exec))).toThrow(/exec must be a bare executable/);
    });
  });

  describe('permissions', () => {
    it.each([
      ['network', 'allow'],
      ['dependencies', 'allow'],
      ['shell', 'any'],
      ['shell', 'unrestricted'],
      ['issueWrites', 'allow'],
      ['pullRequestCreate', 'auto'],
    ])('rejects %s: %s', (key, value) => {
      const issues = issuesOf(() => parseContract(contractWith(['spec', 'permissions'], { [key]: value })));
      expect(issues[0]).toMatch(new RegExp(`^spec\\.permissions\\.${key}:`));
    });
  });

  describe('unknown keys', () => {
    it.each([
      [['extra'], true],
      [['metadata', 'owner'], 'mallory'],
      [['spec', 'sudo'], true],
      [['spec', 'scope', 'executable'], ['bin/**']],
      [['spec', 'permissions'], { network: 'deny', filesystem: 'read-write' }],
      [['spec', 'limits'], { maxModelTurns: 4, unlimited: true }],
      [['spec', 'commands', 'unit', 'shell'], true],
      [['spec', 'checks'], [{ id: 'unit', commandId: 'unit', skip: true }]],
    ] as const)('rejects unknown key at %j', (path, value) => {
      const issues = issuesOf(() => parseContract(contractWith(path, value)));
      expect(issues.join('\n')).toMatch(/[Uu]nrecognized key/);
    });

    it('rejects a wrong apiVersion and kind', () => {
      expect(() => parseContract(contractWith(['apiVersion'], 'aperture.dev/v2'))).toThrow(ContractValidationError);
      expect(() => parseContract(contractWith(['kind'], 'Contract'))).toThrow(ContractValidationError);
    });
  });
});
