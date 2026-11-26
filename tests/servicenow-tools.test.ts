import { afterEach, describe, expect, it } from 'vitest';
import { getCi, getRelated, kbSearch, readAttachment } from '../lib/servicenow/client';
import { wrapUntrusted } from '../lib/agent/context';
import { buildTools } from '../lib/tools';
import { DEFAULT_SETTINGS } from '../lib/settings';

type Route = [RegExp, (path: string, accept: string | null) => { status?: number; body?: unknown; text?: string }];

function fakeSnow(routes: Route[]) {
  const calls: Array<{ path: string; accept: string | null }> = [];
  (globalThis as any).chrome = {
    tabs: { get: async () => ({ id: 1, status: 'complete' }) },
    scripting: {
      executeScript: async ({ args: [path, , , accept] }: { args: [string, string, string | null, string | null] }) => {
        calls.push({ path: decodeURIComponent(path), accept });
        const hit = routes.find(([re]) => re.test(decodeURIComponent(path)));
        if (!hit) throw new Error(`unexpected ${decodeURIComponent(path)}`);
        const r = hit[1](path, accept);
        const status = r.status ?? 200;
        return [{ result: { ok: status < 400, status, text: r.text ?? JSON.stringify(r.body), hasToken: true, url: path } }];
      },
    },
  };
  return calls;
}

const dv = (display: string, value = display) => ({ display_value: display, value });

afterEach(() => {
  delete (globalThis as any).chrome;
});

describe('getCi', () => {
  it('reads the CI from its class table and describes its relationships', async () => {
    const id = 'a'.repeat(32);
    const calls = fakeSnow([
      [/table\/cmdb_ci\?.*sysparm_query=name=payapi01/, () => ({ body: { result: [{ sys_id: dv(id), name: dv('payapi01'), sys_class_name: dv('Linux Server', 'cmdb_ci_linux_server') }] } })],
      [/table\/cmdb_ci\/a+\?/, () => ({ body: { result: { sys_class_name: 'cmdb_ci_linux_server' } } })],
      [/table\/cmdb_ci_linux_server\?/, () => ({ body: { result: [{ sys_id: dv(id), name: dv('payapi01'), fqdn: dv('payapi01.prod.corp'), ip_address: dv('10.0.0.5') }] } })],
      [/table\/cmdb_rel_ci\?/, () => ({ body: { result: [{ parent: dv('payments', 'P'), child: dv('payapi01', id), type: dv('Runs on::Runs') }] } })],
    ]);
    const r: any = await getCi(1, 'payapi01');
    expect(r).toMatchObject({ found: true, class: 'cmdb_ci_linux_server', ci: { fqdn: 'payapi01.prod.corp', ip_address: '10.0.0.5' } });
    expect(r.relationships).toEqual([{ relation: 'Runs', ci: 'payments', ci_sys_id: 'P' }]);
    expect(calls.map((c) => c.path).find((p) => p.includes('cmdb_rel_ci'))).toContain(`parent=${id}^ORchild=${id}`);
  });

  it('offers prefix candidates when there is no exact match', async () => {
    fakeSnow([
      [/sysparm_query=name=pay\b/, () => ({ body: { result: [] } })],
      [/nameSTARTSWITHpay/, () => ({ body: { result: [{ sys_id: dv('b'.repeat(32)), name: dv('payapi01') }] } })],
    ]);
    expect(await getCi(1, 'pay')).toMatchObject({ found: false, candidates: [{ name: 'payapi01' }] });
  });
});

describe('getRelated', () => {
  it('queries changes, incidents and problems on the CI and keeps going when one table is blocked', async () => {
    const calls = fakeSnow([
      [/table\/change_request\?/, () => ({ body: { result: [{ number: dv('CHG1'), short_description: dv('Deploy'), state: dv('Closed'), start_date: dv('x', '2026-11-19 08:30:00'), end_date: dv('x', '2026-11-19 08:50:00') }] } })],
      [/table\/incident\?/, () => ({ status: 403, body: { error: { message: 'User Not Authorized' } } })],
      [/table\/problem\?/, () => ({ body: { result: [] } })],
    ]);
    const r: any = await getRelated(1, { ci: 'payapi01', atMs: Date.UTC(2026, 10, 19, 9, 5), lookbackDays: 3, excludeNumber: 'INC1' });
    expect(calls[0].path).toContain('cmdb_ci.name=payapi01^ORDERBYDESCstart_date');
    expect(r.changes).toEqual([expect.objectContaining({ number: 'CHG1', ended_min_before_incident: 15 })]);
    expect(r.incidents.unavailable).toMatch(/HTTP 403/);
    expect(r.problems).toEqual([]);
  });
});

describe('kbSearch', () => {
  it('falls back to short_description LIKE when full-text search finds nothing', async () => {
    const calls = fakeSnow([
      [/123TEXTQUERY321/, () => ({ body: { result: [] } })],
      [/short_descriptionLIKE/, () => ({ body: { result: [{ number: dv('KB0010'), short_description: dv('Fix ORA-12541'), text: dv('<p>Restart</p>') }] } })],
    ]);
    const r = await kbSearch(1, 'https://acme.service-now.com', 'ORA-12541 listener', 5);
    expect(r.method).toBe('short_description contains');
    expect(r.articles).toEqual([
      expect.objectContaining({ number: 'KB0010', link: 'https://acme.service-now.com/kb_view.do?sysparm_article=KB0010', excerpt: 'Restart' }),
    ]);
    expect(calls[0].path).toContain('workflow_state=published');
  });
});

describe('readAttachment', () => {
  const id = 'c'.repeat(32);
  it('downloads text files with Accept */* and searches them', async () => {
    const calls = fakeSnow([
      [/attachment\/c+\/file/, () => ({ text: 'ok\nERROR boom\nok' })],
      [/attachment\/c+$/, () => ({ body: { result: { file_name: 'app.log', content_type: 'application/octet-stream', size_bytes: '18' } } })],
    ]);
    const r: any = await readAttachment(1, id, { maxChars: 1000, contains: ['error'], context: 0 });
    expect(r).toMatchObject({ readable: true, file_name: 'app.log', excerpt: '2: ERROR boom', matched_lines: 1 });
    expect(calls.find((c) => c.path.endsWith('/file'))!.accept).toBe('*/*');
    expect(calls.find((c) => !c.path.endsWith('/file'))!.accept).toBeNull();
  });

  it('does not download binary files', async () => {
    const calls = fakeSnow([[/attachment\/c+$/, () => ({ body: { result: { file_name: 's.png', content_type: 'image/png' } } })]]);
    expect(await readAttachment(1, id, { maxChars: 1000 })).toMatchObject({ readable: false });
    expect(calls).toHaveLength(1);
  });
});

describe('untrusted wrapping covers every data tool', () => {
  it('wraps the output of every tool except the write tool', () => {
    const names = Object.keys(buildTools(DEFAULT_SETTINGS));
    const msgs = names.map((toolName) => ({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: toolName, toolName, output: { type: 'json', value: { x: 1 } } }],
    }));
    const out = wrapUntrusted(msgs) as any[];
    const unwrapped = names.filter((_, i) => out[i].content[0].output.type === 'json');
    expect(unwrapped).toEqual(['servicenow_add_note']);
  });
});
