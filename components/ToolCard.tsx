import type { ChatAddToolApproveResponseFunction } from 'ai';

export interface ToolPartLike {
  type: string;
  toolName?: string;
  toolCallId: string;
  state:
    | 'input-streaming'
    | 'input-available'
    | 'approval-requested'
    | 'approval-responded'
    | 'output-available'
    | 'output-error'
    | 'output-denied';
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; requestReason?: string; reason?: string };
}

const LABELS: Record<string, string> = {
  list_tabs: 'List tabs',
  read_page_text: 'Read page',
  read_servicenow_ticket: 'Read ServiceNow ticket',
  servicenow_query: 'Query ServiceNow',
  servicenow_add_note: 'Add ServiceNow note',
  splunk_search: 'Splunk search',
  splunk_metadata: 'Splunk metadata',
  splunk_get_results: 'Splunk results',
  splunk_field_summary: 'Splunk field summary',
  splunk_timeline: 'Splunk timeline',
  splunk_validate_spl: 'Check SPL',
  splunk_knowledge: 'Splunk knowledge',
  servicenow_get_ci: 'Look up CI',
  servicenow_related: 'Related changes & incidents',
  servicenow_kb_search: 'Search knowledge base',
  servicenow_attachments: 'List attachments',
  servicenow_read_attachment: 'Read attachment',
};

function summary(name: string, input: any): string {
  if (!input) return '';
  if (name === 'splunk_search') return input.spl ?? '';
  if (name === 'read_servicenow_ticket') return input.number ?? 'current tab';
  if (name === 'servicenow_query') return `${input.table}: ${input.query}`;
  if (name === 'servicenow_add_note') return `${input.field ?? 'work_notes'} on ${input.table}`;
  if (name === 'splunk_metadata') return `${input.kind}${input.index ? ` (${input.index})` : ''}`;
  if (name === 'read_page_text') return `tab ${input.tabId}`;
  if (name === 'splunk_get_results') return `${input.sid} @${input.offset ?? 0}`;
  if (name === 'splunk_field_summary') return input.sid ?? '';
  if (name === 'splunk_timeline') return `${input.spl ?? ''}${input.splitBy ? ` by ${input.splitBy}` : ''}`;
  if (name === 'splunk_validate_spl') return input.spl ?? '';
  if (name === 'splunk_knowledge') return `${input.kind}${input.filter ? `: ${input.filter}` : ''}`;
  if (name === 'servicenow_get_ci') return input.ci ?? '';
  if (name === 'servicenow_related') return input.number ?? input.ci ?? '';
  if (name === 'servicenow_kb_search') return input.text ?? '';
  if (name === 'servicenow_attachments') return `${input.table ?? ''} ${input.sys_id ?? ''}`.trim();
  if (name === 'servicenow_read_attachment') return input.contains?.length ? `grep ${input.contains.join(', ')}` : (input.sys_id ?? '');
  return '';
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

export default function ToolCard({
  part,
  onApproval,
}: {
  part: ToolPartLike;
  onApproval: ChatAddToolApproveResponseFunction;
}) {
  const name = part.toolName ?? part.type.replace(/^tool-/, '');
  const input = part.input as any;
  const out = part.output as any;

  const badge = {
    'input-streaming': ['preparing', 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'],
    'input-available': ['running…', 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300'],
    'approval-requested': ['needs approval', 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300'],
    'approval-responded': [part.approval?.approved ? 'approved' : 'denied', 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'],
    'output-available': ['done', 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'],
    'output-error': ['error', 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'],
    'output-denied': ['denied', 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'],
  }[part.state] ?? ['', ''];

  const meta =
    name === 'splunk_search' && out
      ? `${out.returned}/${out.resultCount} rows${out.partial ? ' (partial)' : ''} · sid ${out.sid}`
      : name === 'read_servicenow_ticket' && out
        ? `${out.fields?.number ?? ''} ${out.fields?.short_description ?? ''}`
        : '';

  return (
    <div className="rounded border border-zinc-200 text-xs dark:border-zinc-800">
      <details open={part.state === 'approval-requested'}>
        <summary className="flex cursor-pointer select-none items-center gap-2 px-2 py-1.5">
          <span className="font-medium">{LABELS[name] ?? name}</span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${badge[1]}`}>{badge[0]}</span>
          <span className="truncate font-mono text-zinc-500">{summary(name, input)}</span>
        </summary>
        <div className="space-y-2 border-t border-zinc-200 p-2 dark:border-zinc-800">
          {meta && <div className="text-zinc-600 dark:text-zinc-400">{meta}</div>}
          {name === 'splunk_search' && out?.viewUrl && (
            <a className="text-blue-600 underline dark:text-blue-400" href={out.viewUrl} target="_blank" rel="noreferrer">
              Open job in Splunk
            </a>
          )}
          <div>
            <div className="mb-0.5 text-zinc-500">Input</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-50 p-1.5 font-mono dark:bg-zinc-900">
              {json(input)}
            </pre>
          </div>
          {part.state === 'output-available' && (
            <div>
              <div className="mb-0.5 text-zinc-500">Output</div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-50 p-1.5 font-mono dark:bg-zinc-900">
                {json(out)}
              </pre>
            </div>
          )}
          {part.state === 'output-error' && (
            <div className="whitespace-pre-wrap break-words text-red-700 dark:text-red-300">{part.errorText}</div>
          )}
        </div>
      </details>

      {part.state === 'approval-requested' && part.approval && (
        <div className="flex items-center gap-2 border-t border-amber-300 bg-amber-50 px-2 py-1.5 dark:border-amber-800 dark:bg-amber-950/40">
          <span className="flex-1 text-amber-900 dark:text-amber-200">
            {part.approval.requestReason ?? 'This action needs your approval.'}
          </span>
          <button
            className="btn btn-primary"
            onClick={() => onApproval({ id: part.approval!.id, approved: true })}
          >
            Approve
          </button>
          <button
            className="btn"
            onClick={() => onApproval({ id: part.approval!.id, approved: false, reason: 'User denied' })}
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
