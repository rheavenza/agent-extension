import { describe, expect, it } from 'vitest';
import {
  changesNear,
  ciQuery,
  describeRelationship,
  excerptText,
  htmlToText,
  isTextAttachment,
  kbLikeQuery,
  kbQueryText,
  parseUtcInput,
  ticketsNear,
} from '../lib/servicenow/related';

const at = Date.UTC(2026, 10, 19, 9, 5); // incident 2026-11-19 09:05 UTC
const d = (utc: string) => `display [UTC ${utc}]`;

describe('ciQuery', () => {
  it('uses dot-walk for names, sys_id directly, and refuses ^', () => {
    expect(ciQuery('PAYAPI01')).toBe('cmdb_ci.name=PAYAPI01');
    expect(ciQuery('a'.repeat(32))).toBe(`cmdb_ci=${'a'.repeat(32)}`);
    expect(() => ciQuery('x^ORactive=true')).toThrow(/not a usable CI/);
  });
});

describe('describeRelationship', () => {
  const row = {
    parent: { value: 'P', display_value: 'payments-app' },
    child: { value: 'C', display_value: 'payapi01' },
    type: { display_value: 'Runs on::Runs' },
  };
  it('reads the relation from the point of view of the CI', () => {
    expect(describeRelationship(row, 'P')).toEqual({ relation: 'Runs on', ci: 'payapi01', ci_sys_id: 'C' });
    expect(describeRelationship(row, 'C')).toEqual({ relation: 'Runs', ci: 'payments-app', ci_sys_id: 'P' });
    expect(describeRelationship(row, 'X')).toBeNull();
  });
});

describe('changesNear', () => {
  const changes = [
    { number: 'CHG1', short_description: 'Deploy payments 2.4', state: 'Closed', start_date: d('2026-11-19 08:00:00'), end_date: d('2026-11-19 08:45:00'), work_start: d('2026-11-19 08:10:00'), work_end: d('2026-11-19 08:40:00') },
    { number: 'CHG2', short_description: 'OS patching', state: 'Implement', start_date: d('2026-11-19 09:00:00'), end_date: d('2026-11-19 11:00:00') },
    { number: 'CHG3', short_description: 'Old change', state: 'Closed', start_date: d('2026-11-01 08:00:00'), end_date: d('2026-11-01 09:00:00') },
    { number: 'CHG4', short_description: 'Next week', state: 'Scheduled', start_date: d('2026-11-26 08:00:00'), end_date: d('2026-11-26 09:00:00') },
  ];

  it('keeps changes overlapping the window, nearest first, using actual times when present', () => {
    const r = changesNear(changes, at, 3);
    expect(r.map((c) => c.number)).toEqual(['CHG2', 'CHG1']);
    expect(r[0]).toMatchObject({ started_min_before_incident: 5, in_progress_at_incident: true, end_utc: '2026-11-19T11:00:00Z' });
    expect(r[1]).toMatchObject({ start_utc: '2026-11-19T08:10:00Z', ended_min_before_incident: 25, in_progress_at_incident: false });
  });
});

describe('ticketsNear', () => {
  it('lists other incidents on the CI in the lookback window', () => {
    const r = ticketsNear(
      [
        { number: 'INC1', short_description: 'same', state: 'New', opened_at: d('2026-11-19 09:05:00') },
        { number: 'INC2', short_description: 'earlier', state: 'Resolved', opened_at: d('2026-11-18 21:05:00'), problem_id: 'PRB9' },
        { number: 'INC3', short_description: 'too old', state: 'Closed', opened_at: d('2026-10-01 00:00:00') },
      ],
      at,
      3,
      'INC1',
    );
    expect(r).toEqual([
      { number: 'INC2', short_description: 'earlier', state: 'Resolved', priority: undefined, opened_utc: '2026-11-18T21:05:00Z', hours_before_incident: 12, close_code: undefined, problem: 'PRB9' },
    ]);
  });
});

describe('parseUtcInput', () => {
  it('reads ServiceNow raw times as UTC and ISO times as given', () => {
    expect(parseUtcInput('2026-11-19 09:05:00')).toBe(at);
    expect(parseUtcInput('2026-11-19T16:05:00+07:00')).toBe(at);
    expect(() => parseUtcInput('yesterday')).toThrow(/Can't read the time/);
  });
});

describe('knowledge helpers', () => {
  it('turns article HTML into text', () => {
    expect(htmlToText('<h2>Fix</h2><p>Restart the&nbsp;listener:</p><ul><li>lsnrctl start</li></ul><script>x()</script>')).toBe(
      'Fix\nRestart the listener:\n- lsnrctl start',
    );
  });
  it('cleans query text and builds a LIKE fallback from the longest words', () => {
    expect(kbQueryText('ORA-12541 ^ORactive=true\nlistener')).toBe('ORA-12541 ORactive=true listener');
    expect(kbLikeQuery('ORA-12541 no listener on db')).toBe(
      'short_descriptionLIKEORA-12541^short_descriptionLIKElistener',
    );
    expect(() => kbQueryText(' ^ ')).toThrow();
  });
});

describe('attachments', () => {
  it('recognises text files by type or extension', () => {
    expect(isTextAttachment('text/plain', 'a.bin')).toBe(true);
    expect(isTextAttachment('application/octet-stream', 'app.log')).toBe(true);
    expect(isTextAttachment('image/png', 'screen.png')).toBe(false);
  });

  const log = Array.from({ length: 1000 }, (_, i) => (i === 700 ? 'ERROR pool exhausted trace_id=abc' : `INFO line ${i}`)).join('\n');

  it('returns matching lines with numbers and context', () => {
    const r = excerptText(log, { maxChars: 10_000, contains: ['error'], context: 1 });
    expect(r.excerpt).toBe('700: INFO line 699\n701: ERROR pool exhausted trace_id=abc\n702: INFO line 701');
    expect(r).toMatchObject({ total_lines: 1000, matched_lines: 1, truncated: false });
  });

  it('marks gaps between separate matches', () => {
    const r = excerptText('a\nERR 1\nb\nc\nd\nERR 2', { maxChars: 1000, contains: ['err'], context: 0 });
    expect(r.excerpt).toBe('2: ERR 1\n…\n6: ERR 2');
  });

  it('keeps the start and the end of a long file without terms', () => {
    const r = excerptText(log, { maxChars: 3000 });
    expect(r.truncated).toBe(true);
    expect(r.excerpt.startsWith('INFO line 0')).toBe(true);
    expect(r.excerpt.endsWith('INFO line 999')).toBe(true);
    expect(r.excerpt).toContain('characters skipped');
  });
});
