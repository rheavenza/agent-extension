import { describe, expect, it } from 'vitest';
import { tabsForAgent, type ListedTab } from '../lib/tabs';

const tab = (tabId: number, kind: ListedTab['kind'], title = `t${tabId}`): ListedTab => ({
  tabId,
  title,
  url: `https://example.test/${tabId}`,
  active: false,
  kind,
  lastAccessed: tabId,
});

describe('tabsForAgent', () => {
  it('shows ServiceNow and Splunk tabs, hides and counts the rest', () => {
    const r = tabsForAgent([tab(1, 'servicenow'), tab(2, 'other', 'Inbox – mail'), tab(3, 'splunk'), tab(4, 'other')], 99);
    expect(r.tabs.map((t) => t.tabId)).toEqual([1, 3]);
    expect(r.otherTabsHidden).toBe(2);
    expect(JSON.stringify(r)).not.toContain('Inbox');
    expect(r.tabs[0]).not.toHaveProperty('lastAccessed');
  });

  it('keeps the focused tab even when it is another site', () => {
    const r = tabsForAgent([tab(1, 'servicenow'), tab(2, 'other'), tab(3, 'other')], 2);
    expect(r.tabs.map((t) => t.tabId)).toEqual([1, 2]);
    expect(r.tabs[1]).toMatchObject({ focused: true });
    expect(r.otherTabsHidden).toBe(1);
  });
});
