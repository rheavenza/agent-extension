/**
 * Pulls searchable indicators out of a ticket and works out a default Splunk time window.
 * Done in code because models are unreliable at both: they miss IDs buried in long comments and
 * get timezone and date arithmetic wrong.
 */
import type { JournalEntry } from './record';

/** Fields whose text is scanned. Everything else (state, priority, ...) only adds noise. */
const TEXT_FIELDS = [
  'short_description',
  'description',
  'comments',
  'work_notes',
  'close_notes',
  'comments_and_work_notes',
  'cmdb_ci',
  'u_error_message',
];

const MAX_PER_KIND = 15;

export interface Indicators {
  hosts: string[];
  ips: string[];
  urls: string[];
  ids: string[];
  error_codes: string[];
  exceptions: string[];
  emails: string[];
  timestamps_in_text: string[];
}

export interface TimeWindow {
  /** Epoch seconds, ready for splunk_search earliest/latest. */
  earliest: string;
  latest: string;
  /** The same window as UTC, for reading. */
  earliest_utc: string;
  latest_utc: string;
  basis: string;
}

const uniq = (xs: string[], cap = MAX_PER_KIND) => [...new Set(xs)].slice(0, cap);

const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** key=value / key: value pairs whose key names an ID (trace_id=..., correlationId: ...). */
const KEYED_ID =
  /\b(?:trace|span|correlation|request|transaction|session|job|order|tx|msg|message)[_-]?id\b\s*[:=]\s*["']?([\w.:-]{6,})/gi;
const FQDN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24})\b/gi;
/** Short hostnames people write in tickets: web01, app-prd-03, db_sg2. A letter part plus digits. */
const SHORT_HOST = /\b[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*[-_]?\d{1,4}[a-z]?\b/gi;
const HTTP_STATUS = /\b(?:HTTP|status(?:\s*code)?|response(?:\s*code)?)\s*[:=]?\s*([1-5]\d\d)\b/gi;
const PREFIXED_CODE = /\b(?:ORA|SQL|ERR|E|AADSTS|KB|MSB|CWE|SAP|IDOC)[-_]?\d{3,8}\b/g;
const ERR_CONST = /\bERR_[A-Z0-9_]{3,}\b/g;
const EXCEPTION = /\b(?:[a-z_][\w$]*\.)*[A-Z][\w$]*(?:Exception|Error|Fault|Timeout)\b/g;
const TIMESTAMP =
  /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b|\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM)\b/gi;

/** Words that look like hostnames but aren't (file names, versions, common words). */
const NOT_HOST_TLD = new Set([
  'log', 'txt', 'json', 'xml', 'csv', 'yml', 'yaml', 'conf', 'cfg', 'ini', 'jar', 'war', 'exe', 'dll',
  'zip', 'gz', 'tar', 'png', 'jpg', 'pdf', 'doc', 'docx', 'xlsx', 'html', 'htm', 'js', 'ts', 'py', 'sh', 'java',
  'class', 'properties', 'do', 'aspx', 'php', 'sql', 'bak', 'tmp', 'md', 'pl', 'rb', 'go', 'rs', 'cs', 'vb',
]);

/**
 * An FQDN must end in a public or common internal TLD. This drops Java package and class names
 * (java.net.SocketTimeoutException) and dotted words (foo.bar) that the pattern alone would accept.
 */
const HOST_TLD = new Set([
  'com', 'net', 'org', 'io', 'ai', 'app', 'dev', 'cloud', 'biz', 'info', 'gov', 'edu', 'mil', 'int',
  'local', 'localdomain', 'lan', 'corp', 'internal', 'intra', 'intranet', 'home', 'priv', 'private',
  'svc', 'cluster', 'prod', 'stg', 'staging', 'test', 'example', 'site', 'online', 'tech', 'global',
]);
const isHostTld = (tld: string) => HOST_TLD.has(tld) || /^[a-z]{2}$/.test(tld);
/** Prefixes of word+number tokens that are versions, protocols or ticket numbers, not hosts. */
const NOT_SHORT_HOST =
  /^(?:inc|ritm|req|sctask|chg|ctask|prb|ptask|task|kb|http|https|ipv|utf|sha|md|base|win|windows|log|oauth|tls|ssl|java|jdk|python|node|php|arm|x|v|step|phase|item|option|version|build|release|error|port|page|line|row|code|level|tier|top|day|week|month|year|q|h|t|p|pid|uid|gid|iphone|android|ios|office|excel|chrome|edge|firefox)[-_]?\d/i;

function matches(re: RegExp, text: string, group = 0): string[] {
  return [...text.matchAll(re)].map((m) => m[group]).filter(Boolean);
}

function stripUtc(v: string): string {
  return v.replace(/\s*\[UTC [^\]]+\]/g, '');
}

