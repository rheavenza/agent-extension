export interface SnowRecordRef {
  table: string;
  sysId: string;
}

const SYS_ID = /^[0-9a-f]{32}$/i;

/** Ticket number prefix → table. Unknown prefixes fall back to `task`. */
const PREFIX_TABLE: Record<string, string> = {
  INC: 'incident',
  RITM: 'sc_req_item',
  REQ: 'sc_request',
  SCTASK: 'sc_task',
  CHG: 'change_request',
  CTASK: 'change_task',
  PRB: 'problem',
  PTASK: 'problem_task',
  TASK: 'task',
};

export function numberToTable(number: string): string {
  const m = /^([A-Z]+)\d+$/i.exec(number.trim());
  if (!m) return 'task';
  return PREFIX_TABLE[m[1].toUpperCase()] ?? 'task';
}

export function isTicketNumber(s: string): boolean {
  return /^[A-Z]{2,8}\d{5,}$/i.test(s.trim());
}

/**
 * Extract {table, sysId} from any ServiceNow record URL:
 *  - Classic:      /incident.do?sys_id=<id>
 *  - Classic nav:  /nav_to.do?uri=incident.do%3Fsys_id%3D<id>
 *  - Polaris:      /now/nav/ui/classic/params/target/incident.do%3Fsys_id%3D<id>
 *  - Workspaces:   /now/sow/record/incident/<id>, /now/cwf/agent/record/incident/<id>/...
 */
export function parseSnowRecordUrl(rawUrl: string, depth = 0): SnowRecordRef | null {
  if (depth > 3) return null;
  let url: URL;
  try {
    url = new URL(rawUrl, 'https://placeholder.invalid');
  } catch {
    return null;
  }
  const path = url.pathname;

  // Workspace: .../record/<table>/<sys_id>
  const ws = /\/now\/.*?\/record\/([a-z0-9_]+)\/([0-9a-f]{32})(?:\/|$)/i.exec(path);
  if (ws) return { table: ws[1], sysId: ws[2].toLowerCase() };

  // Polaris wrapper around a classic form.
  const target = /\/now\/nav\/ui\/classic\/params\/target\/(.+)$/.exec(path);
  if (target) return parseSnowRecordUrl('/' + decodeURIComponent(target[1]), depth + 1);

  // nav_to.do?uri=...
  if (/\/nav_to\.do$/.test(path)) {
    const uri = url.searchParams.get('uri');
    if (uri) return parseSnowRecordUrl(uri.startsWith('/') ? uri : '/' + uri, depth + 1);
  }

  // Classic form: /<table>.do?sys_id=...
  const form = /\/([a-z0-9_]+)\.do$/i.exec(path);
  if (form && !form[1].endsWith('_list')) {
    const sysId = url.searchParams.get('sys_id');
    if (sysId && SYS_ID.test(sysId)) return { table: form[1], sysId: sysId.toLowerCase() };
  }
  return null;
}
