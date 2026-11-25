import { urlMatchesAny } from './match';
import type { Settings } from './settings';

export type TabKind = 'servicenow' | 'splunk' | 'other';

export function tabKind(url: string | undefined, s: Settings): TabKind {
  if (urlMatchesAny(url, s.servicenowPatterns)) return 'servicenow';
  if (urlMatchesAny(url, s.splunkPatterns)) return 'splunk';
  return 'other';
}

export async function listTabs(s: Settings) {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => t.id != null && t.url && !t.url.startsWith('chrome-extension://'))
    .map((t) => ({
      tabId: t.id!,
      title: t.title ?? '',
      url: t.url ?? '',
      active: t.active,
      kind: tabKind(t.url, s),
      lastAccessed: (t as chrome.tabs.Tab & { lastAccessed?: number }).lastAccessed ?? 0,
    }));
}

export type ListedTab = Awaited<ReturnType<typeof listTabs>>[number];

/**
 * What the model gets from list_tabs: ServiceNow and Splunk tabs, plus the tab the user is looking
 * at right now (so "read this page" still works). Titles and URLs of every other tab (mail, HR,
 * banking, ...) stay out of the prompt, which goes to a third-party API; only their count is shared.
 */
export function tabsForAgent(tabs: ListedTab[], focusedTabId: number | undefined) {
  const shown = tabs.filter((t) => t.kind !== 'other' || t.tabId === focusedTabId);
  return {
    tabs: shown.map(({ lastAccessed: _drop, ...t }) => ({
      ...t,
      ...(t.tabId === focusedTabId ? { focused: true } : {}),
    })),
    otherTabsHidden: tabs.length - shown.length,
  };
}

/** Use the given tab, otherwise the active tab of this kind, otherwise the most recently used one. */
export async function resolveTab(s: Settings, kind: Exclude<TabKind, 'other'>, tabId?: number): Promise<chrome.tabs.Tab> {
  if (tabId != null) {
    const t = await chrome.tabs.get(tabId);
    if (!t) throw new Error(`Tab ${tabId} not found`);
    return t;
  }
  const tabs = (await chrome.tabs.query({})).filter((t) => tabKind(t.url, s) === kind);
  if (!tabs.length) {
    const patterns = kind === 'servicenow' ? s.servicenowPatterns : s.splunkPatterns;
    throw new Error(
      `No open ${kind} tab found (patterns: ${patterns.join(', ')}). Open one, or fix the URL patterns in Settings.`,
    );
  }
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const active = tabs.find((t) => t.id === focused?.id) ?? tabs.find((t) => t.active);
  if (active) return active;
  return tabs.sort(
    (a, b) =>
      ((b as { lastAccessed?: number }).lastAccessed ?? 0) - ((a as { lastAccessed?: number }).lastAccessed ?? 0),
  )[0];
}

async function waitForTabComplete(tabId: number, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function runInTab<A extends unknown[], R>(
  tabId: number,
  func: (...args: A) => R,
  args: A,
  world: 'MAIN' | 'ISOLATED' = 'ISOLATED',
): Promise<Awaited<R>> {
  await waitForTabComplete(tabId);
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world,
      func: func as (...a: unknown[]) => unknown,
      args: args as unknown[],
    });
    if (!res) throw new Error('Script injection returned no result');
    return res.result as Awaited<R>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Cannot access|permission|host/i.test(msg)) {
      throw new Error(
        `The extension has no access to this tab's site. Open the extension Settings, add the site's URL pattern, and click "Save & grant access". (${msg})`,
      );
    }
    throw e;
  }
}
