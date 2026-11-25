import { afterEach, describe, expect, it } from 'vitest';
import { getJournal, getRecord } from '../lib/servicenow/client';

function fakeSnow(handler: (path: string) => { status: number; body: unknown }) {
  const paths: string[] = [];
  (globalThis as any).chrome = {
    tabs: { get: async () => ({ id: 1, status: 'complete' }) },
    scripting: {
      executeScript: async ({ args: [path] }: { args: [string] }) => {
        paths.push(path);
        const r = handler(path);
        return [{ result: { ok: r.status < 400, status: r.status, text: JSON.stringify(r.body), hasToken: true, url: path } }];
      },
    },
  };
  return paths;
}

afterEach(() => {
  delete (globalThis as any).chrome;
});

describe('getRecord', () => {
  it('rejects a number that would change the encoded query', async () => {
    const paths = fakeSnow(() => ({ status: 200, body: { result: [] } }));
    await expect(getRecord(1, { table: 'incident', number: 'INC0012345^ORnumberISNOTEMPTY' })).rejects.toThrow(
      /doesn't look like a ticket number/,
    );
    expect(paths).toHaveLength(0);
  });
});

describe('getJournal', () => {
  it('says the journal could not be read instead of returning null', async () => {
    fakeSnow(() => ({ status: 403, body: { error: { message: 'User Not Authorized' } } }));
    const r = await getJournal(1, 'a'.repeat(32));
    expect(r).toHaveProperty('unavailable');
    expect((r as { unavailable: string }).unavailable).toMatch(/HTTP 403/);
  });

  it('returns the entries when readable', async () => {
    fakeSnow(() => ({
      status: 200,
      body: { result: [{ element: 'work_notes', value: 'restarted', sys_created_on: '2026-11-19 09:00:00', sys_created_by: 'bob' }] },
    }));
    expect(await getJournal(1, 'a'.repeat(32))).toEqual([
      { element: 'work_notes', created_on: '2026-11-19 09:00:00', created_by: 'bob', value: 'restarted' },
    ]);
  });
});
