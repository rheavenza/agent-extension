// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mode = vi.hoisted(() => ({ value: 'text' as 'text' | 'nokey' | 'tool' }));

vi.mock('../lib/llm/providers', () => ({
  providerOptions: () => undefined,
  createModel: () => {
    if (mode.value === 'nokey') throw new Error('No API key set for anthropic. Open Settings to add one.');
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    let call = 0;
    return new MockLanguageModelV4({
      doStream: async () => {
        call++;
        const chunks: any[] = [{ type: 'stream-start', warnings: [] }];
        if (mode.value === 'tool' && call === 1) {
          chunks.push(
            { type: 'reasoning-start', id: 'r' },
            { type: 'reasoning-delta', id: 'r', delta: 'thinking' },
            { type: 'reasoning-end', id: 'r' },
            { type: 'tool-call', toolCallId: 't1', toolName: 'list_tabs', input: '{}' },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
          );
        } else {
          chunks.push(
            { type: 'text-start', id: 'a' },
            { type: 'text-delta', id: 'a', delta: 'Hello **there**' },
            { type: 'text-end', id: 'a' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
          );
        }
        return { stream: simulateReadableStream({ chunks }) } as any;
      },
    });
  },
}));

import { StrictMode } from 'react';
import Chat from '../components/Chat';
import { DEFAULT_SETTINGS } from '../lib/settings';

beforeEach(() => {
  cleanup();
  const store: Record<string, unknown> = {};
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (o: Record<string, unknown>) => Object.assign(store, o),
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    runtime: { openOptionsPage() {} },
    tabs: { query: async () => [{ id: 1, url: 'https://x.service-now.com/', title: 'SN', active: true }] },
  };
  // Current Chrome returns a Promise from scrollIntoView(); mimic it to catch effect-cleanup bugs.
  (Element.prototype as any).scrollIntoView = () => Promise.resolve();
});

async function send(text: string) {
  const s = { ...DEFAULT_SETTINGS, providers: { ...DEFAULT_SETTINGS.providers, anthropic: { ...DEFAULT_SETTINGS.providers.anthropic, apiKey: 'k' } } };
  render(<StrictMode><Chat chat={{ id: 'c', messages: [] }} settings={s} onNewChat={() => {}} /></StrictMode>);
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(box, { key: 'Enter' });
  });
}

describe('Chat UI', () => {
  it.each(['text', 'nokey', 'tool'] as const)('renders without crashing (%s)', async (m) => {
    mode.value = m;
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a) => { errors.push(a); orig(...a); };
    await send('hi');
    await waitFor(() => expect(screen.queryByText(/Thinking/)).toBeNull(), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 300));
    console.error = orig;
    const effectWarnings = errors.filter((a) => String((a as unknown[])[0]).includes('must not return anything besides a function'));
    expect(effectWarnings).toEqual([]);
    expect(screen.getByText('hi')).toBeTruthy();
    if (m === 'nokey') expect(screen.getByText(/No API key set/)).toBeTruthy();
    else expect(screen.getByText(/there/)).toBeTruthy();
  });
});

describe('ErrorBoundary', () => {
  it('shows the error instead of a blank panel', async () => {
    const { default: ErrorBoundary } = await import('../components/ErrorBoundary');
    const Boom = () => {
      throw new Error('kaboom');
    };
    const orig = console.error;
    console.error = () => {};
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    console.error = orig;
    expect(screen.getByText('The agent panel crashed')).toBeTruthy();
    expect(screen.getAllByText(/kaboom/).length).toBeGreaterThan(0);
  });
});
