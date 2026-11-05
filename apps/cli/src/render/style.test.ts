import { describe, expect, it } from 'vitest';
import { banner, colorDiff, createStyle, heading, shouldColor, visibleLength, wrap } from './style.ts';

const ESC = '\u001b[';
const tty = (isTTY: boolean | undefined) => ({ isTTY }) as unknown as NodeJS.WriteStream;

describe('shouldColor', () => {
  it.each([
    ['a TTY with no overrides', true, {}, true],
    ['a pipe with no overrides', false, {}, false],
    ['a stream without isTTY', undefined, {}, false],
    ['NO_COLOR on a TTY', true, { NO_COLOR: '1' }, false],
    ['NO_COLOR with any non-empty value', true, { NO_COLOR: 'false' }, false],
    ['an empty NO_COLOR (ignored)', true, { NO_COLOR: '' }, true],
    ['FORCE_COLOR=1 on a pipe', false, { FORCE_COLOR: '1' }, true],
    ['FORCE_COLOR=0 (not forcing) on a pipe', false, { FORCE_COLOR: '0' }, false],
    ['FORCE_COLOR=0 on a TTY', true, { FORCE_COLOR: '0' }, true],
    ['FORCE_COLOR together with NO_COLOR (FORCE_COLOR wins)', false, { FORCE_COLOR: '1', NO_COLOR: '1' }, true],
  ])('%s -> %s', (_label, isTTY, env, expected) => {
    expect(shouldColor(tty(isTTY), env as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe('createStyle', () => {
  it('returns text unchanged when disabled', () => {
    const style = createStyle(false, 100);
    expect(style.enabled).toBe(false);
    expect(style('red', 'hello')).toBe('hello');
    expect(style(['bold', 'cyan'], 'hello')).toBe('hello');
  });

  it('wraps text in SGR codes (combined for several names) and resets when enabled', () => {
    const style = createStyle(true, 100);
    expect(style.enabled).toBe(true);
    expect(style('red', 'hello')).toBe(`${ESC}31mhello${ESC}0m`);
    expect(style(['bold', 'cyan'], 'x')).toBe(`${ESC}1;36mx${ESC}0m`);
    expect(style('gray', 'g')).toBe(`${ESC}90mg${ESC}0m`);
  });

  it('never wraps empty text', () => {
    expect(createStyle(true, 100)('red', '')).toBe('');
  });

  it.each([
    [20, 60],
    [60, 60],
    [100, 100],
    [140, 140],
    [400, 140],
  ])('clamps width %d to %d', (width, expected) => {
    expect(createStyle(false, width).width).toBe(expected);
  });
});

describe('visibleLength', () => {
  it('ignores ANSI escape sequences', () => {
    const style = createStyle(true, 100);
    expect(visibleLength(`${style('red', 'abc')} ${style(['bold', 'green'], 'de')}`)).toBe(6);
    expect(visibleLength('plain')).toBe(5);
    expect(visibleLength('')).toBe(0);
  });
});

describe('wrap', () => {
  it('keeps short text on one line and collapses whitespace', () => {
    expect(wrap('  one   two\nthree  ', 80)).toBe('one two three');
  });

  it('breaks between words so no line exceeds the width', () => {
    const text = 'the quick brown fox jumps over the lazy dog';
    const wrapped = wrap(text, 15);
    expect(wrapped).toBe('the quick brown\nfox jumps over\nthe lazy dog');
    for (const line of wrapped.split('\n')) expect(line.length).toBeLessThanOrEqual(15);
  });

  it('indents continuation lines and reserves the indent in the width', () => {
    const wrapped = wrap('aaa bbb ccc ddd', 10, 2);
    expect(wrapped).toBe('aaa bbb\n  ccc ddd');
    for (const line of wrapped.split('\n')) expect(line.length).toBeLessThanOrEqual(10);
  });

  it('does not split a word longer than the width', () => {
    expect(wrap('a supercalifragilistic b', 8)).toBe('a\nsupercalifragilistic\nb');
  });

  it('returns an empty string for blank input', () => {
    expect(wrap('', 20)).toBe('');
    expect(wrap('   ', 20)).toBe('');
  });
});

describe('heading', () => {
  it('renders a rule filling the style width', () => {
    const style = createStyle(false, 60);
    const line = heading(style, 'CHECKS', '(2)');
    expect(line.startsWith('── CHECKS (2) ─')).toBe(true);
    expect(line).toMatch(/^── CHECKS \(2\) ─+$/);
    expect(visibleLength(line)).toBe(60);
  });

  it('keeps at least four rule characters for very long titles', () => {
    const style = createStyle(false, 60);
    expect(heading(style, 'X'.repeat(80))).toMatch(/ ─{4}$/);
  });

  it('measures the visible width when colored', () => {
    const style = createStyle(true, 80);
    const line = heading(style, 'GOAL');
    expect(line).toContain(ESC);
    expect(visibleLength(line)).toBe(80);
  });
});

describe('banner', () => {
  it('boxes the title and body lines at the style width', () => {
    const style = createStyle(false, 60);
    const lines = banner(style, 'Contract v1', ['first', 'second']).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^╭─ Contract v1 ─+╮$/);
    expect(lines[1]).toBe('│ first');
    expect(lines[2]).toBe('│ second');
    expect(lines[3]).toBe(`╰${'─'.repeat(58)}╯`);
    expect(visibleLength(lines[0]!)).toBe(60);
    expect(visibleLength(lines[3]!)).toBe(60);
  });

  it('has no body lines when none are given', () => {
    expect(banner(createStyle(false, 60), 'T', []).split('\n')).toHaveLength(2);
  });
});

describe('colorDiff', () => {
  const diff = ['diff --git a/x.ts b/x.ts', 'index 1..2 100644', '--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-old', '+new', ' same'].join('\n');

  it('is the identity when the style is disabled', () => {
    expect(colorDiff(createStyle(false, 100), diff)).toBe(diff);
  });

  it('colors headers, hunks, additions and removals; leaves context alone', () => {
    const style = createStyle(true, 100);
    expect(colorDiff(style, diff).split('\n')).toEqual([
      style(['bold', 'gray'], 'diff --git a/x.ts b/x.ts'),
      style(['bold', 'gray'], 'index 1..2 100644'),
      style('bold', '--- a/x.ts'),
      style('bold', '+++ b/x.ts'),
      style('cyan', '@@ -1 +1 @@'),
      style('red', '-old'),
      style('green', '+new'),
      ' same',
    ]);
  });

  it('treats new/deleted file mode lines as headers', () => {
    const style = createStyle(true, 100);
    expect(colorDiff(style, 'new file mode 100644\ndeleted file mode 100644')).toBe(`${style(['bold', 'gray'], 'new file mode 100644')}\n${style(['bold', 'gray'], 'deleted file mode 100644')}`);
  });
});
