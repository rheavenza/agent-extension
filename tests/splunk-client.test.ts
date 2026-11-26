import { afterEach, describe, expect, it } from 'vitest';
import {
  getFieldSummary,
  listKnowledge,
  resetAgentTab,
  runSearch,
  showJobInTab,
  sleep,
  validateSpl,
  type SplunkTarget,
} from '../lib/splunk/client';

const target: SplunkTarget = { tabId: 7, origin: 'https://splunk.test', base: '/en-US', app: 'search' };

interface Call {
  url: string;
  method: string;
  form: Record<string, string> | null;
}

/** Fake chrome.scripting that answers the Splunk REST calls made through runInTab. */
function fakeSplunk(job: { doneAfterPolls?: number; doneAfterFinalize?: boolean }) {
  const calls: Call[] = [];
  let polls = 0;
  let finalized = false;
  const reply = (body: unknown) => [
    { result: { ok: true, status: 200, text: JSON.stringify(body), hasToken: true, url: '' } },
  ];
  (globalThis as any).chrome = {
    tabs: { get: async () => ({ id: 7, status: 'complete' }) },
    scripting: {
      executeScript: async ({ args: [url, method, form] }: { args: [string, string, Record<string, string> | null] }) => {
        calls.push({ url, method, form });
        if (url.endsWith('/services/search/jobs') && method === 'POST') return reply({ sid: 'sid1' });
        if (url.includes('/control')) {
          if (form?.action === 'finalize') finalized = true;
          return reply({ messages: [] });
        }
        if (url.includes('/search/jobs/sid1?')) {
          polls++;
          const done = (job.doneAfterPolls != null && polls >= job.doneAfterPolls) || (finalized && job.doneAfterFinalize);
          return reply({
            entry: [{ content: { isDone: !!done, isFinalized: finalized, dispatchState: done ? 'DONE' : 'RUNNING', resultCount: 1 } }],
          });
        }
        if (url.includes('/results')) return reply({ results: [{ host: 'h1' }], fields: ['host'] });
        throw new Error(`unexpected ${method} ${url}`);
      },
    },
  };
  return calls;
}

afterEach(() => {
  delete (globalThis as any).chrome;
});

