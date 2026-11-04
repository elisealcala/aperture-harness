import type { ContractProposal, ContractReviewResult, Interaction, QuestionAnswer, QuestionPrompt, ScopeChangePrompt, ScopeDecision } from '@aperture/core';

export type PendingPrompt =
  | { kind: 'contract'; prompt: ContractProposal; resolve: (r: ContractReviewResult | null) => void }
  | { kind: 'question'; prompt: QuestionPrompt; resolve: (r: QuestionAnswer | null) => void }
  | { kind: 'scope'; prompt: ScopeChangePrompt; resolve: (r: ScopeDecision | null) => void }
  | { kind: 'confirm'; prompt: { message: string; details?: string }; resolve: (r: boolean) => void };

/**
 * Bridges the orchestrator's human gates to the Ink app: each gate becomes a pending prompt that
 * the Questions panel renders, and the user's keypress resolves it.
 */
export class InkInteraction implements Interaction {
  readonly interactive = true;
  private current: PendingPrompt | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(readonly actor: string) {}

  get pending(): PendingPrompt | null {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(prompt: PendingPrompt | null): void {
    this.current = prompt;
    for (const l of this.listeners) l();
  }

  private ask<T>(make: (resolve: (value: T) => void) => PendingPrompt): Promise<T> {
    return new Promise<T>((resolve) => {
      this.set(
        make((value: T) => {
          this.set(null);
          resolve(value);
        }),
      );
    });
  }

  /** Resolves whatever is pending with "not now" (used when the user quits the TUI). */
  dismiss(): void {
    const p = this.current;
    if (!p) return;
    if (p.kind === 'confirm') p.resolve(false);
    else p.resolve(null);
  }

  reviewContract(prompt: ContractProposal): Promise<ContractReviewResult | null> {
    return this.ask((resolve) => ({ kind: 'contract', prompt, resolve }));
  }

  askQuestion(prompt: QuestionPrompt): Promise<QuestionAnswer | null> {
    return this.ask((resolve) => ({ kind: 'question', prompt, resolve }));
  }

  decideScopeChange(prompt: ScopeChangePrompt): Promise<ScopeDecision | null> {
    return this.ask((resolve) => ({ kind: 'scope', prompt, resolve }));
  }

  confirm(message: string, details?: string): Promise<boolean> {
    return this.ask((resolve) => ({ kind: 'confirm', prompt: { message, ...(details ? { details } : {}) }, resolve }));
  }
}
