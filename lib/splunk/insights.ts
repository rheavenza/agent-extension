/**
 * Pure helpers that turn Splunk REST responses into small, decision-ready summaries.
 * Kept free of browser APIs so they can be tested on fixed inputs.
 */

/** Fields Splunk adds to every event that say nothing about the problem. */
const NOISE_FIELDS = new Set([
  'punct', 'linecount', 'splunk_server', 'splunk_server_group', 'timestartpos', 'timeendpos',
  'date_hour', 'date_mday', 'date_minute', 'date_month', 'date_second', 'date_wday', 'date_year', 'date_zone',
  'eventtype_color', 'tag::eventtype',
]);

export interface FieldSummary {
  /** Share of events that have the field, 0–1. */
  coverage: number;
  distinct: number;
  /** Most common values with their counts. */
  top: Array<[string, number]>;
  numeric?: { min: number; max: number; mean: number };
}

/**
 * Compact the output of search/jobs/{sid}/summary: per field, how often it appears, how many
 * distinct values it has and its top values. Fields are ordered by coverage and capped.
 */
export function compactFieldSummary(
  raw: any,
  opts: { fields?: string[]; topN?: number; maxFields?: number } = {},
): { event_count: number; fields: Record<string, FieldSummary> } {
  const { topN = 5, maxFields = 40 } = opts;
  const body = raw?.entry?.[0]?.content ?? raw ?? {};
  const eventCount = Number(body.event_count ?? body.eventCount ?? 0);
  const want = opts.fields?.length ? new Set(opts.fields) : null;
  const entries = Object.entries<any>(body.fields ?? {})
    .filter(([name]) => (want ? want.has(name) : !NOISE_FIELDS.has(name) && (!name.startsWith('_') || name === '_raw')))
    .filter(([name]) => name !== '_raw')
    .map(([name, f]) => {
      const count = Number(f.count ?? 0);
      const modes: any[] = Array.isArray(f.modes) ? f.modes : [];
      const summary: FieldSummary = {
        coverage: eventCount ? Math.round((count / eventCount) * 1000) / 1000 : 0,
        distinct: Number(f.distinct_count ?? modes.length),
        top: modes.slice(0, topN).map((m) => [String(m.value).slice(0, 200), Number(m.count ?? 0)] as [string, number]),
      };
      const numericCount = Number(f.numeric_count ?? 0);
      if (numericCount > 0 && numericCount >= count * 0.9 && f.min != null && f.max != null) {
        summary.numeric = { min: Number(f.min), max: Number(f.max), mean: Math.round(Number(f.mean ?? 0) * 100) / 100 };
      }
      return [name, summary] as const;
    })
    .sort((a, b) => b[1].coverage - a[1].coverage || a[0].localeCompare(b[0]))
    .slice(0, maxFields);
  return { event_count: eventCount, fields: Object.fromEntries(entries) };
}

export interface TimelineAnalysis {
  span_hint: string;
  buckets: number;
  total: number;
  /** [bucket start, total count] for every bucket, oldest first. */
  series: Array<[string, number]>;
  /** Totals per split value (only with splitBy). */
  by_value?: Record<string, number>;
  first_event: string | null;
  last_event: string | null;
  baseline_per_bucket: number;
  peak: { time: string; count: number } | null;
  /** First bucket where the count rose well above the baseline, if it did. */
  onset: { time: string; count: number; times_baseline: number | null } | null;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Analyse `| timechart count [by field]` rows: totals, peak, when events first and last appeared,
 * and the onset of a spike (first bucket at 3× the median and at least 5 events). Computed in
 * code so the model doesn't eyeball 60 numbers.
 */
export function analyzeTimeline(rows: Array<Record<string, unknown>>): TimelineAnalysis {
  const seriesKeys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!k.startsWith('_')) seriesKeys.add(k);
  const byValue: Record<string, number> = {};
  const series: Array<[string, number]> = rows.map((r) => {
    let total = 0;
    for (const k of seriesKeys) {
      const n = Number(r[k] ?? 0);
      if (Number.isFinite(n)) {
        total += n;
        byValue[k] = (byValue[k] ?? 0) + n;
      }
    }
    return [String(r._time ?? ''), total];
  });
  const counts = series.map(([, c]) => c);
  const total = counts.reduce((a, b) => a + b, 0);
  const nonzero = series.filter(([, c]) => c > 0);
  const base = median(counts);
  const threshold = Math.max(5, base * 3);
  let peak: TimelineAnalysis['peak'] = null;
  for (const [time, count] of series) if (!peak || count > peak.count) peak = { time, count };
  const onsetIdx = counts.findIndex((c) => c >= threshold);
  const onset =
    onsetIdx >= 0 && peak && peak.count >= threshold
      ? {
          time: series[onsetIdx][0],
          count: counts[onsetIdx],
          times_baseline: base > 0 ? Math.round((counts[onsetIdx] / base) * 10) / 10 : null,
        }
      : null;
  const splitKeys = [...seriesKeys].filter((k) => k !== 'count');
  return {
    span_hint: rows.length > 1 ? String(rows[0]._span ?? '') : '',
    buckets: rows.length,
    total,
    series,
    ...(splitKeys.length ? { by_value: Object.fromEntries(Object.entries(byValue).sort((a, b) => b[1] - a[1])) } : {}),
    first_event: nonzero[0]?.[0] ?? null,
    last_event: nonzero.at(-1)?.[0] ?? null,
    baseline_per_bucket: base,
    peak: peak && peak.count > 0 ? peak : null,
    onset,
  };
}

/** A field name usable in `timechart ... by <field>`: no spaces, pipes or quotes. */
export function isSafeFieldName(f: string): boolean {
  return /^[A-Za-z_][\w.:-]{0,99}$/.test(f);
}

/** The base search must stay a filter: timechart is appended to it. */
export function hasTransformingCommand(spl: string): boolean {
  return /\|\s*(stats|chart|timechart|tstats|top|rare|eventstats|streamstats|table|transaction)\b/i.test(spl);
}

export type KnowledgeKind = 'saved_searches' | 'macros' | 'eventtypes' | 'lookups';

export const KNOWLEDGE_ENDPOINTS: Record<KnowledgeKind, string> = {
  saved_searches: 'saved/searches',
  macros: 'admin/macros',
  eventtypes: 'saved/eventtypes',
  lookups: 'data/transforms/lookups',
};

/** Compact a Splunk REST list response for one kind of knowledge object. */
export function compactKnowledge(kind: KnowledgeKind, raw: any, maxDef = 600) {
  const cut = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return s.length > maxDef ? s.slice(0, maxDef) + ' …[truncated]' : s;
  };
  return ((raw?.entry ?? []) as any[]).map((e) => {
    const c = e.content ?? {};
    const app = e.acl?.app ?? c['eai:appName'];
    switch (kind) {
      case 'saved_searches':
        return {
          name: e.name,
          app,
          description: cut(c.description) || undefined,
          search: cut(c.search),
          earliest: c['dispatch.earliest_time'] || undefined,
          scheduled: c.is_scheduled === true || c.is_scheduled === '1' || undefined,
        };
      case 'macros':
        return { name: e.name, app, args: c.args || undefined, definition: cut(c.definition) };
      case 'eventtypes':
        return { name: e.name, app, search: cut(c.search), tags: c.tags || undefined };
      case 'lookups':
        return { name: e.name, app, file: c.filename || undefined, fields: c.fields_list || undefined };
    }
  });
}
