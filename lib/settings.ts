export type ProviderId = 'anthropic' | 'openai' | 'nim';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ProviderConfig {
  apiKey: string;
  model: string;
  baseURL: string;
}

export interface Settings {
  provider: ProviderId;
  providers: Record<ProviderId, ProviderConfig>;
  /** Anthropic only. */
  effort: Effort;
  /** Anthropic only: server-side refusal fallback (beta). */
  anthropicFallbacks: boolean;
  /** Match patterns, e.g. https://*.service-now.com/* */
  servicenowPatterns: string[];
  splunkPatterns: string[];
  splunkDefaultApp: string;
  splunkMaxResults: number;
  splunkSearchTimeoutSec: number;
  /** Point the Splunk tab at each finished job (?sid=) so you can see it. */
  splunkSyncTab: boolean;
  maxSteps: number;
  /** Wall-clock budget per turn; when it runs out the agent must report what it has. */
  maxMinutes: number;
  extraInstructions: string;
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  nim: 'NVIDIA NIM',
};

export const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  providers: {
    anthropic: { apiKey: '', model: 'claude-opus-5-5', baseURL: 'https://api.anthropic.com/v1' },
    openai: { apiKey: '', model: 'gpt-5', baseURL: 'https://api.openai.com/v1' },
    nim: { apiKey: '', model: 'meta/llama-3.3-70b-instruct', baseURL: 'https://integrate.api.nvidia.com/v1' },
  },
  effort: 'high',
  anthropicFallbacks: true,
  servicenowPatterns: ['https://*.service-now.com/*'],
  splunkPatterns: ['https://*.splunkcloud.com/*'],
  splunkDefaultApp: 'search',
  splunkMaxResults: 50,
  splunkSearchTimeoutSec: 120,
  splunkSyncTab: true,
  maxSteps: 25,
  maxMinutes: 8,
  extraInstructions: '',
};

const KEY = 'settings';

export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  const s = stored ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    providers: {
      anthropic: { ...DEFAULT_SETTINGS.providers.anthropic, ...s.providers?.anthropic },
      openai: { ...DEFAULT_SETTINGS.providers.openai, ...s.providers?.openai },
      nim: { ...DEFAULT_SETTINGS.providers.nim, ...s.providers?.nim },
    },
  };
}

export async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(KEY);
  return mergeSettings(r[KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: s });
}

export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[KEY]) cb(mergeSettings(changes[KEY].newValue as Partial<Settings>));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Every origin pattern the extension needs host permission for under these settings. */
export function requiredOrigins(s: Settings): string[] {
  const out = new Set<string>([...s.servicenowPatterns, ...s.splunkPatterns]);
  for (const p of Object.values(s.providers)) {
    try {
      if (p.baseURL) out.add(`${new URL(p.baseURL).origin}/*`);
    } catch {
      /* ignore invalid URL */
    }
  }
  return [...out];
}
