import { splunkFetchInPage } from '../injected';
import { runInTab } from '../tabs';
import { compactResults, fitRowsToBudget, normalizeSpl, normalizeSplunkTime, parseSplunkUrl } from './spl';

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

const abortError = () => new DOMException('Aborted', 'AbortError');

/** Abortable sleep that cleans up its listener either way. */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(id);
      reject(abortError());
    };
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** cancel: stop and delete the job. finalize: stop it and keep the results found so far. */
export async function controlJob(t: SplunkTarget, sid: string, action: 'cancel' | 'finalize') {
  await call(t, `search/jobs/${encodeURIComponent(sid)}/control`, 'POST', { action, output_mode: 'json' });
}

export interface SearchOptions {
  spl: string;
  earliest?: string;
  latest?: string;
  maxResults: number;
  timeoutSec: number;
  signal?: AbortSignal;
}

/** Seconds of no polling after which Splunk cancels an unfinished job (covers a closed side panel). */
export const JOB_AUTO_CANCEL_SEC = 90;

export async function runSearch(t: SplunkTarget, o: SearchOptions) {
  const search = normalizeSpl(o.spl);
  const earliest = normalizeSplunkTime(o.earliest) ?? '-24h';
  const latest = normalizeSplunkTime(o.latest) ?? 'now';
  if (o.signal?.aborted) throw abortError();
  const created = await call(t, 'search/jobs', 'POST', {
    search,
    earliest_time: earliest,
    latest_time: latest,
    output_mode: 'json',
    exec_mode: 'normal',
    namespace: t.app,
    // Running jobs count against the user's concurrent-search quota. If we stop polling
    // (side panel closed, extension reloaded), let Splunk cancel the job on its own.
    auto_cancel: String(JOB_AUTO_CANCEL_SEC),
  });
  const sid: string = created.sid;
  if (!sid) throw new Error('Splunk did not return a search id (sid)');

  const poll = async () => {
    const j = await call(t, `search/jobs/${encodeURIComponent(sid)}?output_mode=json`);
    return (j.entry?.[0]?.content ?? {}) as any;
  };
  const settled = (c: any) => c.isDone || c.isFailed || c.dispatchState === 'FAILED';

  let content: any = {};
  let finalized = false;
  try {
    const deadline = Date.now() + o.timeoutSec * 1000;
    let delay = 500;
    while (true) {
      content = await poll();
      if (settled(content)) break;
      if (Date.now() > deadline) {
        // Stop the job instead of leaving it running, and keep what it found so far.
        await controlJob(t, sid, 'finalize').catch(() => undefined);
        finalized = true;
        for (let i = 0; i < 10 && !settled(content); i++) {
          await sleep(500, o.signal);
          content = await poll();
        }
        break;
      }
      await sleep(delay, o.signal);
      delay = Math.min(delay * 1.5, 3000);
    }
  } catch (e) {
    // Aborted by the user, or polling failed: don't leave the job running.
    controlJob(t, sid, 'cancel').catch(() => undefined);
    throw e;
  }

  const partial = !content.isDone || finalized || !!content.isFinalized;
  const jobMessages = Object.entries(content.messages ?? {}).flatMap(([type, msgs]) =>
    (Array.isArray(msgs) ? msgs : [msgs]).map((m) => `${type}: ${m}`),
  );
  if (content.isFailed || content.dispatchState === 'FAILED') {
    throw new Error(`Splunk search failed (sid ${sid}): ${jobMessages.join('; ') || 'unknown error'}`);
  }
  if (finalized) {
    jobMessages.unshift(
      `WARN: the search hit the ${o.timeoutSec}s timeout and was finalized; results cover only the part of the time range scanned so far. Narrow the search (index, host, terms, time range) rather than retrying it as is.`,
    );
  }

  const endpoint = content.isDone ? 'results' : 'results_preview';
  const r = await call(
    t,
    `search/jobs/${encodeURIComponent(sid)}/${endpoint}?output_mode=json&count=${o.maxResults}`,
  );
  const rows: Array<Record<string, unknown>> = r.results ?? [];
  const { rows: results, droppedForSize } = fitRowsToBudget(compactResults(rows, o.maxResults));
  const resultCount = Number(content.resultCount ?? rows.length);
  if (droppedForSize > 0) {
    jobMessages.push(
      `INFO: ${droppedForSize} more rows were fetched but left out to stay within the size budget. Use stats/table/fields to return fewer or smaller rows, or splunk_get_results with an offset to page.`,
    );
  }

  return {
    sid,
    search,
    earliest,
    latest,
    partial,
    finalized,
    dispatchState: content.dispatchState as string | undefined,
    resultCount,
    eventCount: Number(content.eventCount ?? 0),
    scanCount: Number(content.scanCount ?? 0),
    returned: results.length,
    truncated: resultCount > results.length,
    fields: fieldNames(r.fields),
    messages: [...jobMessages, ...(r.messages ?? []).map((m: any) => `${m.type}: ${m.text}`)],
    results,
    viewUrl: `${t.origin}${t.base}/app/${encodeURIComponent(t.app)}/search?sid=${encodeURIComponent(sid)}`,
  };
}

