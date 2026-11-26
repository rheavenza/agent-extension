import { describe, expect, it } from 'vitest';
import { analyzeTimeline, compactFieldSummary, compactKnowledge, hasTransformingCommand, isSafeFieldName } from '../lib/splunk/insights';

describe('compactFieldSummary', () => {
  const raw = {
    event_count: 200,
    fields: {
      host: { count: 200, distinct_count: 3, modes: [{ value: 'web01', count: 150 }, { value: 'web02', count: 40 }, { value: 'web03', count: 10 }] },
      status: { count: 180, distinct_count: 2, numeric_count: 180, min: '500', max: '503', mean: '501.4', modes: [{ value: '503', count: 120 }, { value: '500', count: 60 }] },
      user: { count: 20, distinct_count: 19, modes: [{ value: 'a', count: 2 }] },
      punct: { count: 200, modes: [] },
      date_hour: { count: 200, modes: [] },
      _raw: { count: 200, modes: [] },
    },
  };

  it('orders by coverage, drops noise fields and keeps top values', () => {
    const r = compactFieldSummary(raw);
    expect(r.event_count).toBe(200);
    expect(Object.keys(r.fields)).toEqual(['host', 'status', 'user']);
    expect(r.fields.host).toEqual({ coverage: 1, distinct: 3, top: [['web01', 150], ['web02', 40], ['web03', 10]] });
    expect(r.fields.status.coverage).toBe(0.9);
    expect(r.fields.status.numeric).toEqual({ min: 500, max: 503, mean: 501.4 });
    expect(r.fields.user.numeric).toBeUndefined();
  });

  it('honours a field filter and topN', () => {
    const r = compactFieldSummary(raw, { fields: ['host'], topN: 1 });
    expect(r.fields).toEqual({ host: { coverage: 1, distinct: 3, top: [['web01', 150]] } });
  });

  it('accepts the entry-wrapped form and an empty body', () => {
    expect(compactFieldSummary({ entry: [{ content: raw }] }).event_count).toBe(200);
    expect(compactFieldSummary({})).toEqual({ event_count: 0, fields: {} });
  });
});

describe('analyzeTimeline', () => {
  const t = (i: number) => `2026-11-19T09:${String(i).padStart(2, '0')}:00.000+00:00`;

  it('finds the spike onset, peak and first/last event', () => {
    const counts = [2, 1, 2, 3, 2, 2, 1, 40, 90, 60, 3, 0];
    const rows = counts.map((c, i) => ({ _time: t(i), count: String(c), _span: '60' }));
    const a = analyzeTimeline(rows);
    expect(a.total).toBe(206);
    expect(a.baseline_per_bucket).toBe(2);
    expect(a.onset).toEqual({ time: t(7), count: 40, times_baseline: 20 });
    expect(a.peak).toEqual({ time: t(8), count: 90 });
    expect(a.first_event).toBe(t(0));
    expect(a.last_event).toBe(t(10));
    expect(a.span_hint).toBe('60');
    expect(a.by_value).toBeUndefined();
  });

  it('reports no onset for flat or tiny series', () => {
    expect(analyzeTimeline([1, 2, 1, 2].map((c, i) => ({ _time: t(i), count: c }))).onset).toBeNull();
    expect(analyzeTimeline([0, 0, 3, 0].map((c, i) => ({ _time: t(i), count: c }))).onset).toBeNull();
    expect(analyzeTimeline([]).peak).toBeNull();
  });

  it('sums split series and ranks the split values', () => {
    const rows = [
      { _time: t(0), web01: '1', web02: '0', OTHER: '0' },
      { _time: t(1), web01: '30', web02: '5', OTHER: '1' },
    ];
    const a = analyzeTimeline(rows);
    expect(a.series).toEqual([[t(0), 1], [t(1), 36]]);
    expect(Object.entries(a.by_value!)).toEqual([['web01', 31], ['web02', 5], ['OTHER', 1]]);
  });
});

describe('timeline input checks', () => {
  it('rejects transforming base searches and unsafe field names', () => {
    expect(hasTransformingCommand('index=a | stats count')).toBe(true);
    expect(hasTransformingCommand('index=a status=500 | where x>1')).toBe(false);
    expect(isSafeFieldName('host')).toBe(true);
    expect(isSafeFieldName('http.status')).toBe(true);
    expect(isSafeFieldName('host | delete')).toBe(false);
  });
});

describe('compactKnowledge', () => {
  it('keeps the useful parts of each kind', () => {
    const saved = compactKnowledge('saved_searches', {
      entry: [{ name: 'Payments 5xx', acl: { app: 'payments' }, content: { search: 'index=pay status>=500', description: '', is_scheduled: true, 'dispatch.earliest_time': '-15m' } }],
    });
    expect(saved).toEqual([{ name: 'Payments 5xx', app: 'payments', description: undefined, search: 'index=pay status>=500', earliest: '-15m', scheduled: true }]);
    const macros = compactKnowledge('macros', { entry: [{ name: 'pay_idx', acl: { app: 'x' }, content: { definition: 'x'.repeat(700) } }] });
    expect(macros[0]).toMatchObject({ name: 'pay_idx', args: undefined });
    expect((macros[0] as any).definition).toMatch(/…\[truncated\]$/);
  });
});
