import { snowFetchInPage } from '../injected';
import { runInTab } from '../tabs';
import { compactJournal, compactRecord, type JournalEntry } from './record';
import { rawUtc } from './indicators';
import {
  changesNear,
  ciQuery,
  describeRelationship,
  excerptText,
  htmlToText,
  isSysId,
  isTextAttachment,
  kbLikeQuery,
  kbQueryText,
  ticketsNear,
} from './related';
import { isTicketNumber } from './url';

async function call(tabId: number, path: string, method = 'GET', body?: unknown, accept?: string) {
  const res = await runInTab(
    tabId,
    snowFetchInPage,
    [path, method, body ? JSON.stringify(body) : null, accept ?? null],
    'MAIN',
  );
  if (accept && res.ok) return { __text: res.text };
  let json: any = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    /* non-JSON (login page, HTML error) */
  }
  if (!res.ok) {
    const detail = json?.error?.message ?? json?.error?.detail ?? res.text.slice(0, 300);
    const hint =
      res.status === 401
        ? res.hasToken
          ? ' Your ServiceNow session may have expired. Reload the tab.'
          : ' No g_ck session token was found on the page. Reload the ServiceNow tab.'
        : res.status === 403
          ? ' ACLs block this through the REST API. Try read_page_text on the tab instead.'
          : '';
    throw new Error(`ServiceNow ${method} ${path} → HTTP ${res.status}: ${detail}.${hint}`);
  }
  if (json == null) throw new Error(`ServiceNow returned non-JSON for ${path}. The session may have expired.`);
  return json;
}

const enc = encodeURIComponent;

export async function getRecord(
  tabId: number,
  opts: { table?: string; sysId?: string; number?: string },
): Promise<{ table: string; sysId: string; record: Record<string, string> }> {
  let table = opts.table ?? 'task';
  let query: string;
  if (opts.sysId) query = `sys_id=${opts.sysId}`;
  else if (opts.number) {
    // The number goes into an encoded query, where ^ starts a new condition. Only accept real numbers.
    if (!isTicketNumber(opts.number)) {
      throw new Error(`"${opts.number}" doesn't look like a ticket number (letters followed by digits, e.g. INC0012345).`);
    }
    query = `number=${opts.number.trim().toUpperCase()}`;
  }
  else throw new Error('getRecord needs a sysId or a number');

  const fetchOne = async (t: string) => {
    const j = await call(
      tabId,
      `/api/now/table/${enc(t)}?sysparm_query=${enc(query)}&sysparm_display_value=all&sysparm_exclude_reference_link=true&sysparm_limit=1`,
    );
    return (j.result?.[0] ?? null) as Record<string, any> | null;
  };

  let rec = await fetchOne(table);
  if (!rec && table !== 'task') {
    rec = await fetchOne('task');
    table = 'task';
  }
  if (!rec) throw new Error(`No ${table} record matches ${query}`);

  // A record found through `task` only has task fields. Re-read it from its real table for the full form.
  const cls = rec.sys_class_name?.value;
  if (table === 'task' && typeof cls === 'string' && cls && cls !== 'task') {
    query = `sys_id=${rec.sys_id.value}`;
    rec = (await fetchOne(cls)) ?? rec;
    table = cls;
  }
  return { table, sysId: String(rec.sys_id?.value ?? rec.sys_id), record: compactRecord(rec) };
}

export type JournalResult = JournalEntry[] | { unavailable: string };

/**
 * The journal (comments and work notes) is often ACL-restricted. Say so instead of returning null,
 * so the model can tell "no entries" from "couldn't read them".
 */
export async function getJournal(tabId: number, sysId: string, limit = 30): Promise<JournalResult> {
  try {
    const j = await call(
      tabId,
      `/api/now/table/sys_journal_field?sysparm_query=${enc(`element_id=${sysId}^ORDERBYDESCsys_created_on`)}&sysparm_fields=element,value,sys_created_on,sys_created_by&sysparm_limit=${limit}`,
    );
    return compactJournal(j.result ?? []);
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('.')[0] : String(e);
    return {
      unavailable: `Couldn't read the journal (${msg}). The record's comments and work_notes fields still hold the history; if those are empty too, use read_page_text on the ticket tab.`,
    };
  }
}

export async function queryRecords(tabId: number, table: string, query: string, limit: number, fields: string[]) {
  const j = await call(
    tabId,
    `/api/now/table/${enc(table)}?sysparm_query=${enc(query)}&sysparm_display_value=true&sysparm_exclude_reference_link=true&sysparm_limit=${limit}&sysparm_fields=${enc(fields.join(','))}`,
  );
  return (j.result ?? []) as Array<Record<string, string>>;
}

