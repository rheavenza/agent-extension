/**
 * Pure helpers for the CMDB, related-records, knowledge and attachment tools.
 * Records here are compacted Table API records: display values, with "[UTC raw]" on date fields.
 */
import { rawUtc } from './indicators';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Only plain CI names and sys_ids go into encoded queries (^ would add conditions). */
export function ciQuery(ci: string, field = 'cmdb_ci'): string {
  const v = ci.trim();
  if (!v || /[\^\n\r]/.test(v)) throw new Error(`"${ci}" is not a usable CI name.`);
  return /^[0-9a-f]{32}$/i.test(v) ? `${field}=${v}` : `${field}.name=${v}`;
}

export const isSysId = (v: string) => /^[0-9a-f]{32}$/i.test(v.trim());

/** Turn a cmdb_rel_ci row into "<relation> <other CI>" from the point of view of `ciSysId`. */
export function describeRelationship(
  row: Record<string, { display_value?: unknown; value?: unknown } | undefined>,
  ciSysId: string,
): { relation: string; ci: string; ci_sys_id: string } | null {
  const parent = row.parent;
  const child = row.child;
  const type = String(row.type?.display_value ?? '');
  const [down, up] = type.includes('::') ? type.split('::') : [type, type];
  if (String(parent?.value ?? '') === ciSysId) {
    return { relation: down || 'related to', ci: String(child?.display_value ?? ''), ci_sys_id: String(child?.value ?? '') };
  }
  if (String(child?.value ?? '') === ciSysId) {
    return { relation: up || 'related to', ci: String(parent?.display_value ?? ''), ci_sys_id: String(parent?.value ?? '') };
  }
  return null;
}

const DISPLAY = (v: string | undefined) => (v ?? '').replace(/\s*\[UTC [^\]]+\]/, '').trim();
const isoUtc = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

export interface NearbyChange {
  number: string;
  short_description: string;
  state: string;
  type?: string;
  start_utc: string | null;
  end_utc: string | null;
  /** Minutes from the change's start to the incident time; positive = the change started before. */
  started_min_before_incident: number | null;
  /** Minutes from the change's end to the incident time; positive = it ended before. */
  ended_min_before_incident: number | null;
  in_progress_at_incident: boolean;
  assignment_group?: string;
}

/**
 * Changes whose (actual, else planned) window overlaps [incident − lookback, incident + 2h],
 * nearest first. Uses the raw UTC times, so the user's ServiceNow timezone doesn't matter.
 */
export function changesNear(records: Array<Record<string, string | undefined>>, atMs: number, lookbackDays: number): NearbyChange[] {
  const from = atMs - lookbackDays * DAY;
  const to = atMs + 2 * HOUR;
  return records
    .map((r) => {
      const start = rawUtc(r.work_start) ?? rawUtc(r.start_date);
      const end = rawUtc(r.work_end) ?? rawUtc(r.end_date);
      return { r, start, end };
    })
    .filter(({ start, end }) => start != null && start <= to && (end ?? start) >= from)
    .map(({ r, start, end }) => ({
      number: r.number ?? '',
      short_description: r.short_description ?? '',
      state: DISPLAY(r.state),
      type: r.type ? DISPLAY(r.type) : undefined,
      start_utc: start != null ? isoUtc(start) : null,
      end_utc: end != null ? isoUtc(end) : null,
      started_min_before_incident: start != null ? Math.round((atMs - start) / MIN) : null,
      ended_min_before_incident: end != null ? Math.round((atMs - end) / MIN) : null,
      in_progress_at_incident: start != null && start <= atMs && (end == null || end >= atMs),
      assignment_group: r.assignment_group ? DISPLAY(r.assignment_group) : undefined,
    }))
    .sort((a, b) => Math.abs(a.started_min_before_incident ?? Infinity) - Math.abs(b.started_min_before_incident ?? Infinity));
}

