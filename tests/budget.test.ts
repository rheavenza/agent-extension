import { ToolLoopAgent, stepCountIs } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { budgetPrepareStep, LOW_BUDGET_NOTE, WRAP_UP_NOTE } from '../lib/agent/budget';
import { DEFAULT_SETTINGS } from '../lib/settings';
import { buildTools, toolApproval } from '../lib/tools';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const call = (fn: ReturnType<typeof budgetPrepareStep>, stepNumber: number) =>
  fn({ stepNumber } as never) as { toolChoice?: string; instructions?: string };

describe('budgetPrepareStep', () => {
  it('leaves early steps alone, nudges near the end, forces a report on the last step', () => {
    const fn = budgetPrepareStep({ maxSteps: 10, maxMinutes: 60 }, 'BASE');
    expect(call(fn, 0)).toEqual({ instructions: 'BASE' });
    expect(call(fn, 6).instructions).toContain(LOW_BUDGET_NOTE);
    expect(call(fn, 6).toolChoice).toBeUndefined();
    const last = call(fn, 9);
    expect(last.toolChoice).toBe('none');
    expect(last.instructions).toContain(WRAP_UP_NOTE);
    expect(last.instructions!.startsWith('BASE')).toBe(true);
  });

  it('forces a report once the time budget is used up', () => {
    let t = 0;
    const fn = budgetPrepareStep({ maxSteps: 100, maxMinutes: 5 }, 'BASE', () => t);
    t = 4.1 * 60_000;
    expect(call(fn, 1).instructions).toContain(LOW_BUDGET_NOTE);
    t = 5 * 60_000;
    expect(call(fn, 2).toolChoice).toBe('none');
  });
});

describe('agent with budget', () => {
  it('ends with a written report even when the model would keep calling tools forever', async () => {
    (globalThis as any).chrome = { tabs: { query: async () => [] } };
    const seen: Array<string | undefined> = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (opts: any) => {
        seen.push(opts.toolChoice?.type);
        if (opts.toolChoice?.type === 'none') {
          return {
            content: [{ type: 'text', text: 'Report: nothing found yet.' }],
            finishReason: { unified: 'stop', raw: 'end_turn' },
            usage,
            warnings: [],
          } as never;
        }
        return {
          content: [{ type: 'tool-call', toolCallId: `c${seen.length}`, toolName: 'list_tabs', input: '{}' }],
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage,
          warnings: [],
        } as never;
      },
    });
    const agent = new ToolLoopAgent({
      model,
      instructions: 'BASE',
      tools: buildTools(DEFAULT_SETTINGS),
      toolApproval,
      stopWhen: stepCountIs(4),
      prepareStep: budgetPrepareStep({ maxSteps: 4, maxMinutes: 60 }, 'BASE'),
    });
    const r = await agent.generate({ prompt: 'investigate' });
    expect(r.steps).toHaveLength(4);
    expect(seen.at(-1)).toBe('none');
    expect(r.text).toBe('Report: nothing found yet.');
  });
});
