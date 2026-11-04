import type { ExecutionContract, UserConfig } from '@aperture/contracts';
import {
  compileContract,
  GitHubClient,
  GitHubIssueSource,
  LinearIssueSource,
  parseSourceRef,
  SourceError,
  YamlContractSource,
  type FetchLike,
  type NormalizedTask,
  type RepoContext,
  type SourceRef,
  type TaskSource,
} from '@aperture/sources';

export interface ContractProposalDraft {
  contract: ExecutionContract;
  /** Reviewer-facing notes such as "no acceptance criteria found". */
  notes: string[];
}

export type ContractCompiler = (task: NormalizedTask, config: UserConfig, repo: RepoContext) => ContractProposalDraft;

/**
 * Dispatches task references to source adapters and turns normalized tasks into proposals. Every
 * source flows into the same NormalizedTask → proposed contract → approval pipeline.
 */
export class SourceRegistry {
  private readonly adapters = new Map<SourceRef['type'], TaskSource>();

  constructor(private readonly compiler: ContractCompiler = compileContract) {}

  static withDefaults(config: UserConfig, env: NodeJS.ProcessEnv, fetchImpl?: FetchLike): SourceRegistry {
    const github = GitHubClient.fromEnv(env, config.providers.github, fetchImpl);
    const linearKey = env[config.providers.linear.apiKeyEnv];
    return new SourceRegistry()
      .register(new YamlContractSource())
      .register(new GitHubIssueSource(github))
      .register(
        new LinearIssueSource({
          apiUrl: config.providers.linear.apiUrl,
          ...(linearKey ? { apiKey: linearKey } : {}),
          teamRepositories: config.linear.teamRepositories,
          ...(fetchImpl ? { fetch: fetchImpl } : {}),
        }),
      );
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

  async proposeContract(task: NormalizedTask, config: UserConfig, repo: RepoContext): Promise<ContractProposalDraft> {
    if (task.contract) return { contract: task.contract, notes: [] };
    return this.compiler(task, config, repo);
  }
}
