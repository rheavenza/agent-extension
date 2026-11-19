/** Commands that write, send data out, or run arbitrary code. These need user approval. */
export const RISKY_SPL_COMMANDS = new Set([
  'delete',
  'collect',
  'mcollect',
  'meventcollect',
  'tscollect',
  'outputlookup',
  'outputcsv',
  'outputtext',
  'sendemail',
  'sendalert',
  'script',
  'run',
  'map',
  'rest',
  'dbxoutput',
  'dbxquery',
  'sendtelemetry',
]);

/** Split SPL on pipes and subsearch brackets, ignoring anything inside quotes. */
function segments(spl: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < spl.length; i++) {
    const c = spl[i];
    if (quote) {
      cur += c;
      if (c === '\\' && i + 1 < spl.length) cur += spl[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      cur += c;
    } else if (c === '|' || c === '[' || c === ']') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** The command names used in an SPL string, lowercased. The first segment is an implicit `search`. */
export function splCommands(spl: string): string[] {
  return segments(spl)
    .map((s) => /^\s*([a-zA-Z_][\w]*)/.exec(s)?.[1]?.toLowerCase())
    .filter((c): c is string => !!c);
}

export function riskySplCommands(spl: string): string[] {
  return [...new Set(splCommands(spl).filter((c) => RISKY_SPL_COMMANDS.has(c)))];
}

/** The REST API needs a leading `search` unless the query starts with a generating command. */
export function normalizeSpl(spl: string): string {
  const s = spl.trim();
  if (s.startsWith('|')) return s;
  if (/^search\b/i.test(s)) return s;
  return `search ${s}`;
}

/**
 * Accepts Splunk time modifiers (-24h, @d, now, epoch) and turns absolute timestamps
 * (ISO 8601, or "YYYY-MM-DD HH:MM:SS", which is treated as UTC like ServiceNow raw values) into epoch seconds.
 */
export function normalizeSplunkTime(t: string | undefined): string | undefined {
  if (t == null) return undefined;
  const s = t.trim();
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    let iso = s.replace(' ', 'T');
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso += 'Z';
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) return String(Math.floor(ms / 1000));
  }
  return s;
}

/**
 * Find the Splunk Web root (optional root_endpoint prefix + locale) and app from a tab URL.
 * e.g. https://splunk:8000/en-US/app/search/search → { base: "/en-US", app: "search" }
 */
export function parseSplunkUrl(rawUrl: string): { origin: string; base: string; app: string | null } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const idx = parts.findIndex((p) => /^[a-z]{2}-[A-Z]{2}$/.test(p));
  const baseParts = idx >= 0 ? parts.slice(0, idx + 1) : ['en-US'];
  const rest = idx >= 0 ? parts.slice(idx + 1) : parts;
  const app = rest[0] === 'app' && rest[1] ? rest[1] : null;
  return { origin: url.origin, base: '/' + baseParts.join('/'), app };
}

const DROP_FIELDS = new Set([
  '_bkt',
  '_cd',
  '_si',
  '_serial',
  '_indextime',
  '_sourcetype',
  '_eventtype_color',
  '_kv',
  '_confstr',
  'punct',
  'linecount',
  'splunk_server',
  'splunk_server_group',
  'timestartpos',
  'timeendpos',
  'eventtype',
  'tag::eventtype',
]);

/** Trim Splunk result rows: drop internal fields and cap long values and multivalue lists. */
export function compactResults(
  rows: Array<Record<string, unknown>>,
  maxRows: number,
  maxFieldChars = 1500,
): Array<Record<string, string | string[]>> {
  return rows.slice(0, maxRows).map((row) => {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(row)) {
      if (DROP_FIELDS.has(k) || k.startsWith('date_')) continue;
      if (k.startsWith('_') && k !== '_time' && k !== '_raw') continue;
      const cap = (s: string) => (s.length > maxFieldChars ? s.slice(0, maxFieldChars) + ' …[truncated]' : s);
      if (Array.isArray(v)) {
        const vals = v.slice(0, 20).map((x) => cap(String(x)));
        if (v.length > 20) vals.push(`…(+${v.length - 20} more)`);
        out[k] = vals;
      } else if (v != null && v !== '') out[k] = cap(String(v));
    }
    return out;
  });
}
