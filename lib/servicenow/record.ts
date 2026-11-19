type DisplayAll = { display_value: unknown; value: unknown };

const KEEP_SYS_FIELDS = new Set([
  'sys_id',
  'sys_class_name',
  'sys_created_on',
  'sys_created_by',
  'sys_updated_on',
  'sys_updated_by',
]);
const DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function isDisplayAll(v: unknown): v is DisplayAll {
  return !!v && typeof v === 'object' && 'display_value' in v && 'value' in v;
}

function str(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/**
 * Shrink a Table API record (sysparm_display_value=all) to something an LLM can read:
 * display values only, empty and noisy sys_* fields dropped, long text truncated.
 * Date/time fields also carry their raw UTC value, because display values are in the user's timezone.
 */
export function compactRecord(
  record: Record<string, unknown>,
  maxFieldChars = 4000,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (key.startsWith('sys_') && !KEEP_SYS_FIELDS.has(key)) continue;
    let display: string;
    let value: string;
    if (isDisplayAll(raw)) {
      display = str(raw.display_value);
      value = str(raw.value);
    } else {
      display = value = str(raw);
    }
    if (!display && !value) continue;
    if (display === 'false' && value === 'false') continue;
    let text = display || value;
    if (text.length > maxFieldChars) text = text.slice(0, maxFieldChars) + ` …[truncated ${text.length - maxFieldChars} chars]`;
    if (value && value !== display && DATETIME.test(value)) text += ` [UTC ${value}]`;
    out[key] = text;
  }
  return out;
}

export interface JournalEntry {
  element: string;
  created_on: string;
  created_by: string;
  value: string;
}

export function compactJournal(rows: Array<Record<string, unknown>>, maxChars = 2000): JournalEntry[] {
  return rows.map((r) => {
    const value = str(r.value);
    return {
      element: str(r.element),
      created_on: str(r.sys_created_on),
      created_by: str(r.sys_created_by),
      value: value.length > maxChars ? value.slice(0, maxChars) + ' …[truncated]' : value,
    };
  });
}
