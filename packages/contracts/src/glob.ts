import picomatch from 'picomatch';

export interface GlobMatcherOptions {
  /** Case-insensitive matching. Used for deny lists so case-folding filesystems cannot bypass them. */
  nocase?: boolean;
}

/**
 * Compiles repository-relative globs. Dotfiles are matched by `*` so that a deny pattern such as
 * `.env*` or `**\/secrets/**` cannot be dodged with hidden directories. A bare name such as
 * `package.json` matches only at the repository root (write `**\/package.json` to match anywhere).
 */
export function compileGlobs(patterns: readonly string[], options: GlobMatcherOptions = {}): (path: string) => boolean {
  if (patterns.length === 0) return () => false;
  const matchers = patterns.map((pattern) => picomatch(pattern, { dot: true, nocase: options.nocase ?? false }));
  return (path: string) => matchers.some((m) => m(path));
}

export function matchesAny(path: string, patterns: readonly string[], options: GlobMatcherOptions = {}): boolean {
  return compileGlobs(patterns, options)(path);
}

/** True when the pattern contains glob syntax rather than naming a single file. */
export function isGlobPattern(pattern: string): boolean {
  return picomatch.scan(pattern).isGlob;
}
