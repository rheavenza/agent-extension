import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { Settings } from '../settings';

export function createModel(s: Settings): LanguageModel {
  const p = s.providers[s.provider];
  if (!p.apiKey && s.provider !== 'nim') {
    throw new Error(`No API key set for ${s.provider}. Open Settings to add one.`);
  }
  const baseURL = p.baseURL.trim() || undefined;
  switch (s.provider) {
    case 'anthropic':
      return createAnthropic({
        apiKey: p.apiKey,
        baseURL,
        // Required by the Anthropic API for requests that carry a browser Origin (the extension page).
        headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
      })(p.model);
    case 'openai':
      return createOpenAI({ apiKey: p.apiKey, baseURL })(p.model);
    case 'nim':
      // NIM speaks the OpenAI chat-completions protocol. A self-hosted NIM may not need a key.
      return createOpenAICompatible({
        name: 'nim',
        apiKey: p.apiKey || undefined,
        baseURL: baseURL ?? 'https://integrate.api.nvidia.com/v1',
      })(p.model);
  }
}

/** Provider-specific request options. */
export function providerOptions(s: Settings) {
  if (s.provider !== 'anthropic') return undefined;
  const model = s.providers.anthropic.model;
  const isLegacy = /claude-(3|haiku-4-5|sonnet-4-5|opus-4-5|opus-4-1|opus-4-0|sonnet-4-0)/.test(model);
  return {
    anthropic: {
      ...(isLegacy ? {} : { thinking: { type: 'adaptive' as const, display: 'summarized' as const }, effort: s.effort }),
      // Cache the system prompt, tools and growing history across the agent's steps.
      cacheControl: { type: 'ephemeral' as const },
      ...(s.anthropicFallbacks && !isLegacy
        ? { fallbacks: 'default' as const, anthropicBeta: ['server-side-fallback-2026-07-01'] }
        : {}),
    },
  };
}
