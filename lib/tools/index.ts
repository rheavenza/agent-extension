import { tool } from 'ai';
import { z } from 'zod';
import { pageTextInPage } from '../injected';
import { addWorkNote, getJournal, getRecord, queryRecords } from '../servicenow/client';
import { numberToTable, parseSnowRecordUrl } from '../servicenow/url';
import type { Settings } from '../settings';
import { runSearch, showJobInTab, splunkTargetFromTab } from '../splunk/client';
import { riskySplCommands } from '../splunk/spl';
import { listTabs, resolveTab, runInTab } from '../tabs';

const tabIdSchema = z.number().int().optional().describe('Browser tab id from list_tabs. Omit to auto-pick.');

export function buildTools(s: Settings) {
  return {
    list_tabs: tool({
      description:
        'List the open browser tabs with their kind (servicenow / splunk / other). Call this first when you are unsure which tabs exist.',
      inputSchema: z.object({}),
      execute: async () => (await listTabs(s)).map(({ lastAccessed: _drop, ...t }) => t),
    }),

    read_page_text: tool({
      description:
        'Read the visible text of any open tab, including shadow DOM and same-origin iframes. Use it as a fallback when the API tools fail or for pages that are not ServiceNow or Splunk.',
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
        'Always set index= and a tight time range. Use stats/table/fields to keep results small. Commands that write or run code (delete, collect, outputlookup, sendemail, map, rest, script, ...) need user approval.',
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

    splunk_metadata: tool({
      description:
        'Discover what data exists in Splunk before writing searches: the indexes with event counts, or the sourcetypes/hosts/sources of an index.',
      inputSchema: z.object({
        kind: z.enum(['indexes', 'sourcetypes', 'hosts', 'sources']),
        index: z.string().optional().describe('Index to inspect for sourcetypes/hosts/sources. Default: all indexes you can see'),
        earliest: z.string().optional().describe('Default -7d'),
        tabId: tabIdSchema,
      }),
      execute: async ({ kind, index, earliest, tabId }) => {
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
        });
        return { kind, index: index ?? null, rows: res.results, messages: res.messages };
      },
    }),
  };
}

export type AgentTools = ReturnType<typeof buildTools>;

/** Which tool calls must be approved by the user before they run. */
export const toolApproval = {
  servicenow_add_note: { type: 'user-approval', reason: 'Writes to ServiceNow' },
  splunk_search: (input: { spl: string }) => {
    const risky = riskySplCommands(input.spl);
    return risky.length
      ? ({ type: 'user-approval', reason: `SPL uses write/exec commands: ${risky.join(', ')}` } as const)
      : ('not-applicable' as const);
  },
} as const;
