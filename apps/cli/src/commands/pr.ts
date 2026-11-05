import { Orchestrator, type Harness } from '@aperture/core';
import { AnthropicProvider, ModelRegistry } from '@aperture/models';
import { PrWorkflow } from '@aperture/pr';
import { GitHubClient } from '@aperture/sources';
import { openHarness, secretLiterals, type GlobalOptions } from '../context.ts';
import { createInteraction } from '../interaction/factory.ts';
import { defaultActor } from '../interaction/readline.ts';
import { attachRenderer } from './run.ts';

function workflow(harness: Harness): PrWorkflow {
  const config = harness.config;
  const apiKey = harness.env[config.providers.anthropic.apiKeyEnv];
  return new PrWorkflow({
    harness,
    orchestrator: new Orchestrator(harness),
    provider: new AnthropicProvider(apiKey ? { apiKey } : {}),
    registry: ModelRegistry.fromConfig(config),
    github: GitHubClient.fromEnv(harness.env, config.providers.github),
    redactLiterals: secretLiterals(config, harness.env),
  });
}

export async function prDraftCommand(runId: string, opts: { model?: string; repository?: string; draftPr?: boolean }, globals: GlobalOptions): Promise<number> {
  const harness = openHarness(globals);
  const detach = attachRenderer(harness, {});
  try {
    const run = harness.getRun(runId);
    const draft = await workflow(harness).draft(run.runId, {
      ...(opts.model ? { modelId: opts.model } : {}),
      ...(opts.repository ? { repository: opts.repository } : {}),
      ...(opts.draftPr !== undefined ? { draftPr: opts.draftPr } : {}),
    });
    process.stdout.write(`\n${'─'.repeat(60)}\n${draft.title}\n${'─'.repeat(60)}\n${draft.body}\n`);
    if (draft.fallback) process.stdout.write(`note: used the deterministic template (${draft.problems.join('; ')}); edit the text on GitHub if needed\n`);
    process.stdout.write(`next: \`aperture pr create ${run.runId}\` (requires your explicit approval)\n`);
    return 0;
  } finally {
    detach();
    harness.close();
  }
}

export async function prCreateCommand(runId: string, opts: { yes?: boolean }, globals: GlobalOptions): Promise<number> {
  const harness = openHarness(globals);
  const detach = attachRenderer(harness, {});
  const choice = createInteraction({ interactive: true, preapproveContract: false });
  try {
    const run = harness.getRun(runId);
    const flow = workflow(harness);
    let approved = false;
    if (run.state === 'PR_APPROVAL') {
      const plan = await flow.plan(run.runId);
      const details = [
        `repository: ${plan.repository} (origin ${plan.remoteUrl})`,
        `branch:     ${plan.branch} → base ${plan.base}${plan.draftPr ? ' (GitHub draft PR)' : ' (ready for review)'}`,
        `files:      ${plan.changedFiles.join(', ')}`,
        `action:     ${plan.action}`,
        `title:      ${plan.title}`,
        '',
        plan.body,
      ].join('\n');
      if (opts.yes) {
        process.stdout.write(`${details}\n`);
        approved = true;
      } else if (choice.interaction.interactive) {
        approved = await choice.interaction.confirm('Publish this pull request?', details);
      } else {
        process.stdout.write(`${details}\n`);
      }
      if (!approved) {
        process.stderr.write('not approved: nothing was pushed and no pull request was created (pass --yes to approve non-interactively)\n');
        return 2;
      }
    }
    const result = await flow.publish(run.runId, { approved, actor: opts.yes ? `${defaultActor()} (--yes)` : defaultActor() });
    process.stdout.write(`${result.existing ? 'pull request already exists' : 'pull request created'}: ${result.url}\n`);
    return 0;
  } finally {
    choice.close();
    detach();
    harness.close();
  }
}