export async function addWorkNote(tabId: number, table: string, sysId: string, text: string, field: 'work_notes' | 'comments') {
  const j = await call(tabId, `/api/now/table/${enc(table)}/${enc(sysId)}?sysparm_fields=number,sys_id`, 'PATCH', {
    [field]: text,
  });
  return j.result as Record<string, string>;
}

/** Table API query returning compacted records (display values plus [UTC raw] on dates). */
async function queryCompact(tabId: number, table: string, query: string, limit: number, fields: string[]) {
  const j = await call(
    tabId,
    `/api/now/table/${enc(table)}?sysparm_query=${enc(query)}&sysparm_display_value=all&sysparm_exclude_reference_link=true&sysparm_limit=${limit}&sysparm_fields=${enc(fields.join(','))}`,
  );
  return ((j.result ?? []) as Array<Record<string, unknown>>).map((r) => compactRecord(r, 1000));
}

const CI_FIELDS = [
  'sys_id', 'name', 'sys_class_name', 'short_description', 'fqdn', 'host_name', 'dns_domain', 'ip_address',
  'os', 'os_version', 'environment', 'used_for', 'operational_status', 'install_status', 'support_group',
  'assignment_group', 'managed_by', 'owned_by', 'location', 'category', 'subcategory', 'version', 'port',
  'url', 'model_id',
];

/**
 * A configuration item with its hostnames and IPs, read from its own class table (cmdb_ci only has
 * the base fields), plus its CMDB relationships. Accepts a CI name or sys_id.
 */
export async function getCi(tabId: number, ci: string) {
  const v = ci.trim();
  if (!v || /[\^\n\r]/.test(v)) throw new Error(`"${ci}" is not a usable CI name.`);
  const q = isSysId(v) ? `sys_id=${v}` : `name=${v}`;
  let rows = await queryCompact(tabId, 'cmdb_ci', q, 2, CI_FIELDS);
  if (!rows.length && !isSysId(v)) {
    const candidates = await queryCompact(tabId, 'cmdb_ci', `nameSTARTSWITH${v}^ORDERBYname`, 10, ['sys_id', 'name', 'sys_class_name']);
    if (!candidates.length) throw new Error(`No CI named "${v}" (exact or prefix). Check the name on the ticket's cmdb_ci field.`);
    return { found: false, candidates };
  }
  if (!rows.length) throw new Error(`No CI with sys_id ${v}.`);
  let rec = rows[0];
  const cls = rec.sys_class_name ?? '';
  const sysId = rec.sys_id;
  // sys_class_name's display value is a label ("Linux Server"); the table name comes from a raw read.
  const raw = await call(
    tabId,
    `/api/now/table/cmdb_ci/${enc(sysId)}?sysparm_fields=sys_class_name&sysparm_display_value=false`,
  ).catch(() => null);
  const table = raw?.result?.sys_class_name;
  if (typeof table === 'string' && /^\w+$/.test(table) && table !== 'cmdb_ci') {
    const full = await queryCompact(tabId, table, `sys_id=${sysId}`, 1, CI_FIELDS).catch(() => []);
    if (full[0]) rec = full[0];
  }
  const relJson = await call(
    tabId,
    `/api/now/table/cmdb_rel_ci?sysparm_query=${enc(`parent=${sysId}^ORchild=${sysId}`)}&sysparm_display_value=all&sysparm_exclude_reference_link=true&sysparm_fields=parent,child,type&sysparm_limit=40`,
  ).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  const relationships = Array.isArray((relJson as any)?.result)
    ? ((relJson as any).result as any[]).map((r) => describeRelationship(r, sysId)).filter(Boolean)
    : { unavailable: String((relJson as any)?.error ?? 'no result') };
  return { found: true, class: table ?? cls, ci: rec, relationships };
}

const CHANGE_FIELDS = ['number', 'short_description', 'state', 'type', 'start_date', 'end_date', 'work_start', 'work_end', 'assignment_group', 'close_code'];
const INCIDENT_FIELDS = ['number', 'short_description', 'state', 'priority', 'opened_at', 'resolved_at', 'close_code', 'problem_id'];
const PROBLEM_FIELDS = ['number', 'short_description', 'state', 'opened_at', 'known_error', 'cause_notes'];

/**
 * Changes, incidents and problems on the same CI around the incident time. Records are fetched
 * newest first and filtered by their raw UTC times in code, so no timezone-dependent date
 * conditions are needed in the encoded query.
 */
