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
import { budgetPrepareStep } from './budget';
import { buildSystemPrompt } from './system-prompt';

export function buildAgent(s: Settings) {
  const instructions = buildSystemPrompt(s.extraInstructions);
  return new ToolLoopAgent({
    model: createModel(s),
    instructions,
    tools: buildTools(s),
    toolApproval,
    stopWhen: stepCountIs(s.maxSteps),
    // Forces a written report on the last step or when the time budget runs out.
    prepareStep: budgetPrepareStep({ maxSteps: s.maxSteps, maxMinutes: s.maxMinutes }, instructions),
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
