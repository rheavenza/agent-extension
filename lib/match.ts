/**
 * Minimal Chrome match-pattern support ("https://*.service-now.com/*").
 * Used both to classify tabs and as host-permission request strings.
 */
export function matchPatternToRegExp(pattern: string): RegExp | null {
  const m = /^(\*|https?|file):\/\/(\*|\*\.[^/*]+|[^/*]+)?(\/.*)$/.exec(pattern.trim());
  if (!m) return null;
  const [, scheme, host = '', path] = m;
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const schemeRe = scheme === '*' ? 'https?' : esc(scheme);
  let hostRe: string;
  if (host === '*') hostRe = '[^/]+';
  else if (host.startsWith('*.')) hostRe = `(?:[^/]+\\.)?${esc(host.slice(2))}(?::\\d+)?`;
  else hostRe = `${esc(host)}${host.includes(':') ? '' : '(?::\\d+)?'}`;
  const pathRe = esc(path).replace(/\*/g, '.*');
  return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`, 'i');
}

export function urlMatchesAny(url: string | undefined, patterns: string[]): boolean {
  if (!url) return false;
  return patterns.some((p) => matchPatternToRegExp(p)?.test(url) ?? false);
}

/** Turn "https://foo.example.com" or a full URL into a match pattern. */
export function originToPattern(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (matchPatternToRegExp(s)) return s;
  try {
    const u = new URL(s.includes('://') ? s : `https://${s}`);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}
