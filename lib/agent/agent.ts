import {
  DirectChatTransport,
  stepCountIs,
  ToolLoopAgent,
  type ChatTransport,
  type InferAgentUIMessage,
  type UIMessage,
} from 'ai';
import { createModel, providerOptions } from '../llm/providers';
import type { Settings } from '../settings';
import { buildToolApproval, buildTools } from '../tools';
import { budgetPrepareStep } from './budget';
import { pruneToolResults } from './context';
import { buildSystemPrompt } from './system-prompt';

export function buildAgent(s: Settings) {
  const instructions = buildSystemPrompt(s.extraInstructions);
  const tools = buildTools(s);
  const budget = budgetPrepareStep<typeof tools>({ maxSteps: s.maxSteps, maxMinutes: s.maxMinutes }, instructions);
  return new ToolLoopAgent({
    model: createModel(s),
    instructions,
    tools,
    toolApproval: buildToolApproval(s),
    stopWhen: stepCountIs(s.maxSteps),
    prepareStep: async (opts) => {
      // Forces a written report on the last step or when the time budget runs out.
      const step = await budget(opts);
      // Trims older large tool results from what the model sees; the chat keeps them in full.
      const messages = pruneToolResults(opts.messages);
      return messages === opts.messages ? step : { ...step, messages };
    },
    providerOptions: providerOptions(s),
    maxRetries: 2,
  });
}

export type AgentUIMessage = InferAgentUIMessage<ReturnType<typeof buildAgent>>;

/**
 * Runs the agent in this page (the side panel), with no server. A fresh agent is built from the
 * latest settings on every send, so provider or model changes apply right away.
 */
export class LocalAgentTransport implements ChatTransport<UIMessage> {
  constructor(private readonly getSettings: () => Settings) {}

  sendMessages(options: Parameters<ChatTransport<UIMessage>['sendMessages']>[0]) {
    const agent = buildAgent(this.getSettings());
    const inner = new DirectChatTransport({
      agent,
      sendReasoning: true,
      onError: (e) => (e instanceof Error ? e.message : String(e)),
    });
    return inner.sendMessages(options as never);
  }

  async reconnectToStream() {
    return null;
  }
}
