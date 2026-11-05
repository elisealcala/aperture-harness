const CODES = { bold: 1, dim: 2, italic: 3, underline: 4, inverse: 7, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90 } as const;
export type StyleName = keyof typeof CODES;

export interface Style {
  readonly enabled: boolean;
  readonly width: number;
  (names: StyleName | readonly StyleName[], text: string): string;
}

/** Color when writing to a terminal, unless NO_COLOR is set; FORCE_COLOR=1 forces it on. */
export function shouldColor(stream: NodeJS.WriteStream = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  return Boolean(stream.isTTY);
}

export function createStyle(enabled: boolean = shouldColor(), width: number = process.stdout.columns ?? 100): Style {
  const fn = ((names: StyleName | readonly StyleName[], text: string) => {
    if (!enabled || text === '') return text;
    const list = (typeof names === 'string' ? [names] : names) as readonly StyleName[];
    return `\u001b[${list.map((n) => CODES[n]).join(';')}m${text}\u001b[0m`;
  }) as Style;
  Object.defineProperty(fn, 'enabled', { value: enabled });
  Object.defineProperty(fn, 'width', { value: Math.max(60, Math.min(width, 140)) });
  return fn;
}

const ANSI = /\u001b\[[0-9;]*m/g;

export function visibleLength(text: string): number {
  return text.replace(ANSI, '').length;
}

/** Word-wraps plain text to `width`, indenting continuation lines by `indent` spaces. */
export function wrap(text: string, width: number, indent = 0): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + 1 + word.length > width - indent) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${' '.repeat(indent)}`);
}

/** A section heading line such as `── REQUIREMENTS ─────────`. */
export function heading(style: Style, title: string, detail = ''): string {
  const label = ` ${title}${detail ? ` ${detail}` : ''} `;
  const rest = Math.max(4, style.width - visibleLength(label) - 2);
  return `${style('gray', '──')}${style('bold', label)}${style('gray', '─'.repeat(rest))}`;
}

/** A boxed title block. */
export function banner(style: Style, title: string, lines: readonly string[]): string {
  const inner = style.width - 4;
  const top = `${style('gray', '╭─')} ${style('bold', title)} ${style('gray', '─'.repeat(Math.max(2, inner - visibleLength(title) - 1)))}${style('gray', '╮')}`;
  const body = lines.map((l) => `${style('gray', '│')} ${l}`);
  const bottom = style('gray', `╰${'─'.repeat(inner + 2)}╯`);
  return [top, ...body, bottom].join('\n');
}

export function colorDiff(style: Style, diff: string): string {
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file mode') || line.startsWith('deleted file mode')) return style(['bold', 'gray'], line);
      if (line.startsWith('+++') || line.startsWith('---')) return style('bold', line);
      if (line.startsWith('@@')) return style('cyan', line);
      if (line.startsWith('+')) return style('green', line);
      if (line.startsWith('-')) return style('red', line);
      return line;
    })
    .join('\n');
}
