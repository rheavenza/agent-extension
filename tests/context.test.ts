import { describe, expect, it } from 'vitest';
import { pruneToolResults } from '../lib/agent/context';
import { fitRowsToBudget } from '../lib/splunk/spl';

const bigRows = (n: number) => Array.from({ length: n }, (_, i) => ({ _raw: `event ${i} `.padEnd(500, 'x'), host: `h${i}` }));

const searchResult = (id: string, rows = bigRows(20)) => ({
  role: 'tool',
  content: [
    {
      type: 'tool-result',
      toolCallId: id,
      toolName: 'splunk_search',
      output: { type: 'json', value: { sid: `sid-${id}`, resultCount: rows.length, returned: rows.length, results: rows } },
    },
  ],
});
const user = { role: 'user', content: 'go' };

const valueOf = (msg: any) => msg.content[0].output.value;

describe('pruneToolResults', () => {
  it('leaves the history alone when there are only a few results', () => {
    const msgs = [user, searchResult('a'), searchResult('b')];
    expect(pruneToolResults(msgs)).toBe(msgs);
  });

  it('trims older large results and keeps the most recent ones in full', () => {
    const msgs = [user, searchResult('a'), searchResult('b'), searchResult('c'), searchResult('d'), searchResult('e')];
    const out = pruneToolResults(msgs, { keepRecent: 3 });
    expect(out).not.toBe(msgs);
    expect(valueOf(out[1])).toMatchObject({ sid: 'sid-a', trimmed: true, resultCount: 20 });
    expect(valueOf(out[1]).results).toHaveLength(3);
    expect(valueOf(out[2]).trimmed).toBe(true);
    for (const i of [3, 4, 5]) expect(valueOf(out[i]).results).toHaveLength(20);
    // The input is not mutated.
    expect(valueOf(msgs[1]).results).toHaveLength(20);
  });

  it('is deterministic, so trimmed messages stay byte-identical across steps', () => {
    const msgs = [user, searchResult('a'), searchResult('b'), searchResult('c'), searchResult('d')];
    const a = JSON.stringify(pruneToolResults(msgs)[1]);
    const b = JSON.stringify(pruneToolResults([...msgs, searchResult('e')])[1]);
    expect(a).toBe(b);
  });

  it('never trims small results or tools it does not know', () => {
    const small = searchResult('s', bigRows(1));
    const ticket = {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 't', toolName: 'read_servicenow_ticket', output: { type: 'json', value: { big: 'x'.repeat(50_000) } } }],
    };
    const msgs = [small, ticket, searchResult('b'), searchResult('c'), searchResult('d')];
    const out = pruneToolResults(msgs, { keepRecent: 3 });
    expect(out[0]).toBe(small);
    expect(out[1]).toBe(ticket);
  });
});

describe('fitRowsToBudget', () => {
  it('keeps whole rows until the size budget is used up', () => {
    const rows = bigRows(100);
    const { rows: kept, droppedForSize } = fitRowsToBudget(rows, 10_000);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(10_000);
    expect(kept.length + droppedForSize).toBe(100);
    expect(kept.length).toBeGreaterThan(5);
  });

  it('always keeps at least one row', () => {
    expect(fitRowsToBudget([{ a: 'x'.repeat(1000) }], 10).rows).toHaveLength(1);
  });
});

describe('pruneToolResults inside a real agent loop', () => {
  it('trims what the model sees on later steps', async () => {
    const { ToolLoopAgent, stepCountIs, tool } = await import('ai');
    const { MockLanguageModelV4 } = await import('ai/test');
    const { z } = await import('zod');
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const prompts: string[] = [];
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (opts: any) => {
        prompts.push(JSON.stringify(opts.prompt));
        n++;
        if (n <= 5) {
          return {
            content: [{ type: 'tool-call', toolCallId: `c${n}`, toolName: 'splunk_search', input: JSON.stringify({ spl: `q${n}` }) }],
            finishReason: { unified: 'tool-calls', raw: 'tool_use' },
            usage,
            warnings: [],
          } as never;
        }
        return { content: [{ type: 'text', text: 'report' }], finishReason: { unified: 'stop', raw: 'end_turn' }, usage, warnings: [] } as never;
      },
    });
    const agent = new ToolLoopAgent({
      model,
      tools: {
        splunk_search: tool({
          inputSchema: z.object({ spl: z.string() }),
          execute: async ({ spl }) => ({ sid: `sid-${spl}`, resultCount: 20, results: bigRows(20) }),
        }),
      },
      stopWhen: stepCountIs(10),
      prepareStep: ({ messages }) => ({ messages: pruneToolResults(messages) }),
    });
    const r = await agent.generate({ prompt: 'go' });
    expect(r.text).toBe('report');
    const last = prompts.at(-1)!;
    // 5 results: the 2 oldest are trimmed, the 3 newest are full.
    expect(last.match(/"trimmed":true/g)).toHaveLength(2);
    expect(last.length).toBeLessThan(prompts.at(-2)!.length + 15_000);
    // The full results are still in the step history the UI shows.
    const firstResult = r.steps[0].content.find((c: any) => c.type === 'tool-result') as any;
    expect(firstResult.output.results).toHaveLength(20);
  });
});
