import { describe, expect, it } from 'vitest';
import { extractIndicators, suggestedWindow } from '../lib/servicenow/indicators';

const fields = {
  number: 'INC0012345',
  short_description: 'Payments API returning HTTP 503 on web01 and app-prd-03',
  description:
    'Since 2026-11-19 08:40 users get ERR_CONNECTION_RESET. trace_id=abc123def456 ' +
    'Host pay-api.prod.corp.example.com (10.20.30.40) logs java.net.SocketTimeoutException and ORA-12541. ' +
    'See https://grafana.corp.example.com/d/xyz?from=now-6h. Attached app.log. Contact ops@corp.example.com. ' +
    'Request 3f2b9c1e-8d4a-4f6b-9e2d-1a2b3c4d5e6f failed. oauth2 and ipv4 are fine. Related INC0012300. ' +
    'Checked the node.js process, see README.md and foo.bar.',
  cmdb_ci: 'PAYAPI01',
  opened_at: '19/11/2026 16:05:00 [UTC 2026-11-19 09:05:00]',
  state: 'In Progress',
};

describe('extractIndicators', () => {
  const r = extractIndicators(fields, [
    { element: 'work_notes', created_on: '', created_by: '', value: 'Restarted pod on node k8s-node-07, status code 502' },
  ], ['acme.service-now.com']);

  it('finds hosts: the CI first, FQDNs, URL hosts and short names', () => {
    expect(r.hosts[0]).toBe('payapi01');
    expect(r.hosts).toEqual(
      expect.arrayContaining(['web01', 'app-prd-03', 'pay-api.prod.corp.example.com', 'grafana.corp.example.com', 'k8s-node-07']),
    );
  });

  it('skips things that only look like hosts', () => {
    for (const notHost of [
      'app.log', 'corp.example.com', 'oauth2', 'ipv4', 'inc0012300', 'acme.service-now.com',
      'java.net.sockettimeoutexception', 'readme.md', 'foo.bar', 'node.js', 'abc123def456', 'ora-12541',
    ]) {
      expect(r.hosts).not.toContain(notHost);
    }
  });

  it('finds IPs, IDs, error codes, exceptions and timestamps', () => {
    expect(r.ips).toEqual(['10.20.30.40']);
    expect(r.ids).toEqual(expect.arrayContaining(['3f2b9c1e-8d4a-4f6b-9e2d-1a2b3c4d5e6f', 'abc123def456']));
    expect(r.error_codes).toEqual(expect.arrayContaining(['503', '502', 'ORA-12541', 'ERR_CONNECTION_RESET']));
    expect(r.exceptions).toContain('java.net.SocketTimeoutException');
    expect(r.timestamps_in_text).toContain('2026-11-19 08:40');
    expect(r.emails).toEqual(['ops@corp.example.com']);
    expect(r.urls).toEqual(['https://grafana.corp.example.com/d/xyz?from=now-6h']);
  });

  it('does not scan the raw UTC suffix or non-text fields', () => {
    expect(r.timestamps_in_text).not.toContain('2026-11-19 09:05:00');
  });
});

describe('suggestedWindow', () => {
  const now = Date.UTC(2026, 10, 25);

  it('spans 2h before opened_at to 1h after, in epoch seconds', () => {
    const w = suggestedWindow(fields, now)!;
    expect(w.earliest_utc).toBe('2026-11-19T07:05:00Z');
    expect(w.latest_utc).toBe('2026-11-19T10:05:00Z');
    expect(w.earliest).toBe(String(Date.UTC(2026, 10, 19, 7, 5) / 1000));
  });

  it('extends to resolution time and never past now', () => {
    const resolved = { ...fields, resolved_at: 'x [UTC 2026-11-19 14:00:00]' };
    expect(suggestedWindow(resolved, now)!.latest_utc).toBe('2026-11-19T14:15:00Z');
    const fresh = { opened_at: 'x [UTC 2026-11-19 09:05:00]' };
    expect(suggestedWindow(fresh, Date.UTC(2026, 10, 19, 9, 30))!.latest_utc).toBe('2026-11-19T09:30:00Z');
  });

  it('uses a bare raw value when display and raw are the same', () => {
    expect(suggestedWindow({ opened_at: '2026-11-19 09:05:00' }, now)!.earliest_utc).toBe('2026-11-19T07:05:00Z');
  });

  it('returns null without an opened time', () => {
    expect(suggestedWindow({ number: 'X' }, now)).toBeNull();
  });
});
