import { snowFetchInPage } from '../injected';
import { runInTab } from '../tabs';
import { compactJournal, compactRecord } from './record';

async function call(tabId: number, path: string, method = 'GET', body?: unknown) {
  const res = await runInTab(tabId, snowFetchInPage, [path, method, body ? JSON.stringify(body) : null], 'MAIN');
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
  else if (opts.number) query = `number=${opts.number.trim().toUpperCase()}`;
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

export async function getJournal(tabId: number, sysId: string, limit = 30) {
  try {
    const j = await call(
      tabId,
      `/api/now/table/sys_journal_field?sysparm_query=${enc(`element_id=${sysId}^ORDERBYDESCsys_created_on`)}&sysparm_fields=element,value,sys_created_on,sys_created_by&sysparm_limit=${limit}`,
    );
    return compactJournal(j.result ?? []);
  } catch {
    return null; // Often ACL-restricted. The record's comments/work_notes display values still hold the history.
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
