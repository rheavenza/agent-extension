import { afterEach, describe, expect, it } from 'vitest';
import { runSearch, sleep, type SplunkTarget } from '../lib/splunk/client';

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
