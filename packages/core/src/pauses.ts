import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { diffContracts, withAdditionalWritablePaths } from '@aperture/contracts';
import type { PauseRequest } from '@aperture/gateway';
import { newId, type QuestionRecord } from '@aperture/storage';
import { HarnessError, type Harness } from './harness.ts';
import type { QuestionAnswer, ScopeDecision } from './interaction.ts';

export interface PreauthorizedAnswer {
  /** Case-insensitive substring (or /regex/) matched against the question text. */
  match: string;
  answer: string;
}

export function loadPreauthorizedAnswers(path: string): PreauthorizedAnswer[] {
  const raw = parseYaml(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${path} must be a YAML list of {match, answer}`);
  return raw.map((entry, i) => {
    const e = entry as Partial<PreauthorizedAnswer>;
    if (typeof e.match !== 'string' || typeof e.answer !== 'string') throw new Error(`${path}[${i}] needs string "match" and "answer"`);
    return { match: e.match, answer: e.answer };
  });
}

export function findPreauthorized(question: string, answers: readonly PreauthorizedAnswer[]): PreauthorizedAnswer | undefined {
  return answers.find((a) => {
    const regex = /^\/(.+)\/([a-z]*)$/.exec(a.match);
    if (regex) {
      try {
        return new RegExp(regex[1]!, regex[2]!.includes('i') ? regex[2] : `${regex[2]}i`).test(question);
      } catch {
        return false;
      }
    }
    return question.toLowerCase().includes(a.match.toLowerCase());
  });
}

export type QuestionPayload =
  | { type: 'question'; toolCallId: string; question: string; choices: string[]; reason: string; requirementIds: string[] }
  | { type: 'scope_change'; toolCallId: string; reason: string; additionalPaths: string[] };

/**
 * Persistent questions and scope requests (§6, §9). Answers are recorded as decisions with the
 * actor and contract version; a scope approval produces a new approved contract revision.
 * Nothing here is ever answered from model preference.
 */
export class PauseService {
  constructor(private readonly harness: Harness) {}

  /** Persists the pause as an open question; idempotent per tool call id. */
  record(runId: string, pause: Exclude<PauseRequest, { type: 'blocked' }>): QuestionRecord {
    const existing = this.harness.store.questionsForRun(runId).find((q) => q.toolCallId === pause.toolCallId);
    if (existing) return existing;
    const question: QuestionRecord = {
      questionId: newId('q'),
      runId,
      toolCallId: pause.toolCallId,
      kind: pause.type,
      payloadJson: JSON.stringify(pause),
      status: 'open',
      createdAt: new Date().toISOString(),
      answeredAt: null,
    };
    this.harness.store.transaction(() => {
      this.harness.store.insertQuestion(question);
      if (pause.type === 'question') {
        this.harness.emit(runId, 'question.asked', { questionId: question.questionId, toolCallId: pause.toolCallId, question: pause.question, choices: pause.choices, reason: pause.reason, requirementIds: pause.requirementIds });
      } else {
        this.harness.emit(runId, 'scope.change.requested', { questionId: question.questionId, toolCallId: pause.toolCallId, reason: pause.reason, additionalPaths: pause.additionalPaths });
      }
    });
    return question;
  }

  open(runId: string): Array<{ record: QuestionRecord; payload: QuestionPayload }> {
    return this.harness.store.questionsForRun(runId, 'open').map((record) => ({ record, payload: JSON.parse(record.payloadJson) as QuestionPayload }));
  }

  private requireOpen(runId: string, questionId: string): { record: QuestionRecord; payload: QuestionPayload } {
    const record = this.harness.store.getQuestion(questionId);
    if (!record || record.runId !== runId) throw new HarnessError(`question ${questionId} not found for run ${runId}`, 'QUESTION_NOT_FOUND');
    if (record.status !== 'open') throw new HarnessError(`question ${questionId} is already ${record.status}`, 'QUESTION_CLOSED');
    return { record, payload: JSON.parse(record.payloadJson) as QuestionPayload };
  }

  answer(runId: string, questionId: string, answer: QuestionAnswer, actor: string): void {
    const { record, payload } = this.requireOpen(runId, questionId);
    if (payload.type !== 'question') throw new HarnessError(`${questionId} is a scope request; approve or deny it instead`, 'WRONG_KIND');
    const run = this.harness.getRun(runId);
    const contract = this.harness.approvedContract(run);
    const gateway = this.harness.createGateway(run, contract);
    const now = new Date().toISOString();
    this.harness.store.transaction(() => {
      this.harness.store.insertDecision({ decisionId: newId('dec'), runId, questionId, kind: 'answer', answerJson: JSON.stringify(answer), actor, contractVersion: contract.version, createdAt: now });
      this.harness.store.setQuestionStatus(questionId, 'answered', now);
      gateway.resolvePause(record.toolCallId!, 'ask_user', payload, `Answer from ${actor}: ${answer.answer}${answer.rationale ? `\nRationale: ${answer.rationale}` : ''}`);
      this.harness.emit(runId, 'question.answered', { questionId, answer: answer.answer, ...(answer.choiceIndex !== undefined ? { choiceIndex: answer.choiceIndex } : {}), actor, contractVersion: contract.version });
    });
  }

  decideScope(runId: string, questionId: string, decision: ScopeDecision, actor: string): void {
    const { record, payload } = this.requireOpen(runId, questionId);
    if (payload.type !== 'scope_change') throw new HarnessError(`${questionId} is a question; answer it instead`, 'WRONG_KIND');
    let run = this.harness.getRun(runId);
    const current = this.harness.approvedContract(run);
    let message: string;
    let version = current.version;
    if (decision.approved) {
      const amended = withAdditionalWritablePaths(current.contract, payload.additionalPaths);
      this.harness.proposeContract(runId, amended, [`scope change requested by the executor: ${payload.reason}`]);
      const approved = this.harness.approvePending(runId, actor);
      version = approved.version;
      this.harness.emit(runId, 'contract.amended', { version: approved.version, sha256: approved.sha256, changes: diffContracts(current.contract, approved.contract), reason: payload.reason, addedWritable: payload.additionalPaths, actor });
      message = `Scope change approved by ${actor}: contract v${approved.version} (sha256 ${approved.sha256.slice(0, 16)}) now also allows writing ${payload.additionalPaths.join(', ')}.`;
      run = this.harness.getRun(runId);
    } else {
      message = `Scope change denied by ${actor}${decision.rationale ? `: ${decision.rationale}` : ''}. Continue within the current writable scope, or call report_blocked if the task cannot be completed.`;
    }
    const gateway = this.harness.createGateway(run);
    const now = new Date().toISOString();
    this.harness.store.transaction(() => {
      this.harness.store.insertDecision({ decisionId: newId('dec'), runId, questionId, kind: 'scope_change', answerJson: JSON.stringify({ approved: decision.approved, paths: payload.additionalPaths, rationale: decision.rationale ?? null }), actor, contractVersion: version, createdAt: now });
      this.harness.store.setQuestionStatus(questionId, 'answered', now);
      gateway.resolvePause(record.toolCallId!, 'request_scope_change', payload, message, !decision.approved);
      this.harness.emit(runId, 'scope.change.decided', { questionId, approved: decision.approved, rationale: decision.rationale ?? null, actor, contractVersion: version });
    });
  }
}
