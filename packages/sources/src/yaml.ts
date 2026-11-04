import { readFileSync, statSync } from 'node:fs';
import { parseContractText, sha256Hex } from '@aperture/contracts';
import { SourceError, type NormalizedTask, type SourceRef, type TaskSource } from './types.ts';

const MAX_CONTRACT_BYTES = 256 * 1024;

/** Local YAML/JSON contract files: the file *is* the proposed contract. */
export class YamlContractSource implements TaskSource {
  readonly type = 'local' as const;

  async fetch(ref: SourceRef): Promise<NormalizedTask> {
    if (ref.type !== 'local') throw new SourceError('YamlContractSource only handles local references', 'UNSUPPORTED');
    let text: string;
    try {
      const size = statSync(ref.path).size;
      if (size > MAX_CONTRACT_BYTES) throw new SourceError(`contract file exceeds ${MAX_CONTRACT_BYTES} bytes`, 'INVALID_CONTENT');
      text = readFileSync(ref.path, 'utf8');
    } catch (err) {
      if (err instanceof SourceError) throw err;
      throw new SourceError(`cannot read contract file ${ref.path}: ${(err as Error).message}`, 'NOT_FOUND');
    }
    const contract = parseContractText(text);
    const source = contract.metadata.source;
    return {
      sourceType: 'local',
      sourceRef: `local:${ref.path}`,
      taskKey: contract.metadata.id,
      repository: source.repository ?? null,
      title: contract.metadata.title,
      body: contract.spec.goal,
      labels: [],
      comments: [],
      url: null,
      revision: `sha256:${sha256Hex(text)}`,
      fetchedAt: new Date().toISOString(),
      contract,
    };
  }
}
