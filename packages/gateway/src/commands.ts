import type { ApprovedContract, Check, CommandSpec } from '@aperture/contracts';

export type ResolvedCheck = { check: Check; command: CommandSpec; source: 'contract' | 'config' };

/**
 * Maps declared check ids to fixed executable + argument arrays. Commands come only from the
 * approved contract or the trusted user config; the model supplies an id, never a command string.
 */
export class CommandRegistry {
  constructor(
    private readonly contract: ApprovedContract,
    private readonly configCommands: Readonly<Record<string, CommandSpec>> = {},
  ) {}

  get checks(): readonly Check[] {
    return this.contract.contract.spec.checks;
  }

  resolve(checkId: string): ResolvedCheck | undefined {
    const check = this.contract.contract.spec.checks.find((c) => c.id === checkId);
    if (!check) return undefined;
    const fromContract = this.contract.contract.spec.commands[check.commandId];
    if (fromContract) return { check, command: fromContract, source: 'contract' };
    const fromConfig = this.configCommands[check.commandId];
    if (fromConfig) return { check, command: fromConfig, source: 'config' };
    return undefined;
  }
}