export async function getRelated(tabId: number, o: { ci: string; atMs: number; lookbackDays: number; excludeNumber?: string }) {
  const ciQ = ciQuery(o.ci);
  const settle = async <T>(p: Promise<T>) => p.catch((e: unknown) => ({ unavailable: e instanceof Error ? e.message : String(e) }));
  const [changes, incidents, problems] = await Promise.all([
    settle(queryCompact(tabId, 'change_request', `${ciQ}^ORDERBYDESCstart_date`, 50, CHANGE_FIELDS)),
    settle(queryCompact(tabId, 'incident', `${ciQ}^ORDERBYDESCopened_at`, 50, INCIDENT_FIELDS)),
    settle(queryCompact(tabId, 'problem', `${ciQ}^ORDERBYDESCopened_at`, 20, PROBLEM_FIELDS)),
  ]);
  const at = new Date(o.atMs).toISOString().replace('.000Z', 'Z');
  return {
    ci: o.ci,
    incident_time_utc: at,
    lookback_days: o.lookbackDays,
    changes: Array.isArray(changes) ? changesNear(changes, o.atMs, o.lookbackDays) : changes,
    incidents: Array.isArray(incidents) ? ticketsNear(incidents, o.atMs, o.lookbackDays, o.excludeNumber) : incidents,
    // Problems matter while open, however old; closed ones only if recent.
    problems: Array.isArray(problems)
      ? problems
          .filter((p) => !/closed|resolved|cancel/i.test(p.state ?? '') || (rawUtc(p.opened_at) ?? 0) >= o.atMs - o.lookbackDays * 86_400_000)
          .map((p) => ({
            number: p.number,
            short_description: p.short_description ?? '',
            state: (p.state ?? '').replace(/\s*\[UTC [^\]]+\]/, ''),
            known_error: p.known_error === 'true' || undefined,
            cause_notes: p.cause_notes || undefined,
          }))
      : problems,
  };
}

/** Knowledge articles matching the text: full-text search, falling back to short_description LIKE. */
export async function kbSearch(tabId: number, origin: string, text: string, limit: number) {
  const fields = ['number', 'short_description', 'text', 'sys_updated_on', 'kb_knowledge_base', 'sys_view_count'];
  const published = 'workflow_state=published';
  let method = 'full-text';
  let rows: Array<Record<string, string>> = [];
  try {
    rows = await queryCompact(tabId, 'kb_knowledge', `123TEXTQUERY321=${kbQueryText(text)}^${published}`, limit, fields);
  } catch {
    rows = [];
  }
  if (!rows.length) {
    method = 'short_description contains';
    const like = kbLikeQuery(text);
    rows = like ? await queryCompact(tabId, 'kb_knowledge', `${like}^${published}`, limit, fields) : [];
  }
  return {
    method,
    articles: rows.map((r) => {
      const body = htmlToText(r.text ?? '');
      return {
        number: r.number,
        title: r.short_description ?? '',
        knowledge_base: r.kb_knowledge_base || undefined,
        updated: r.sys_updated_on,
        link: `${origin}/kb_view.do?sysparm_article=${enc(r.number ?? '')}`,
        excerpt: body.length > 1500 ? body.slice(0, 1500) + ' …[truncated]' : body,
      };
    }),
  };
}

export async function listAttachments(tabId: number, table: string, sysId: string) {
  if (!/^\w+$/.test(table) || !isSysId(sysId)) throw new Error('Pass the table and the 32-character sys_id from read_servicenow_ticket.');
  const j = await call(
    tabId,
    `/api/now/attachment?sysparm_query=${enc(`table_name=${table}^table_sys_id=${sysId}^ORDERBYDESCsys_created_on`)}&sysparm_limit=30`,
  );
  return ((j.result ?? []) as any[]).map((a) => ({
    sys_id: a.sys_id,
    file_name: a.file_name,
    content_type: a.content_type,
    size_bytes: Number(a.size_bytes ?? 0),
    created_on: a.sys_created_on,
    created_by: a.sys_created_by,
    readable_as_text: isTextAttachment(String(a.content_type ?? ''), String(a.file_name ?? '')),
  }));
}

/** Read a text attachment (logs, JSON, CSV, ...): its start and end, or only the lines matching some terms. */
export async function readAttachment(
  tabId: number,
  sysId: string,
  o: { maxChars: number; contains?: string[]; context?: number },
) {
  if (!isSysId(sysId)) throw new Error('Pass the attachment sys_id from servicenow_attachments.');
  const meta = (await call(tabId, `/api/now/attachment/${enc(sysId)}`)).result ?? {};
  const name = String(meta.file_name ?? '');
  const type = String(meta.content_type ?? '');
  if (!isTextAttachment(type, name)) {
    return {
      file_name: name,
      content_type: type,
      readable: false,
      reason: 'Not a text file. Images, PDFs and archives cannot be read here; ask the user to look at it.',
    };
  }
  const res = await call(tabId, `/api/now/attachment/${enc(sysId)}/file`, 'GET', undefined, '*/*');
  const text = String((res as any).__text ?? '');
  return {
    file_name: name,
    content_type: type,
    size_bytes: Number(meta.size_bytes ?? text.length),
    readable: true,
    ...excerptText(text, o),
  };
}
