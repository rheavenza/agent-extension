import { ToolLoopAgent, stepCountIs } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../lib/settings';
import { buildTools, toolApproval } from '../lib/tools';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function modelCalling(toolName: string, input: unknown) {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      call++;
      if (call === 1) {
        return {
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName, input: JSON.stringify(input) }],
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage,
          warnings: [],
        } as never;
      }
      return {
        content: [{ type: 'text', text: 'done' }],
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage,
        warnings: [],
      } as never;
    },
  });
}

function agentWith(model: MockLanguageModelV4) {
  return new ToolLoopAgent({
    model,
    tools: buildTools(DEFAULT_SETTINGS),
    toolApproval,
    stopWhen: stepCountIs(5),
  });
}

const approvalRequests = (r: { steps: Array<{ content: Array<{ type: string }> }> }) =>
  r.steps.flatMap((s) => s.content).filter((c) => c.type === 'tool-approval-request');

describe('tool approval gating', () => {
  it('pauses for approval on risky SPL', async () => {
    const r = await agentWith(modelCalling('splunk_search', { spl: 'index=app | delete' })).generate({ prompt: 'x' });
    expect(approvalRequests(r)).toHaveLength(1);
    expect(r.steps).toHaveLength(1);
  });

  it('pauses for approval on ServiceNow writes', async () => {
    const r = await agentWith(
      modelCalling('servicenow_add_note', { table: 'incident', sys_id: 'a'.repeat(32), text: 'hi' }),
    ).generate({ prompt: 'x' });
    expect(approvalRequests(r)).toHaveLength(1);
  });

  it('runs safe SPL without approval (fails here only because no browser exists)', async () => {
    (globalThis as any).chrome = { tabs: { query: async () => [] } };
    const r = await agentWith(modelCalling('splunk_search', { spl: 'index=app error | stats count by host' })).generate({
      prompt: 'x',
    });
    expect(approvalRequests(r)).toHaveLength(0);
    const err = r.steps[0].content.find((c) => c.type === 'tool-error') as { error: Error } | undefined;
    expect(String(err?.error)).toMatch(/No open splunk tab/);
    expect(r.text).toBe('done');
  });
});
