import { readUIMessageStream, type UIMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { budgetPrepareStep, WRAP_UP_NOTE } from '../lib/agent/budget';

const seen = vi.hoisted(() => ({ toolChoices: [] as Array<string | undefined> }));

vi.mock('../lib/llm/providers', () => ({
  providerOptions: () => undefined,
  createModel: () => {
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    return new MockLanguageModelV4({
      doStream: async (opts: any) => {
        seen.toolChoices.push(opts.toolChoice?.type);
        const n = seen.toolChoices.length;
        const chunks: any[] = [{ type: 'stream-start', warnings: [] }];
        if (opts.toolChoice?.type === 'none') {
          chunks.push(
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'Report.' },
            { type: 'text-end', id: 't' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
          );
        } else {
          // Keep asking to write a note, which always needs approval.
          chunks.push(
            {
              type: 'tool-call',
              toolCallId: `c${n}`,
              toolName: 'servicenow_add_note',
              input: JSON.stringify({ table: 'incident', sys_id: 'a'.repeat(32), text: 'x' }),
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
          );
        }
        const { simulateReadableStream } = await import('ai');
        return { stream: simulateReadableStream({ chunks }) } as any;
      },
    });
  },
}));

import { LocalAgentTransport, turnProgress } from '../lib/agent/agent';
import { DEFAULT_SETTINGS } from '../lib/settings';

beforeEach(() => {
  seen.toolChoices = [];
  (globalThis as any).chrome = { tabs: { query: async () => [] } };
});

async function send(t: LocalAgentTransport, messages: UIMessage[]): Promise<UIMessage> {
  const last = messages[messages.length - 1];
  const stream = await t.sendMessages({
    trigger: 'submit-message',
    chatId: 'c',
    messageId: undefined,
    messages,
    abortSignal: undefined,
  });
  let msg: UIMessage | undefined;
  for await (const m of readUIMessageStream({ stream, message: last.role === 'assistant' ? last : undefined })) msg = m;
  return msg!;
}

/** Approve every pending approval in the assistant message, like clicking Approve. */
function approveAll(m: UIMessage): UIMessage {
  return {
    ...m,
    parts: m.parts.map((p: any) =>
      p.state === 'approval-requested' ? { ...p, state: 'approval-responded', approval: { ...p.approval, approved: true } } : p,
    ),
  };
}

describe('budget across approval pauses', () => {
  it('counts steps from earlier requests in the same turn and forces the report', async () => {
    const t = new LocalAgentTransport(() => ({ ...DEFAULT_SETTINGS, maxSteps: 3 }));
    const user: UIMessage = { id: 'u', role: 'user', parts: [{ type: 'text', text: 'go' }] };

    let a = await send(t, [user]); // step 1 → approval
    expect(turnProgress([user, a])).toEqual({ continuing: true, stepsUsed: 1 });
    a = await send(t, [user, approveAll(a)]); // step 2 → approval
    a = await send(t, [user, approveAll(a)]); // step 3: budget used up → report, no tools

    expect(seen.toolChoices.at(-1)).toBe('none');
    expect(seen.toolChoices).toHaveLength(3);
    expect(a.parts.some((p) => p.type === 'text' && p.text === 'Report.')).toBe(true);
  });

  it('starts a fresh budget on a new user message', () => {
    const u: UIMessage = { id: 'u', role: 'user', parts: [{ type: 'text', text: 'again' }] };
    expect(turnProgress([u])).toEqual({ continuing: false, stepsUsed: 0 });
  });
});

describe('budgetPrepareStep with earlier usage', () => {
  it('subtracts steps and time already used', () => {
    const call = (fn: ReturnType<typeof budgetPrepareStep>, n: number) => fn({ stepNumber: n } as never) as any;
    expect(call(budgetPrepareStep({ maxSteps: 10, maxMinutes: 60, stepsUsed: 9 }, 'B'), 0).toolChoice).toBe('none');
    const t = 0;
    const timed = budgetPrepareStep({ maxSteps: 100, maxMinutes: 5, msUsed: 5 * 60_000 }, 'B', () => t);
    expect(call(timed, 0).instructions).toContain(WRAP_UP_NOTE);
  });
});
