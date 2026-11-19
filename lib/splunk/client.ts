import { splunkFetchInPage } from '../injected';
import { runInTab } from '../tabs';
import { compactResults, normalizeSpl, normalizeSplunkTime, parseSplunkUrl } from './spl';

export interface SplunkTarget {
  tabId: number;
  origin: string;
  base: string; // e.g. "/en-US"
  app: string;
}

export function splunkTargetFromTab(tab: chrome.tabs.Tab, defaultApp: string): SplunkTarget {
  const p = tab.url ? parseSplunkUrl(tab.url) : null;
  if (!p || tab.id == null) throw new Error(`Can't parse the Splunk tab URL: ${tab.url}`);
  return { tabId: tab.id, origin: p.origin, base: p.base, app: p.app ?? defaultApp };
}

async function call(t: SplunkTarget, path: string, method = 'GET', form?: Record<string, string>) {
  const url = `${t.base}/splunkd/__raw/services/${path}`;
  const res = await runInTab(t.tabId, splunkFetchInPage, [url, method, form ?? null], 'ISOLATED');
  let json: any = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const msg = json?.messages?.map((m: any) => `${m.type}: ${m.text}`).join('; ') ?? res.text.slice(0, 300);
    const hint =
      res.status === 401 || res.status === 403
        ? res.hasToken
          ? ' Your Splunk session may have expired. Reload or log in to the Splunk tab.'
          : ' No splunkweb_csrf_token cookie was found. Reload the Splunk tab.'
        : '';
    throw new Error(`Splunk ${method} ${path.split('?')[0]} → HTTP ${res.status}: ${msg}.${hint}`);
  }
  if (json == null) throw new Error(`Splunk returned non-JSON for ${path}. The session may have expired.`);
  return json;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(id);
      reject(new Error('Aborted'));
    });
  });

export interface SearchOptions {
  spl: string;
  earliest?: string;
  latest?: string;
  maxResults: number;
  timeoutSec: number;
  signal?: AbortSignal;
}

export async function runSearch(t: SplunkTarget, o: SearchOptions) {
  const search = normalizeSpl(o.spl);
  const earliest = normalizeSplunkTime(o.earliest) ?? '-24h';
  const latest = normalizeSplunkTime(o.latest) ?? 'now';
  const created = await call(t, 'search/jobs', 'POST', {
    search,
    earliest_time: earliest,
    latest_time: latest,
    output_mode: 'json',
    exec_mode: 'normal',
    namespace: t.app,
  });
  const sid: string = created.sid;
  if (!sid) throw new Error('Splunk did not return a search id (sid)');

  const deadline = Date.now() + o.timeoutSec * 1000;
  let content: any = {};
  let delay = 500;
  while (true) {
    const j = await call(t, `search/jobs/${encodeURIComponent(sid)}?output_mode=json`);
    content = j.entry?.[0]?.content ?? {};
    if (content.isDone || content.isFailed || content.dispatchState === 'FAILED') break;
    if (Date.now() > deadline) break;
    await sleep(delay, o.signal);
    delay = Math.min(delay * 1.5, 3000);
  }
  const partial = !content.isDone;
  const jobMessages = Object.entries(content.messages ?? {}).flatMap(([type, msgs]) =>
    (Array.isArray(msgs) ? msgs : [msgs]).map((m) => `${type}: ${m}`),
  );
  if (content.isFailed || content.dispatchState === 'FAILED') {
    throw new Error(`Splunk search failed (sid ${sid}): ${jobMessages.join('; ') || 'unknown error'}`);
  }

  const endpoint = partial ? 'results_preview' : 'results';
  const r = await call(
    t,
    `search/jobs/${encodeURIComponent(sid)}/${endpoint}?output_mode=json&count=${o.maxResults}`,
  );
  const rows: Array<Record<string, unknown>> = r.results ?? [];
  const results = compactResults(rows, o.maxResults);
  const resultCount = Number(content.resultCount ?? rows.length);

  return {
    sid,
    search,
    earliest,
    latest,
    partial,
    dispatchState: content.dispatchState as string | undefined,
    resultCount,
    eventCount: Number(content.eventCount ?? 0),
    scanCount: Number(content.scanCount ?? 0),
    returned: results.length,
    truncated: resultCount > results.length,
    fields: (r.fields ?? []).map((f: any) => (typeof f === 'string' ? f : f.name)).filter((n: string) => !n.startsWith('_') || n === '_time' || n === '_raw'),
    messages: [...jobMessages, ...(r.messages ?? []).map((m: any) => `${m.type}: ${m.text}`)],
    results,
    viewUrl: `${t.origin}${t.base}/app/${encodeURIComponent(t.app)}/search?sid=${encodeURIComponent(sid)}`,
  };
}

/** Point the user's Splunk tab at the finished job so they can see the same results. */
export async function showJobInTab(t: SplunkTarget, viewUrl: string) {
  await chrome.tabs.update(t.tabId, { url: viewUrl });
}