export function extractIndicators(
  fields: Record<string, string>,
  journal: JournalEntry[] | null,
  ownHosts: string[] = [],
): Indicators {
  const parts = TEXT_FIELDS.map((f) => fields[f]).filter(Boolean).map(stripUtc);
  for (const j of journal ?? []) parts.push(j.value);
  const text = parts.join('\n');

  const urls = uniq(matches(URL_RE, text).map((u) => u.replace(/[.,;:]+$/, '')));
  const emails = uniq(matches(EMAIL, text));
  const emailDomains = new Set(emails.map((e) => e.split('@')[1].toLowerCase()));
  const own = new Set(ownHosts.map((h) => h.toLowerCase()));
  const urlHosts = urls.flatMap((u) => {
    try {
      return [new URL(u).hostname.toLowerCase()];
    } catch {
      return [];
    }
  });

  // Hosts: FQDNs (not file names, not email domains, not this ServiceNow instance) and short
  // hostnames with a number in them, plus the CI name, which is usually the host.
  const textNoUrls = text.replace(URL_RE, ' ').replace(EMAIL, ' ');
  const fqdns = matches(FQDN, textNoUrls)
    .map((h) => h.toLowerCase())
    .filter((h) => {
      const tld = h.split('.').pop()!;
      return isHostTld(tld) && !NOT_HOST_TLD.has(tld) && !emailDomains.has(h);
    });
  const shortHosts = matches(SHORT_HOST, textNoUrls.replace(IPV4, ' ').replace(GUID, ' '))
    .map((h) => h.toLowerCase())
    // Real short hostnames have a separator (app-prd-3) or a 2+ digit suffix (web01); this drops
    // oauth2, ipv4, utf8 and the like. Five or more trailing digits is a ticket or ID, not a host.
    .filter(
      (h) =>
        h.length >= 4 &&
        /[a-z]{2}/.test(h) &&
        (/[-_]/.test(h) || /\d{2,4}[a-z]?$/.test(h)) &&
        !NOT_SHORT_HOST.test(h) &&
        !/^[a-z]+\d{5,}$/.test(h),
    );
  const ids = uniq([...matches(GUID, text).map((g) => g.toLowerCase()), ...matches(KEYED_ID, text, 1)]);
  const error_codes = uniq([
    ...matches(HTTP_STATUS, text, 1).filter((c) => Number(c) >= 400),
    ...matches(PREFIXED_CODE, text),
    ...matches(ERR_CONST, text),
  ]);
  const exceptions = uniq(matches(EXCEPTION, text));
  // A token already classified as an ID, error code or exception is not also a host.
  const taken = new Set([...ids, ...error_codes, ...exceptions].map((x) => x.toLowerCase()));
  const ci = fields.cmdb_ci ? [stripUtc(fields.cmdb_ci).trim().toLowerCase()] : [];
  const hosts = uniq([...ci, ...fqdns, ...urlHosts, ...shortHosts].filter((h) => h && !own.has(h) && !taken.has(h)));

  return {
    hosts,
    ips: uniq(matches(IPV4, text).filter((ip) => !/^(?:0|255)\./.test(ip) && !/^\d+\.0\.0\.0$/.test(ip))),
    urls,
    ids,
    error_codes,
    exceptions,
    emails,
    timestamps_in_text: uniq(matches(TIMESTAMP, text), 10),
  };
}

const UTC_RAW = /\[UTC (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/;

/** Epoch ms of a compacted ServiceNow date ("display [UTC raw]", or a bare raw value), or null. */
export function rawUtc(v: string | undefined): number | null {
  const m = v ? UTC_RAW.exec(v) : null;
  if (!m) {
    // A field with no display/raw split (e.g. the user's timezone is UTC) is the raw value itself.
    if (v && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v.trim())) return Date.parse(v.trim().replace(' ', 'T') + 'Z');
    return null;
  }
  return Date.parse(m[1].replace(' ', 'T') + 'Z');
}

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

/**
 * Default search window: 2 hours before the ticket was opened to 1 hour after (or to when it was
 * resolved, if sooner than now). Times written in the ticket text have no reliable timezone, so
 * they are listed in indicators for the model to weigh, not used here.
 */
export function suggestedWindow(fields: Record<string, string>, nowMs = Date.now()): TimeWindow | null {
  const opened = rawUtc(fields.opened_at) ?? rawUtc(fields.sys_created_on);
  if (opened == null || Number.isNaN(opened)) return null;
  const resolved = rawUtc(fields.resolved_at) ?? rawUtc(fields.closed_at);
  const start = opened - 2 * 3_600_000;
  let end = Math.max(opened + 3_600_000, resolved != null ? resolved + 15 * 60_000 : 0);
  end = Math.min(end, nowMs);
  return {
    earliest: String(Math.floor(start / 1000)),
    latest: String(Math.floor(end / 1000)),
    earliest_utc: iso(start),
    latest_utc: iso(end),
    basis: `opened_at ${iso(opened)} − 2h → ${resolved != null ? 'resolved/closed + 15m, at least ' : ''}opened_at + 1h`,
  };
}
