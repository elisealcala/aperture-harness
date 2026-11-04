import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TempDirs } from '../../../tests/helpers/tmp.ts';
import { findPreauthorized, loadPreauthorizedAnswers, type PreauthorizedAnswer } from './pauses.ts';

const tmp = new TempDirs();

describe('findPreauthorized', () => {
  const answers: PreauthorizedAnswer[] = [
    { match: 'persist METADATA', answer: 'no' },
    { match: '/^which (db|database)\\b/', answer: 'postgres' },
    { match: '/Case-Sensitive/', answer: 'regex flags default to i' },
  ];

  it('matches a case-insensitive substring', () => {
    expect(findPreauthorized('Should we persist metadata to disk?', answers)?.answer).toBe('no');
  });

  it('matches /regex/ entries, case-insensitively by default', () => {
    expect(findPreauthorized('Which DB should sessions use?', answers)?.answer).toBe('postgres');
    expect(findPreauthorized('is this case-sensitive?', answers)?.answer).toBe('regex flags default to i');
  });

  it('returns the first matching entry', () => {
    expect(findPreauthorized('which db; persist metadata?', answers)?.answer).toBe('no');
  });

  it('returns undefined when nothing matches', () => {
    expect(findPreauthorized('What should the timeout be?', answers)).toBeUndefined();
    expect(findPreauthorized('anything', [])).toBeUndefined();
  });

  it('keeps explicit regex flags and still adds i', () => {
    expect(findPreauthorized('LINE ONE\nline two', [{ match: '/^line two$/m', answer: 'multiline' }])?.answer).toBe('multiline');
  });

  it('treats an invalid regex as a non-match instead of throwing', () => {
    expect(findPreauthorized('anything (', [{ match: '/(unclosed/', answer: 'x' }])).toBeUndefined();
  });
});

describe('loadPreauthorizedAnswers', () => {
  afterEach(() => tmp.cleanup());

  function file(content: string): string {
    const path = join(tmp.make('aperture-answers-'), 'answers.yaml');
    writeFileSync(path, content);
    return path;
  }

  it('loads a YAML list of {match, answer}', () => {
    expect(loadPreauthorizedAnswers(file('- match: persist metadata\n  answer: "no"\n- match: /db/\n  answer: postgres\n'))).toEqual([
      { match: 'persist metadata', answer: 'no' },
      { match: '/db/', answer: 'postgres' },
    ]);
  });

  it('rejects a non-list document', () => {
    expect(() => loadPreauthorizedAnswers(file('match: x\nanswer: y\n'))).toThrow(/must be a YAML list/);
  });

  it('rejects entries without string match and answer', () => {
    expect(() => loadPreauthorizedAnswers(file('- match: x\n- match: y\n  answer: 3\n'))).toThrow(/\[0\] needs string "match" and "answer"/);
  });
});