function fieldNames(fields: unknown): string[] {
  return ((fields as any[]) ?? [])
    .map((f: any) => (typeof f === 'string' ? f : f.name))
    .filter((n: string) => !n.startsWith('_') || n === '_time' || n === '_raw');
}

/** Read more rows from an existing job without running the search again. */
export async function getResults(
  t: SplunkTarget,
  o: { sid: string; offset: number; count: number; fields?: string[] },
) {
  const job = await call(t, `search/jobs/${encodeURIComponent(o.sid)}?output_mode=json`);
  const content = job.entry?.[0]?.content ?? {};
  const endpoint = content.isDone ? 'results' : 'results_preview';
  const fieldParams = (o.fields ?? []).map((f) => `&f=${encodeURIComponent(f)}`).join('');
  const r = await call(
    t,
    `search/jobs/${encodeURIComponent(o.sid)}/${endpoint}?output_mode=json&offset=${o.offset}&count=${o.count}${fieldParams}`,
  );
  const { rows: results, droppedForSize } = fitRowsToBudget(compactResults(r.results ?? [], o.count));
  const resultCount = Number(content.resultCount ?? 0);
  return {
    sid: o.sid,
    offset: o.offset,
    returned: results.length,
    resultCount,
    nextOffset: o.offset + results.length < resultCount ? o.offset + results.length : null,
    droppedForSize,
    fields: fieldNames(r.fields),
    messages: (r.messages ?? []).map((m: any) => `${m.type}: ${m.text}`),
    results,
  };
}

const AGENT_TAB_KEY = 'splunk:agentTabId';
let agentTabCache: number | undefined;

async function getAgentTabId(): Promise<number | undefined> {
  if (agentTabCache != null) return agentTabCache;
  try {
    const r = await chrome.storage?.session?.get(AGENT_TAB_KEY);
    agentTabCache = (r?.[AGENT_TAB_KEY] as number | undefined) ?? undefined;
  } catch {
    /* session storage unavailable */
  }
  return agentTabCache;
}

async function setAgentTabId(id: number | undefined) {
  agentTabCache = id;
  try {
    await chrome.storage?.session?.set({ [AGENT_TAB_KEY]: id ?? null });
  } catch {
    /* ignore */
  }
}

/** For tests. */
export function resetAgentTab() {
  agentTabCache = undefined;
}

/**
 * Show a finished job in a Splunk tab the agent owns, so the user can see the same results.
 * The user's own Splunk tabs are never navigated: that would throw away a search they were
 * writing. The agent tab opens once, in the background next to the user's tab, and is reused.
 */
export async function showJobInTab(t: SplunkTarget, viewUrl: string): Promise<number | undefined> {
  const existing = await getAgentTabId();
  if (existing != null) {
    const tab = await chrome.tabs.get(existing).catch(() => undefined);
    if (tab?.url && new URL(tab.url).origin === t.origin) {
      await chrome.tabs.update(existing, { url: viewUrl });
      return existing;
    }
  }
  const userTab = await chrome.tabs.get(t.tabId).catch(() => undefined);
  const created = await chrome.tabs.create({
    url: viewUrl,
    active: false,
    ...(userTab ? { windowId: userTab.windowId, index: userTab.index + 1, openerTabId: userTab.id } : {}),
  });
  await setAgentTabId(created.id);
  return created.id;
}
