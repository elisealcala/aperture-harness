import type { ContractFinding, ExecutionContract } from '@aperture/contracts';

export interface ContractProposal {
  runId: string;
  version: number;
  contract: ExecutionContract;
  yaml: string;
  sha256: string;
  findings: ContractFinding[];
  /** Why the contract needs review (e.g. vague ticket, amendment). */
  notes: string[];
  /** Files tracked at the baseline, so reviewers can see which writable paths are new. */
  existingPaths?: string[];
}

export type ContractReviewResult = { action: 'approve' } | { action: 'reject'; reason?: string } | { action: 'edit'; contract: ExecutionContract };

export interface QuestionPrompt {
  runId: string;
  questionId: string;
  question: string;
  choices: string[];
  reason: string;
  requirementIds: string[];
}

export interface QuestionAnswer {
  answer: string;
  choiceIndex?: number;
  rationale?: string;
}

export interface ScopeChangePrompt {
  runId: string;
  questionId: string;
  reason: string;
  additionalPaths: string[];
  currentWritable: readonly string[];
}

export interface ScopeDecision {
  approved: boolean;
  rationale?: string;
}

/**
 * Human gate abstraction. The CLI provides readline and Ink implementations; tests script answers.
 * Returning `null` means "not now" (the user detached), which leaves the run waiting.
 */
export interface Interaction {
  readonly interactive: boolean;
  /** Identity recorded as the actor for approvals and answers. */
  readonly actor: string;
  reviewContract(proposal: ContractProposal): Promise<ContractReviewResult | null>;
  askQuestion(prompt: QuestionPrompt): Promise<QuestionAnswer | null>;
  decideScopeChange(prompt: ScopeChangePrompt): Promise<ScopeDecision | null>;
  confirm(message: string, details?: string): Promise<boolean>;
}

/** Never answers anything: questions block the run (AT-16) and approvals are refused. */
export class NonInteractive implements Interaction {
  readonly interactive = false;
  constructor(
    readonly actor: string = 'noninteractive',
    private readonly options: { approveContracts?: boolean } = {},
  ) {}

  async reviewContract(): Promise<ContractReviewResult | null> {
    return this.options.approveContracts ? { action: 'approve' } : null;
  }

  async askQuestion(): Promise<QuestionAnswer | null> {
    return null;
  }

  async decideScopeChange(): Promise<ScopeDecision | null> {
    return null;
  }

  async confirm(): Promise<boolean> {
    return false;
  }
}