/** Other tickets on the same CI opened in [incident − lookback, incident + 1 day]. */
export function ticketsNear(
  records: Array<Record<string, string | undefined>>,
  atMs: number,
  lookbackDays: number,
  excludeNumber?: string,
) {
  const from = atMs - lookbackDays * DAY;
  const to = atMs + DAY;
  return records
    .filter((r) => r.number !== excludeNumber)
    .map((r) => ({ r, opened: rawUtc(r.opened_at) ?? rawUtc(r.sys_created_on) }))
    .filter(({ opened }) => opened != null && opened >= from && opened <= to)
    .map(({ r, opened }) => ({
      number: r.number ?? '',
      short_description: r.short_description ?? '',
      state: DISPLAY(r.state),
      priority: r.priority ? DISPLAY(r.priority) : undefined,
      opened_utc: isoUtc(opened!),
      hours_before_incident: Math.round(((atMs - opened!) / HOUR) * 10) / 10,
      close_code: r.close_code ? DISPLAY(r.close_code) : undefined,
      problem: r.problem_id ? DISPLAY(r.problem_id) : undefined,
    }));
}

/** Parse "YYYY-MM-DD HH:MM:SS" (UTC, as in the [UTC ...] values) or any ISO time. */
export function parseUtcInput(v: string): number {
  const t = v.trim();
  const ms = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(t) ? Date.parse(t.replace(' ', 'T') + 'Z') : Date.parse(t);
  if (Number.isNaN(ms)) throw new Error(`Can't read the time "${v}". Use "YYYY-MM-DD HH:MM:SS" in UTC or an ISO time.`);
  return ms;
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

/** Knowledge article bodies are HTML; reduce them to readable text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? (e.startsWith('#') ? String.fromCharCode(Number(e.slice(1)) || 32) : m))
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** Text for an encoded-query full-text search: no ^ (new condition) or line breaks. */
export function kbQueryText(text: string): string {
  const t = text.replace(/[\^\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) throw new Error('Give some words to search for.');
  return t.slice(0, 200);
}

/** Fallback when full-text search isn't available: short_description must contain the 3 longest words. */
export function kbLikeQuery(text: string): string {
  const words = [...new Set(kbQueryText(text).split(' ').filter((w) => w.length >= 3))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  return words.map((w) => `short_descriptionLIKE${w}`).join('^');
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|x-ndjson|x-yaml|yaml|csv|javascript|x-sh|sql))/i;
const TEXT_EXT = /\.(log|txt|out|err|json|xml|csv|tsv|yaml|yml|conf|cfg|ini|properties|trace|stack|md|sql|sh|ps1|har)$/i;

export function isTextAttachment(contentType: string, fileName: string): boolean {
  return TEXT_TYPES.test(contentType) || TEXT_EXT.test(fileName);
}

/**
 * The part of a text attachment worth reading. With `contains`, only matching lines (any term,
 * case-insensitive), each with line numbers and `context` lines around it. Without, the start
 * and the end of the file: logs usually end with the failure.
 */
export function excerptText(
  text: string,
  o: { maxChars: number; contains?: string[]; context?: number },
): { excerpt: string; total_lines: number; matched_lines?: number; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  const terms = (o.contains ?? []).map((t) => t.toLowerCase()).filter(Boolean);
  if (terms.length) {
    const ctx = o.context ?? 1;
    const hits = lines.flatMap((l, i) => (terms.some((t) => l.toLowerCase().includes(t)) ? [i] : []));
    const keep = new Set<number>();
    for (const i of hits) for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) keep.add(j);
    const out: string[] = [];
    let size = 0;
    let prev = -2;
    let truncated = false;
    for (const i of [...keep].sort((a, b) => a - b)) {
      const line = `${i + 1}: ${lines[i].slice(0, 1000)}`;
      if (size + line.length > o.maxChars) {
        truncated = true;
        break;
      }
      if (prev >= 0 && i > prev + 1) out.push('…');
      out.push(line);
      size += line.length + 1;
      prev = i;
    }
    return { excerpt: out.join('\n'), total_lines: lines.length, matched_lines: hits.length, truncated };
  }
  if (text.length <= o.maxChars) return { excerpt: text, total_lines: lines.length, truncated: false };
  const head = Math.floor(o.maxChars / 3);
  const tail = o.maxChars - head;
  const headText = text.slice(0, head);
  const tailText = text.slice(-tail);
  const skipped = text.length - head - tail;
  return {
    excerpt: `${headText}\n…[${skipped} characters skipped; pass contains to search the whole file]…\n${tailText}`,
    total_lines: lines.length,
    truncated: true,
  };
}
