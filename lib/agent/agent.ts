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
import { budgetPrepareStep, remainingSteps, type Budget } from './budget';
import { pruneToolResults, wrapUntrusted } from './context';
import { buildSystemPrompt } from './system-prompt';

export interface TurnUsage {
  stepsUsed: number;
  msUsed: number;
}

export function buildAgent(s: Settings, used: TurnUsage = { stepsUsed: 0, msUsed: 0 }) {
  const instructions = buildSystemPrompt(s.extraInstructions);
  const tools = buildTools(s);
  const limits: Budget = { maxSteps: s.maxSteps, maxMinutes: s.maxMinutes, ...used };
  const budget = budgetPrepareStep<typeof tools>(limits, instructions);
  return new ToolLoopAgent({
    model: createModel(s),
    instructions,
    tools,
    toolApproval: buildToolApproval(s),
    stopWhen: stepCountIs(remainingSteps(limits)),
    prepareStep: async (opts) => {
      // Forces a written report on the last step or when the time budget runs out.
      const step = await budget(opts);
      // What the model sees, not what the chat keeps: older large results trimmed, and data from
      // tickets, pages and logs marked as untrusted.
      const messages = wrapUntrusted(pruneToolResults(opts.messages));
      return messages === opts.messages ? step : { ...step, messages };
    },
    providerOptions: providerOptions(s),
    maxRetries: 2,
  });
}

export type AgentUIMessage = InferAgentUIMessage<ReturnType<typeof buildAgent>>;

/**
 * Where the conversation stands: a new user message starts a turn; a request whose last message is
 * the assistant's continues the same turn (after a tool approval). Steps already taken in the turn
 * are the step-start parts of that assistant message.
 */
export function turnProgress(messages: UIMessage[]): { continuing: boolean; stepsUsed: number } {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return { continuing: false, stepsUsed: 0 };
  return { continuing: true, stepsUsed: last.parts.filter((p) => p.type === 'step-start').length };
}

/**
 * Runs the agent in this page (the side panel), with no server. A fresh agent is built from the
 * latest settings on every send, so provider or model changes apply right away.
 */
export class LocalAgentTransport implements ChatTransport<UIMessage> {
  /** Agent time spent so far in the current turn, across approval pauses. */
  private msUsed = 0;

  constructor(
    private readonly getSettings: () => Settings,
    private readonly now: () => number = Date.now,
  ) {}

  async sendMessages(options: Parameters<ChatTransport<UIMessage>['sendMessages']>[0]) {
    const { continuing, stepsUsed } = turnProgress(options.messages);
    if (!continuing) this.msUsed = 0;
    const agent = buildAgent(this.getSettings(), { stepsUsed, msUsed: this.msUsed });
    const inner = new DirectChatTransport({
      agent,
      sendReasoning: true,
      onError: (e) => (e instanceof Error ? e.message : String(e)),
    });
    const started = this.now();
    const stream = await inner.sendMessages(options as never);
    // Count the time this request ran; the time the user takes to approve is not counted.
    return stream.pipeThrough(
      new TransformStream({
        flush: () => {
          this.msUsed += this.now() - started;
        },
      }),
    );
  }

  async reconnectToStream() {
    return null;
  }
}
