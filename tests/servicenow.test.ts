import { describe, expect, it } from 'vitest';
import { compactRecord } from '../lib/servicenow/record';
import { isTicketNumber, numberToTable, parseSnowRecordUrl } from '../lib/servicenow/url';

const ID = '0123456789abcdef0123456789abcdef';

describe('parseSnowRecordUrl', () => {
  it.each([
    [`https://acme.service-now.com/incident.do?sys_id=${ID}`, 'incident'],
    [`https://acme.service-now.com/nav_to.do?uri=incident.do%3Fsys_id%3D${ID}`, 'incident'],
    [`https://acme.service-now.com/nav_to.do?uri=%2Fsc_req_item.do%3Fsys_id%3D${ID}%26sysparm_view%3D`, 'sc_req_item'],
    [`https://acme.service-now.com/now/nav/ui/classic/params/target/change_request.do%3Fsys_id%3D${ID}%26sysparm_stack%3D`, 'change_request'],
    [`https://acme.service-now.com/now/sow/record/incident/${ID}`, 'incident'],
    [`https://acme.service-now.com/now/sow/record/problem/${ID}/params/selected-tab-index/1`, 'problem'],
    [`https://acme.service-now.com/now/cwf/agent/record/sc_task/${ID.toUpperCase()}`, 'sc_task'],
    [`https://acme.service-now.com/now/workspace/agent/record/incident/${ID}`, 'incident'],
  ])('%s', (url, table) => {
    expect(parseSnowRecordUrl(url)).toEqual({ table, sysId: ID });
  });

  it.each([
    'https://acme.service-now.com/incident_list.do',
    'https://acme.service-now.com/incident.do?sys_id=-1',
    'https://acme.service-now.com/now/nav/ui/home',
    'not a url at all ::',
  ])('returns null for %s', (url) => {
    expect(parseSnowRecordUrl(url)).toBeNull();
  });
});

describe('numberToTable', () => {
  it.each([
    ['INC0012345', 'incident'],
    ['ritm0001234', 'sc_req_item'],
    ['SCTASK0001111', 'sc_task'],
    ['CHG0030001', 'change_request'],
    ['CTASK0001', 'change_task'],
    ['PRB0040001', 'problem'],
    ['XYZ0001', 'task'],
    ['garbage', 'task'],
  ])('%s → %s', (n, t) => expect(numberToTable(n)).toBe(t));

  it('recognises ticket numbers', () => {
    expect(isTicketNumber('INC0012345')).toBe(true);
    expect(isTicketNumber('hello')).toBe(false);
  });
});

describe('compactRecord', () => {
  it('keeps display values, adds raw UTC for dates, drops noise', () => {
    const out = compactRecord({
      number: { display_value: 'INC0012345', value: 'INC0012345' },
      opened_at: { display_value: '2026-11-19 10:00:00', value: '2026-11-19 09:00:00' },
      assignment_group: { display_value: 'Platform Ops', value: 'abc' },
      sys_mod_count: { display_value: '4', value: '4' },
      sys_id: { display_value: ID, value: ID },
      empty: { display_value: '', value: '' },
      active: { display_value: 'false', value: 'false' },
      description: { display_value: 'x'.repeat(70), value: 'x'.repeat(70) },
    }, 40);
    expect(out.number).toBe('INC0012345');
    expect(out.opened_at).toBe('2026-11-19 10:00:00 [UTC 2026-11-19 09:00:00]');
    expect(out.assignment_group).toBe('Platform Ops');
    expect(out.sys_id).toBe(ID);
    expect(out).not.toHaveProperty('sys_mod_count');
    expect(out).not.toHaveProperty('empty');
    expect(out).not.toHaveProperty('active');
    expect(out.description).toMatch(/^x{40} …\[truncated 30 chars\]$/);
  });
});