describe('runSearch job lifecycle', () => {
  it('asks Splunk to auto-cancel abandoned jobs', async () => {
    const calls = fakeSplunk({ doneAfterPolls: 1 });
    const r = await runSearch(target, { spl: 'index=a', maxResults: 10, timeoutSec: 30 });
    expect(calls[0].form?.auto_cancel).toBe('90');
    expect(calls[0].form?.status_buckets).toBe('300');
    expect(r.partial).toBe(false);
    expect(r.finalized).toBe(false);
    expect(calls.some((c) => c.url.includes('/control'))).toBe(false);
  });

  it('finalizes a job that hits the timeout and returns what it found', async () => {
    const calls = fakeSplunk({ doneAfterFinalize: true });
    const r = await runSearch(target, { spl: 'index=a', maxResults: 10, timeoutSec: 0 });
    const control = calls.filter((c) => c.url.includes('/control'));
    expect(control.map((c) => c.form?.action)).toEqual(['finalize']);
    expect(r.finalized).toBe(true);
    expect(r.partial).toBe(true);
    expect(r.messages[0]).toMatch(/finalized/);
    expect(r.results).toEqual([{ host: 'h1' }]);
  });

  it('cancels the job when the user stops the turn', async () => {
    const calls = fakeSplunk({});
    const ac = new AbortController();
    const p = runSearch(target, { spl: 'index=a', maxResults: 10, timeoutSec: 60, signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toThrow(/Abort/);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.url.includes('/control')).map((c) => c.form?.action)).toEqual(['cancel']);
  });

  it('does not start a job when already aborted', async () => {
    const calls = fakeSplunk({});
    const ac = new AbortController();
    ac.abort();
    await expect(runSearch(target, { spl: 'index=a', maxResults: 10, timeoutSec: 60, signal: ac.signal })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('sleep', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleep(10_000, ac.signal)).rejects.toThrow(/Abort/);
  });
});

describe('showJobInTab', () => {
  function fakeTabs(initial: Array<{ id: number; url: string; windowId?: number; index?: number }>) {
    const tabs = new Map(initial.map((t) => [t.id, { windowId: 1, index: 0, ...t }]));
    const updates: Array<[number, string]> = [];
    const creates: any[] = [];
    let nextId = 100;
    (globalThis as any).chrome = {
      storage: { session: { get: async () => ({}), set: async () => {} } },
      tabs: {
        get: async (id: number) => {
          const t = tabs.get(id);
          if (!t) throw new Error('No tab');
          return t;
        },
        update: async (id: number, { url }: { url: string }) => {
          updates.push([id, url]);
          tabs.get(id)!.url = url;
        },
        create: async (o: any) => {
          creates.push(o);
          const t = { id: nextId++, url: o.url, windowId: o.windowId ?? 1, index: o.index ?? 0 };
          tabs.set(t.id, t);
          return t;
        },
      },
    };
    return { tabs, updates, creates };
  }

  it("opens one background tab next to the user's tab and reuses it, never navigating the user's tab", async () => {
    resetAgentTab();
    const f = fakeTabs([{ id: 7, url: 'https://splunk.test/en-US/app/search/search?q=draft', index: 3 }]);
    const first = await showJobInTab(target, 'https://splunk.test/en-US/app/search/search?sid=a');
    const second = await showJobInTab(target, 'https://splunk.test/en-US/app/search/search?sid=b');
    expect(f.creates).toEqual([
      { url: 'https://splunk.test/en-US/app/search/search?sid=a', active: false, windowId: 1, index: 4, openerTabId: 7 },
    ]);
    expect(first).toBe(100);
    expect(second).toBe(100);
    expect(f.updates).toEqual([[100, 'https://splunk.test/en-US/app/search/search?sid=b']]);
    expect(f.tabs.get(7)!.url).toContain('q=draft');
  });

  it('opens a new tab when the agent tab was closed', async () => {
    resetAgentTab();
    const f = fakeTabs([{ id: 7, url: 'https://splunk.test/' }]);
    await showJobInTab(target, 'https://splunk.test/x?sid=a');
    f.tabs.delete(100);
    const id = await showJobInTab(target, 'https://splunk.test/x?sid=b');
    expect(id).toBe(101);
    expect(f.creates).toHaveLength(2);
  });
});

/** Fake Splunk that answers GETs from a table of URL prefixes. */
function fakeGet(routes: Array<[RegExp, { status?: number; body: unknown }]>) {
  const urls: string[] = [];
  (globalThis as any).chrome = {
    tabs: { get: async () => ({ id: 7, status: 'complete' }) },
    scripting: {
      executeScript: async ({ args: [url] }: { args: [string] }) => {
        urls.push(url);
        const hit = routes.find(([re]) => re.test(url));
        if (!hit) throw new Error(`unexpected ${url}`);
        const status = hit[1].status ?? 200;
        return [{ result: { ok: status < 400, status, text: JSON.stringify(hit[1].body), hasToken: true, url } }];
      },
    },
  };
  return urls;
}

describe('Splunk insight calls', () => {
  it('reads the job field summary with top_count and field filters', async () => {
    const urls = fakeGet([[/\/summary\?/, { body: { event_count: 4, fields: { host: { count: 4, distinct_count: 1, modes: [{ value: 'h', count: 4 }] } } } }]]);
    const r = await getFieldSummary(target, { sid: 'a b', fields: ['host'], topN: 3 });
    expect(urls[0]).toBe('/en-US/splunkd/__raw/services/search/jobs/a%20b/summary?output_mode=json&top_count=3&min_freq=0&f=host');
    expect(r).toEqual({ sid: 'a b', event_count: 4, fields: { host: { coverage: 1, distinct: 1, top: [['h', 4]] } } });
  });

  it('parses SPL with parse_only and reports risky commands hidden in macros', async () => {
    const urls = fakeGet([
      [/\/search\/parser\?/, { body: { commands: [{ command: 'search', rawargs: 'index=a' }, { command: 'outputlookup', rawargs: 'x.csv' }] } }],
    ]);
    const r = await validateSpl(target, 'index=a | `m`');
    expect(urls[0]).toContain('parse_only=true');
    expect(urls[0]).toContain(`q=${encodeURIComponent('search index=a | `m`')}`);
    expect(r).toEqual({
      valid: true,
      commands: ['search', 'outputlookup'],
      expanded: 'search index=a | outputlookup x.csv',
      risky_commands_after_expansion: ['outputlookup'],
    });
  });

  it('returns a syntax error instead of throwing', async () => {
    fakeGet([[/\/search\/parser\?/, { status: 400, body: { messages: [{ type: 'FATAL', text: 'Unknown search command "statz".' }] } }]]);
    const r = await validateSpl(target, 'index=a | statz count');
    expect(r).toMatchObject({ valid: false });
    expect((r as any).error).toContain('Unknown search command');
  });

  it('lists knowledge objects across apps through servicesNS', async () => {
    const urls = fakeGet([[/servicesNS\/-\/-\/saved\/searches/, { body: { paging: { total: 1 }, entry: [{ name: 'S', acl: { app: 'a' }, content: { search: 'index=a' } }] } }]]);
    const r = await listKnowledge(target, { kind: 'saved_searches', filter: 'pay' });
    expect(urls[0]).toBe('/en-US/splunkd/__raw/servicesNS/-/-/saved/searches?output_mode=json&count=25&search=pay');
    expect(r.total).toBe(1);
    expect(r.items[0]).toMatchObject({ name: 'S', search: 'index=a' });
  });
});
