import { tool } from 'ai';
import { z } from 'zod';
import { pageTextInPage } from '../injected';
import { addWorkNote, getJournal, getRecord, queryRecords } from '../servicenow/client';
import { numberToTable, parseSnowRecordUrl } from '../servicenow/url';
import type { Settings } from '../settings';
import { getResults, runSearch, showJobInTab, splunkTargetFromTab } from '../splunk/client';
import { splApprovalReasons } from '../splunk/spl';
import { DEFAULT_SETTINGS } from '../settings';
import { listTabs, resolveTab, runInTab, tabsForAgent } from '../tabs';

const tabIdSchema = z.number().int().optional().describe('Browser tab id from list_tabs. Omit to auto-pick.');

export function buildTools(s: Settings) {
  return {
    list_tabs: tool({
      description:
        'List the open ServiceNow and Splunk tabs, plus the tab the user is currently looking at (focused: true). Other tabs are not shown, only counted. Call this first when you are unsure which tabs exist.',
      inputSchema: z.object({}),
      execute: async () => {
        const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return tabsForAgent(await listTabs(s), focused?.id);
      },
    }),

    read_page_text: tool({
      description:
        'Read the visible text of a tab from list_tabs, including shadow DOM and same-origin iframes. Use it as a fallback when the API tools fail, or for the page the user is looking at. It only works on sites the user granted access to in Settings.',
      inputSchema: z.object({
        tabId: z.number().int().describe('Tab id from list_tabs'),
        maxChars: z.number().int().min(1000).max(100_000).optional().describe('Default 20000'),
      }),
      execute: async ({ tabId, maxChars }) => runInTab(tabId, pageTextInPage, [maxChars ?? 20_000], 'ISOLATED'),
    }),

    read_servicenow_ticket: tool({
      description:
        'Read a ServiceNow ticket (incident, RITM, change, problem, sc_task, ...) through the REST API using the user\'s session in an open ServiceNow tab. ' +
        'With no number, it reads the record currently open in the ServiceNow tab. Returns the fields as display values (date fields also include their raw UTC value) plus the journal (comments/work notes) when accessible.',
      inputSchema: z.object({
        number: z.string().optional().describe('Ticket number, e.g. INC0012345 or RITM0001234'),
        tabId: tabIdSchema,
        includeJournal: z.boolean().optional().describe('Default true'),
      }),
      execute: async ({ number, tabId, includeJournal = true }) => {
        const tab = await resolveTab(s, 'servicenow', tabId);
        const ref = tab.url ? parseSnowRecordUrl(tab.url) : null;
        let res;
        if (number) res = await getRecord(tab.id!, { table: numberToTable(number), number });
        else if (ref) res = await getRecord(tab.id!, { table: ref.table, sysId: ref.sysId });
        else
          throw new Error(
            `The ServiceNow tab (${tab.url}) is not on a record form. Pass a ticket number, or use read_page_text on tab ${tab.id}.`,
          );
        const journal = includeJournal ? await getJournal(tab.id!, res.sysId) : null;
        return { tabId: tab.id, table: res.table, sys_id: res.sysId, fields: res.record, journal };
      },
    }),

    servicenow_query: tool({
      description:
        'Query ServiceNow records with an encoded query, e.g. the tickets the user opened: table "incident", query "opened_by=javascript:gs.getUserID()^active=true^ORDERBYDESCopened_at".',
      inputSchema: z.object({
        table: z.string().describe('incident, sc_req_item, change_request, problem, sc_task, task, ...'),
        query: z.string().describe('ServiceNow encoded query'),
        limit: z.number().int().min(1).max(50).optional().describe('Default 10'),
        fields: z
          .array(z.string())
          .optional()
          .describe('Default: number, short_description, state, priority, opened_at, assignment_group, cmdb_ci'),
        tabId: tabIdSchema,
      }),
      execute: async ({ table, query, limit = 10, fields, tabId }) => {
        const tab = await resolveTab(s, 'servicenow', tabId);
        const f = fields?.length
          ? fields
          : ['number', 'short_description', 'state', 'priority', 'opened_at', 'assignment_group', 'cmdb_ci', 'sys_id'];
        return queryRecords(tab.id!, table, query, limit, f);
      },
    }),

    servicenow_add_note: tool({
      description:
        'Add a work note (internal) or an additional comment (customer-visible) to a ServiceNow record. This WRITES data; the user must approve each call.',
      inputSchema: z.object({
        table: z.string(),
        sys_id: z.string().regex(/^[0-9a-f]{32}$/i),
        text: z.string().min(1),
        field: z.enum(['work_notes', 'comments']).optional().describe('Default work_notes'),
        tabId: tabIdSchema,
      }),
      execute: async ({ table, sys_id, text, field = 'work_notes', tabId }) => {
        const tab = await resolveTab(s, 'servicenow', tabId);
        const r = await addWorkNote(tab.id!, table, sys_id, text, field);
        return { ok: true, updated: r };
      },
    }),

    splunk_search: tool({
      description:
        'Run an SPL search through the user\'s open Splunk tab and return the results (capped). ' +
        'Times can be Splunk modifiers (-24h, -15m@m, @d, now), epoch seconds, ISO 8601 with timezone, or "YYYY-MM-DD HH:MM:SS" (treated as UTC). ' +
        'Always set index= and a tight time range. Use stats/table/fields to keep results small. Commands that write or run code (delete, collect, outputlookup, sendemail, map, rest, script, savedsearch, ...) and search macros the user has not marked as trusted need user approval.',
      inputSchema: z.object({
        spl: z.string().describe('SPL query; a leading "search" is added if missing'),
        earliest: z.string().optional().describe('Default -24h'),
        latest: z.string().optional().describe('Default now'),
        maxResults: z.number().int().min(1).max(500).optional(),
        tabId: tabIdSchema,
      }),
      execute: async ({ spl, earliest, latest, maxResults, tabId }, { abortSignal }) => {
        const tab = await resolveTab(s, 'splunk', tabId);
        const target = splunkTargetFromTab(tab, s.splunkDefaultApp);
        const res = await runSearch(target, {
          spl,
          earliest,
          latest,
          maxResults: maxResults ?? s.splunkMaxResults,
          timeoutSec: s.splunkSearchTimeoutSec,
          signal: abortSignal,
        });
        if (s.splunkSyncTab) await showJobInTab(target, res.viewUrl).catch(() => undefined);
        return { tabId: tab.id, ...res };
      },
    }),

    splunk_get_results: tool({
      description:
        'Read more rows from a Splunk search job that already ran (by sid), without running it again. Use it to page past the first rows, to pick specific fields, or to re-read an older result that was trimmed from context. Jobs expire after about 10 minutes; if the sid is gone, run the search again.',
      inputSchema: z.object({
        sid: z.string().min(1).describe('The sid returned by splunk_search'),
        offset: z.number().int().min(0).optional().describe('First row to return. Default 0'),
        count: z.number().int().min(1).max(200).optional().describe('Default 50'),
        fields: z.array(z.string()).optional().describe('Only return these fields'),
        tabId: tabIdSchema,
      }),
      execute: async ({ sid, offset = 0, count = 50, fields, tabId }) => {
        const tab = await resolveTab(s, 'splunk', tabId);
        const target = splunkTargetFromTab(tab, s.splunkDefaultApp);
        return getResults(target, { sid, offset, count, fields });
      },
    }),

    splunk_metadata: tool({
      description:
        'Discover what data exists in Splunk before writing searches: the indexes with event counts, or the sourcetypes/hosts/sources of an index.',
      inputSchema: z.object({
        kind: z.enum(['indexes', 'sourcetypes', 'hosts', 'sources']),
        index: z.string().optional().describe('Index to inspect for sourcetypes/hosts/sources. Default: all indexes you can see'),
        earliest: z.string().optional().describe('Default -7d'),
        tabId: tabIdSchema,
      }),
      execute: async ({ kind, index, earliest, tabId }, { abortSignal }) => {
        const tab = await resolveTab(s, 'splunk', tabId);
        const target = splunkTargetFromTab(tab, s.splunkDefaultApp);
        const idx = index ? `index=${JSON.stringify(index)}` : 'index=*';
        const spl =
          kind === 'indexes'
            ? '| eventcount summarize=false index=* | stats sum(count) as events by index | sort - events'
            : `| metadata type=${kind} ${idx} | sort - totalCount | head 200 | eval lastTime=strftime(lastTime, "%F %T") | table ${kind.slice(0, -1)} totalCount lastTime`;
        const res = await runSearch(target, {
          spl,
          earliest: earliest ?? '-7d',
          latest: 'now',
          maxResults: 200,
          timeoutSec: s.splunkSearchTimeoutSec,
          signal: abortSignal,
        });
        return { kind, index: index ?? null, rows: res.results, messages: res.messages };
      },
    }),
  };
}

export type AgentTools = ReturnType<typeof buildTools>;

/** Which tool calls must be approved by the user before they run. */
export function buildToolApproval(s: Pick<Settings, 'splunkTrustedMacros'>) {
  return {
    servicenow_add_note: (input: { field?: 'work_notes' | 'comments'; table?: string }) =>
      ({
        type: 'user-approval',
        reason:
          input.field === 'comments'
            ? `Adds a CUSTOMER-VISIBLE comment to ${input.table ?? 'the record'}`
            : `Adds an internal work note to ${input.table ?? 'the record'}`,
      }) as const,
    splunk_search: (input: { spl: string }) => {
      const reasons = splApprovalReasons(input.spl, s.splunkTrustedMacros ?? []);
      return reasons.length
        ? ({ type: 'user-approval', reason: reasons.join('. ') } as const)
        : ('not-applicable' as const);
    },
  } as const;
}

/** Approval rules under the default settings (no trusted macros). */
export const toolApproval = buildToolApproval(DEFAULT_SETTINGS);
