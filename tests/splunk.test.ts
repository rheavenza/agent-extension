import { describe, expect, it } from 'vitest';
import {
  compactResults,
  normalizeSpl,
  normalizeSplunkTime,
  parseSplunkUrl,
  riskySplCommands,
  splApprovalReasons,
  splCommands,
  splMacros,
} from '../lib/splunk/spl';

describe('SPL guard', () => {
  it('finds commands across pipes and subsearches', () => {
    expect(splCommands('index=app error | stats count by host | sort - count')).toEqual(['index', 'stats', 'sort']);
    expect(splCommands('| tstats count where index=* by index')).toEqual(['tstats']);
  });

  it.each([
    ['index=app error | stats count by host', []],
    ['index=app | delete', ['delete']],
    ['index=app | stats count | outputlookup foo.csv', ['outputlookup']],
    ['index=app [ search index=x | rest /services/apps/local ]', ['rest']],
    ['index=app | map search="search index=x $host$"', ['map']],
    ['index=app "error | delete" | stats count', []],
    ["index=app message='a | sendemail' | head 5", []],
    ['| REST /services/server/info', ['rest']],
    ['index=app | collect index=summary | sendemail to=x@y', ['collect', 'sendemail']],
  ])('%s', (spl, risky) => {
    expect(riskySplCommands(spl)).toEqual(risky);
  });
});

describe('SPL macros and saved searches', () => {
  it('finds macros with and without arguments', () => {
    expect(splMacros('`cim_auth` action=failure | `drop_dm(foo, bar)` | `noargs()`')).toEqual([
      'cim_auth',
      'drop_dm(2)',
      'noargs(0)',
    ]);
    expect(splMacros('index=app error | stats count')).toEqual([]);
  });

  it('asks for approval on untrusted macros and savedsearch', () => {
    expect(splApprovalReasons('index=app | stats count by host')).toEqual([]);
    expect(splApprovalReasons('index=app | `write_it`')[0]).toMatch(/macros.*`write_it`/);
    expect(splApprovalReasons('| savedsearch "Nightly cleanup"')[0]).toMatch(/savedsearch/);
    expect(splApprovalReasons('| runshellscript x.sh')[0]).toMatch(/runshellscript/);
  });

  it('lets trusted macros through, by name or name(arity)', () => {
    expect(splApprovalReasons('`CIM_Auth` | stats count', ['cim_auth'])).toEqual([]);
    expect(splApprovalReasons('`m(a,b)` | stats count', ['m(2)'])).toEqual([]);
    expect(splApprovalReasons('`m(a,b)` | stats count', ['m'])).toEqual([]);
    expect(splApprovalReasons('`m(a)` | stats count', ['m(2)'])).toHaveLength(1);
  });

  it('reports both a risky command and an untrusted macro', () => {
    expect(splApprovalReasons('`x` | outputlookup y.csv')).toHaveLength(2);
  });
});

describe('normalizeSpl', () => {
  it('prefixes search when needed', () => {
    expect(normalizeSpl('index=app error')).toBe('search index=app error');
    expect(normalizeSpl('  search index=app')).toBe('search index=app');
    expect(normalizeSpl('| tstats count')).toBe('| tstats count');
  });
});

describe('normalizeSplunkTime', () => {
  it('passes relative modifiers through', () => {
    expect(normalizeSplunkTime('-24h')).toBe('-24h');
    expect(normalizeSplunkTime('-15m@m')).toBe('-15m@m');
    expect(normalizeSplunkTime('now')).toBe('now');
    expect(normalizeSplunkTime('1763542800')).toBe('1763542800');
    expect(normalizeSplunkTime(undefined)).toBeUndefined();
    expect(normalizeSplunkTime('  ')).toBeUndefined();
  });
  it('converts absolute times to epoch seconds (naive = UTC)', () => {
    expect(normalizeSplunkTime('2026-11-19 09:00:00')).toBe(String(Date.UTC(2026, 10, 19, 9) / 1000));
    expect(normalizeSplunkTime('2026-11-19T09:00:00Z')).toBe(String(Date.UTC(2026, 10, 19, 9) / 1000));
    expect(normalizeSplunkTime('2026-11-19T10:00:00+01:00')).toBe(String(Date.UTC(2026, 10, 19, 9) / 1000));
  });
});

describe('parseSplunkUrl', () => {
  it('handles locale, app and root_endpoint prefixes', () => {
    expect(parseSplunkUrl('https://splunk.corp:8000/en-US/app/search/search?q=foo')).toEqual({
      origin: 'https://splunk.corp:8000',
      base: '/en-US',
      app: 'search',
    });
    expect(parseSplunkUrl('https://corp.example.com/splunk/en-GB/app/my_app/dashboards')).toEqual({
      origin: 'https://corp.example.com',
      base: '/splunk/en-GB',
      app: 'my_app',
    });
    expect(parseSplunkUrl('https://x.splunkcloud.com/')).toEqual({ origin: 'https://x.splunkcloud.com', base: '/en-US', app: null });
  });
});

describe('compactResults', () => {
  it('drops internal fields and caps rows/values', () => {
    const rows = [
      { _time: 't', _raw: 'r'.repeat(10), _bkt: 'b', _cd: 'c', host: 'h1', date_hour: '9', punct: '..', mv: Array.from({ length: 25 }, (_, i) => String(i)) },
      { host: 'h2' },
      { host: 'h3' },
    ];
    const out = compactResults(rows, 2, 5);
    expect(out).toHaveLength(2);
    expect(Object.keys(out[0]).sort()).toEqual(['_raw', '_time', 'host', 'mv']);
    expect(out[0]._raw).toBe('rrrrr …[truncated]');
    expect((out[0].mv as string[]).length).toBe(21);
    expect((out[0].mv as string[])[20]).toBe('…(+5 more)');
  });
});
