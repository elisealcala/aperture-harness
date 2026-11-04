import type { ExecutionContract, UserConfig } from '@aperture/contracts';
import { parseSourceRef, SourceError, YamlContractSource, type NormalizedTask, type SourceRef, type TaskSource } from '@aperture/sources';

export interface ContractProposalDraft {
  contract: ExecutionContract;
  /** Reviewer-facing notes such as "no acceptance criteria found". */
  notes: string[];
}

export type ContractCompiler = (task: NormalizedTask, config: UserConfig) => ContractProposalDraft;

/** Dispatches task references to source adapters and turns normalized tasks into proposals. */
export class SourceRegistry {
  private readonly adapters = new Map<SourceRef['type'], TaskSource>();

  constructor(private readonly compiler?: ContractCompiler) {}

  static withDefaults(_config: UserConfig, _env: NodeJS.ProcessEnv): SourceRegistry {
    return new SourceRegistry().register(new YamlContractSource());
  }

  register(source: TaskSource): this {
    this.adapters.set(source.type, source);
    return this;
  }

  async fetch(reference: string, cwd?: string): Promise<NormalizedTask> {
    const ref = parseSourceRef(reference, cwd);
    const adapter = this.adapters.get(ref.type);
    if (!adapter) throw new SourceError(`no source adapter registered for ${ref.type} references`, 'UNSUPPORTED');
    return adapter.fetch(ref);
  }

  async proposeContract(task: NormalizedTask, config: UserConfig): Promise<ContractProposalDraft> {
    if (task.contract) return { contract: task.contract, notes: [] };
    if (!this.compiler) throw new SourceError(`no contract compiler available for ${task.sourceType} tasks`, 'UNSUPPORTED');
    return this.compiler(task, config);
  }
}
