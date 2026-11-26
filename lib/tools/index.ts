import { tool } from 'ai';
import { z } from 'zod';
import { pageTextInPage } from '../injected';
import {
  addWorkNote,
  getCi,
  getJournal,
  getRecord,
  getRelated,
  kbSearch,
  listAttachments,
  queryRecords,
  readAttachment,
} from '../servicenow/client';
import { rawUtc } from '../servicenow/indicators';
import { parseUtcInput } from '../servicenow/related';
import { extractIndicators, suggestedWindow } from '../servicenow/indicators';
import { numberToTable, parseSnowRecordUrl } from '../servicenow/url';
import type { Settings } from '../settings';
import {
  getFieldSummary,
  getResults,
  listKnowledge,
  runSearch,
  showJobInTab,
  splunkTargetFromTab,
  validateSpl,
} from '../splunk/client';
import { analyzeTimeline, hasTransformingCommand, isSafeFieldName } from '../splunk/insights';
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
        'With no number, it reads the record currently open in the ServiceNow tab. Returns the fields as display values (date fields also include their raw UTC value), the journal (comments/work notes) when accessible, ' +
        '`indicators` extracted from the text (hosts, IPs, URLs, IDs, error codes, exceptions, timestamps as written), and `suggested_window`: a default Splunk time range around opened_at, as epoch seconds.',
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
        const own = tab.url ? [new URL(tab.url).hostname] : [];
        return {
          tabId: tab.id,
          table: res.table,
          sys_id: res.sysId,
          fields: res.record,
          journal,
          indicators: extractIndicators(res.record, Array.isArray(journal) ? journal : null, own),
          suggested_window: suggestedWindow(res.record),
        };
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

    servicenow_get_ci: tool({
      description:
        "Look up a configuration item (CI) in the CMDB by name or sys_id: its class, hostnames, FQDN, IP, OS, environment, support group, and its CMDB relationships (what it runs on, depends on or is used by). " +
        "Use it to turn the ticket's cmdb_ci into the hosts to search in Splunk, and to find upstream or downstream CIs worth checking.",
      inputSchema: z.object({
        ci: z.string().min(1).describe("CI name as shown on the ticket's cmdb_ci field, or its sys_id"),
        tabId: tabIdSchema,
      }),
      execute: async ({ ci, tabId }) => {
        const tab = await resolveTab(s, 'servicenow', tabId);
        return getCi(tab.id!, ci);
      },
    }),

    servicenow_related: tool({
      description:
        'Find what else happened on the same CI around the incident: change requests whose window overlaps the lookback period (with minutes before the incident, and whether one was in progress at the time), other incidents on the CI, and open problems. ' +
        'A change shortly before the problem started is often the cause, so call this early. Pass the ticket number to use its CI and opened time, or give ci and at yourself.',
      inputSchema: z.object({
        number: z.string().optional().describe('Ticket number; its cmdb_ci and opened_at are used'),
        ci: z.string().optional().describe('CI name or sys_id, if not taken from the ticket'),
        at: z
          .string()
          .optional()
          .describe('Incident time in UTC, "YYYY-MM-DD HH:MM:SS" (as in the [UTC ...] values) or ISO. Default: the ticket\'s opened_at'),
        lookbackDays: z.number().min(0.1).max(30).optional().describe('Default 3'),
        tabId: tabIdSchema,
      }),
      execute: async ({ number, ci, at, lookbackDays = 3, tabId }) => {
        const tab = await resolveTab(s, 'servicenow', tabId);
        let ciName = ci;
        let atMs = at ? parseUtcInput(at) : undefined;
        if (number && (!ciName || atMs == null)) {
          const rec = (await getRecord(tab.id!, { table: numberToTable(number), number })).record;
          ciName ??= rec.cmdb_ci?.replace(/\s*\[UTC [^\]]+\]/, '').trim() || undefined;
          atMs ??= rawUtc(rec.opened_at) ?? rawUtc(rec.sys_created_on) ?? undefined;
        }
        if (!ciName) throw new Error('No CI to look at: the ticket has no cmdb_ci. Pass ci yourself (from the description, or servicenow_get_ci).');
        if (atMs == null) throw new Error('No incident time: pass at, or a ticket number.');
        return getRelated(tab.id!, { ci: ciName, atMs, lookbackDays, excludeNumber: number?.trim().toUpperCase() });
      },
    }),

    servicenow_kb_search: tool({
      description:
        'Search published knowledge articles for known fixes and runbooks: pass an error message, exception or a few symptom words. Returns titles, links and an excerpt of each article.',
      inputSchema: z.object({
        text: z.string().min(2).describe('E.g. "ORA-12541 TNS no listener" or "payments 503 after deploy"'),
        limit: z.number().int().min(1).max(10).optional().describe('Default 5'),
        tabId: tabIdSchema,
      }),
      execute: async ({ text, limit = 5, tabId }) => {
        const tab = await resolveTab(s, 'servicenow', tabId);
        return kbSearch(tab.id!, new URL(tab.url!).origin, text, limit);
      },
    }),

    servicenow_attachments: tool({
      description:
        "List a record's attachments (users often attach log extracts, HAR files or screenshots). Use servicenow_read_attachment to read a text one.",
      inputSchema: z.object({
        table: z.string().describe('Table from read_servicenow_ticket, e.g. incident'),
        sys_id: z.string().describe('sys_id from read_servicenow_ticket'),
        tabId: tabIdSchema,
      }),
      execute: async ({ table, sys_id, tabId }) => {
        const tab = await resolveTab(s, 'servicenow', tabId);
        const files = await listAttachments(tab.id!, table, sys_id);
        return { count: files.length, files };
      },
    }),

    servicenow_read_attachment: tool({
      description:
        'Read a text attachment (log, txt, JSON, CSV, XML, ...). Without contains, returns the start and the end of the file (logs usually end with the failure). ' +
        'With contains, returns only lines that include any of the terms (case-insensitive), with line numbers and context lines, searching the whole file.',
      inputSchema: z.object({
        sys_id: z.string().describe('Attachment sys_id from servicenow_attachments'),
        contains: z.array(z.string().min(1)).max(10).optional().describe('E.g. ["ERROR", "Exception", "trace_id=abc"]'),
        context: z.number().int().min(0).max(5).optional().describe('Lines of context around each match. Default 1'),
        maxChars: z.number().int().min(1000).max(60_000).optional().describe('Default 20000'),
        tabId: tabIdSchema,
      }),
      execute: async ({ sys_id, contains, context, maxChars = 20_000, tabId }) => {
        const tab = await resolveTab(s, 'servicenow', tabId);
        return readAttachment(tab.id!, sys_id, { maxChars, contains, context });
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
        const shownInTab = s.splunkSyncTab ? await showJobInTab(target, res.viewUrl).catch(() => undefined) : undefined;
        return { tabId: tab.id, ...(shownInTab != null ? { shownInTab } : {}), ...res };
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

    splunk_field_summary: tool({
      description:
        'Top values per field across ALL events a finished splunk_search job scanned, without pulling the events: for each field, the share of events that have it, the number of distinct values and the top values with counts. ' +
        'Use it right after a broad raw-event search to see which hosts, sources, error codes or users dominate, instead of paging through events. Works for jobs from splunk_search (not tstats or metadata).',
      inputSchema: z.object({
        sid: z.string().min(1).describe('The sid returned by splunk_search'),
        fields: z.array(z.string()).optional().describe('Only these fields. Default: all, ordered by coverage'),
        topN: z.number().int().min(1).max(20).optional().describe('Top values per field. Default 5'),
        tabId: tabIdSchema,
      }),
      execute: async ({ sid, fields, topN, tabId }) => {
        const tab = await resolveTab(s, 'splunk', tabId);
        return getFieldSummary(splunkTargetFromTab(tab, s.splunkDefaultApp), { sid, fields, topN });
      },
    }),

    splunk_timeline: tool({
      description:
        'Event counts over time for a base search, analysed in code: total, peak bucket, first and last event, the baseline per bucket and the spike onset (first bucket at 3x the median and at least 5 events). ' +
        'Use it to find when a problem started or stopped. Give the base search only (index, filters, terms; no stats/timechart). Optionally split by one field, e.g. host or status.',
      inputSchema: z.object({
        spl: z.string().min(1).describe('Base search, e.g. index=app sourcetype=nginx status>=500'),
        earliest: z.string().optional().describe('Default -24h'),
        latest: z.string().optional().describe('Default now'),
        span: z
          .string()
          .regex(/^\d+(s|m|h|d)$/)
          .optional()
          .describe('Bucket size, e.g. 1m, 5m, 1h. Default: about 60 buckets over the range'),
        splitBy: z.string().optional().describe('One field to split counts by (top 5 values plus OTHER)'),
        tabId: tabIdSchema,
      }),
      execute: async ({ spl, earliest, latest, span, splitBy, tabId }, { abortSignal }) => {
        if (hasTransformingCommand(spl)) {
          throw new Error('Pass only the base search (filters and terms). splunk_timeline adds the timechart itself.');
        }
        if (splitBy && !isSafeFieldName(splitBy)) throw new Error(`"${splitBy}" is not a valid field name.`);
        const tab = await resolveTab(s, 'splunk', tabId);
        const target = splunkTargetFromTab(tab, s.splunkDefaultApp);
        const chart = `| timechart ${span ? `span=${span}` : 'bins=60'} count${splitBy ? ` by ${splitBy} limit=5 useother=true` : ''}`;
        const res = await runSearch(target, {
          spl: `${spl.trim()} ${chart}`,
          earliest,
          latest,
          maxResults: 500,
          timeoutSec: s.splunkSearchTimeoutSec,
          signal: abortSignal,
        });
        return {
          sid: res.sid,
          search: res.search,
          earliest: res.earliest,
          latest: res.latest,
          partial: res.partial,
          viewUrl: res.viewUrl,
          messages: res.messages,
          ...analyzeTimeline(res.results as Array<Record<string, unknown>>),
        };
      },
    }),

    splunk_validate_spl: tool({
      description:
        'Check SPL syntax without running it and see the parsed pipeline with macros expanded. Use it before a long or complex search, after a syntax error, or to see what a macro really does. It never runs the search.',
      inputSchema: z.object({ spl: z.string().min(1), tabId: tabIdSchema }),
      execute: async ({ spl, tabId }) => {
        const tab = await resolveTab(s, 'splunk', tabId);
        return validateSpl(splunkTargetFromTab(tab, s.splunkDefaultApp), spl);
      },
    }),

    splunk_knowledge: tool({
      description:
        "List the team's Splunk knowledge objects the user can see, across apps: saved searches (often the team's ready-made search for an app or alert), macros, eventtypes or lookups, with their definitions. Filter by a word such as an app or service name.",
      inputSchema: z.object({
        kind: z.enum(['saved_searches', 'macros', 'eventtypes', 'lookups']),
        filter: z.string().optional().describe('Only objects matching this text, e.g. payments'),
        count: z.number().int().min(1).max(100).optional().describe('Default 25'),
        tabId: tabIdSchema,
      }),
      execute: async ({ kind, filter, count, tabId }) => {
        const tab = await resolveTab(s, 'splunk', tabId);
        return listKnowledge(splunkTargetFromTab(tab, s.splunkDefaultApp), { kind, filter, count });
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
  const splApproval = (spl: string) => {
    const reasons = splApprovalReasons(spl, s.splunkTrustedMacros ?? []);
    return reasons.length
      ? ({ type: 'user-approval', reason: reasons.join('. ') } as const)
      : ('not-applicable' as const);
  };
  return {
    servicenow_add_note: (input: { field?: 'work_notes' | 'comments'; table?: string }) =>
      ({
        type: 'user-approval',
        reason:
          input.field === 'comments'
            ? `Adds a CUSTOMER-VISIBLE comment to ${input.table ?? 'the record'}`
            : `Adds an internal work note to ${input.table ?? 'the record'}`,
      }) as const,
    splunk_search: (input: { spl: string }) => splApproval(input.spl),
    // The timeline runs the base search too, so the same check applies.
    splunk_timeline: (input: { spl: string }) => splApproval(input.spl),
  } as const;
}

/** Approval rules under the default settings (no trusted macros). */
export const toolApproval = buildToolApproval(DEFAULT_SETTINGS);
