import { NonInteractive, type ContractProposal, type ContractReviewResult, type Interaction, type QuestionAnswer, type QuestionPrompt, type ScopeChangePrompt, type ScopeDecision } from '@aperture/core';
import { defaultActor, ReadlineInteraction } from './readline.ts';

/** Decorates an interaction so the contract gate is pre-approved (`--yes` or a local contract in `--no-interactive`). */
export class PreapprovedContract implements Interaction {
  constructor(private readonly inner: Interaction) {}

  get interactive(): boolean {
    return this.inner.interactive;
  }

  get actor(): string {
    return this.inner.actor;
  }

  async reviewContract(_proposal: ContractProposal): Promise<ContractReviewResult | null> {
    return { action: 'approve' };
  }

  askQuestion(prompt: QuestionPrompt): Promise<QuestionAnswer | null> {
    return this.inner.askQuestion(prompt);
  }

  decideScopeChange(prompt: ScopeChangePrompt): Promise<ScopeDecision | null> {
    return this.inner.decideScopeChange(prompt);
  }

  confirm(message: string, details?: string): Promise<boolean> {
    return this.inner.confirm(message, details);
  }
}

export interface InteractionChoice {
  interaction: Interaction;
  close: () => void;
}

export function createInteraction(options: { interactive: boolean; preapproveContract: boolean }): InteractionChoice {
  const tty = Boolean(process.stdin.isTTY);
  if (options.interactive && tty) {
    const rl = new ReadlineInteraction(defaultActor());
    const interaction = options.preapproveContract ? new PreapprovedContract(rl) : rl;
    return { interaction, close: () => rl.close() };
  }
  const actor = options.preapproveContract ? `preapproved:${defaultActor()}` : 'noninteractive';
  return { interaction: new NonInteractive(actor, { approveContracts: options.preapproveContract }), close: () => undefined };
}
