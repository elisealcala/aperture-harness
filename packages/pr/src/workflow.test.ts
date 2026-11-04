import { describe, expect, it } from 'vitest';
import { repositoryFromRemote } from './workflow.ts';

describe('repositoryFromRemote', () => {
  it.each([
    ['https://github.com/org/repo.git', 'org/repo'],
    ['https://github.com/org/repo', 'org/repo'],
    ['https://github.com/org/repo/', 'org/repo'],
    ['git@github.com:org/repo.git', 'org/repo'],
    ['ssh://git@github.com/org/my.repo.git', 'org/my.repo'],
    ['  https://github.com/org/repo.git\n', 'org/repo'],
    ['https://gitlab.com/org/repo.git', undefined],
    ['/tmp/local/repo', undefined],
  ])('%j -> %j', (url, expected) => {
    expect(repositoryFromRemote(url)).toBe(expected);
  });
});
