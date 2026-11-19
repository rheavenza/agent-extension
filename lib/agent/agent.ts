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
import { buildTools, toolApproval } from '../tools';
import { buildSystemPrompt } from './system-prompt';

export function buildAgent(s: Settings) {
  return new ToolLoopAgent({
    model: createModel(s),
    instructions: buildSystemPrompt(s.extraInstructions),
    tools: buildTools(s),
    toolApproval,
    stopWhen: stepCountIs(s.maxSteps),
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
