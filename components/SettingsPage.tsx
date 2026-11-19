import { useEffect, useState, type ReactNode } from 'react';
import { originToPattern } from '@/lib/match';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  PROVIDER_LABELS,
  requiredOrigins,
  saveSettings,
  type Effort,
  type ProviderId,
  type Settings,
} from '@/lib/settings';

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => originToPattern(l))
    .filter((l): l is string => !!l);

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [snowText, setSnowText] = useState('');
  const [splunkText, setSplunkText] = useState('');
  const [status, setStatus] = useState<{ msg: string; ok: boolean } | null>(null);
  const [granted, setGranted] = useState<Record<string, boolean>>({});

  const refreshGrants = async (cfg: Settings) => {
    const out: Record<string, boolean> = {};
    for (const o of requiredOrigins(cfg)) {
      try {
        out[o] = await chrome.permissions.contains({ origins: [o] });
      } catch {
        out[o] = false;
      }
    }
    setGranted(out);
  };

  useEffect(() => {
    loadSettings().then((cfg) => {
      setS(cfg);
      setSnowText(cfg.servicenowPatterns.join('\n'));
      setSplunkText(cfg.splunkPatterns.join('\n'));
      refreshGrants(cfg);
    });
  }, []);

  if (!s) return <div className="p-6 text-sm">Loading…</div>;

  const p = s.providers[s.provider];
  const setProvider = (patch: Partial<typeof p>) =>
    setS({ ...s, providers: { ...s.providers, [s.provider]: { ...p, ...patch } } });

  const save = async () => {
    const next: Settings = { ...s, servicenowPatterns: lines(snowText), splunkPatterns: lines(splunkText) };
    // Must run inside the click handler (user gesture) for Chrome to show the permission prompt.
    const origins = requiredOrigins(next);
    let ok = true;
    try {
      ok = await chrome.permissions.request({ origins });
    } catch (e) {
      ok = false;
      setStatus({ msg: `Permission request failed: ${(e as Error).message}`, ok: false });
    }
    await saveSettings(next);
    setS(next);
    setSnowText(next.servicenowPatterns.join('\n'));
    setSplunkText(next.splunkPatterns.join('\n'));
    await refreshGrants(next);
    setStatus(ok ? { msg: 'Saved. Site access granted.', ok: true } : { msg: 'Saved, but site access was not granted.', ok: false });
  };

  return (
    <div className="mx-auto max-w-2xl space-y-8 p-6">
      <h1 className="text-xl font-semibold">SNOW → Splunk Agent: Settings</h1>

      <section className="space-y-4">
        <h2 className="text-base font-semibold">Model provider</h2>
        <Row label="Provider">
          <select className="field" value={s.provider} onChange={(e) => setS({ ...s, provider: e.target.value as ProviderId })}>
            {(Object.keys(PROVIDER_LABELS) as ProviderId[]).map((id) => (
              <option key={id} value={id} className="bg-white dark:bg-zinc-900">
                {PROVIDER_LABELS[id]}
              </option>
            ))}
          </select>
        </Row>
        <Row label="API key" hint="Saved only in this browser profile (chrome.storage.local). It is sent only to the base URL below.">
          <input
            className="field font-mono"
            type="password"
            autoComplete="off"
            value={p.apiKey}
            placeholder={s.provider === 'nim' ? 'nvapi-… (optional for a self-hosted NIM)' : ''}
            onChange={(e) => setProvider({ apiKey: e.target.value.trim() })}
          />
        </Row>
        <Row
          label="Model"
          hint={
            s.provider === 'anthropic'
              ? 'e.g. claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5'
              : s.provider === 'nim'
                ? 'NIM model id, e.g. meta/llama-3.3-70b-instruct. Pick a model that supports tool calling.'
                : 'OpenAI model id'
          }
        >
          <input className="field font-mono" value={p.model} onChange={(e) => setProvider({ model: e.target.value.trim() })} />
        </Row>
        <Row label="Base URL" hint={`Default: ${DEFAULT_SETTINGS.providers[s.provider].baseURL}. Change it for a proxy or a self-hosted NIM (http://host:8000/v1).`}>
          <input className="field font-mono" value={p.baseURL} onChange={(e) => setProvider({ baseURL: e.target.value.trim() })} />
        </Row>
        {s.provider === 'anthropic' && (
          <>
            <Row label="Effort" hint="Higher is more thorough but slower and uses more tokens. high is a good fit for multi-step investigations.">
              <select className="field" value={s.effort} onChange={(e) => setS({ ...s, effort: e.target.value as Effort })}>
                {(['low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).map((e) => (
                  <option key={e} value={e} className="bg-white dark:bg-zinc-900">
                    {e}
                  </option>
                ))}
              </select>
            </Row>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={s.anthropicFallbacks}
                onChange={(e) => setS({ ...s, anthropicFallbacks: e.target.checked })}
              />
              Server-side refusal fallback (if the model declines a request, Anthropic retries on a fallback model)
            </label>
          </>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-base font-semibold">Sites</h2>
        <Row label="ServiceNow URL patterns" hint="One per line. A bare origin like https://acme.service-now.com works too.">
          <textarea className="field font-mono" rows={3} value={snowText} onChange={(e) => setSnowText(e.target.value)} />
        </Row>
        <Row label="Splunk URL patterns" hint="One per line, e.g. https://splunk.corp.example.com/* or https://splunk.corp.example.com:8000/*">
          <textarea className="field font-mono" rows={3} value={splunkText} onChange={(e) => setSplunkText(e.target.value)} />
        </Row>
        <div className="grid grid-cols-3 gap-3">
          <Row label="Default Splunk app">
            <input className="field" value={s.splunkDefaultApp} onChange={(e) => setS({ ...s, splunkDefaultApp: e.target.value.trim() || 'search' })} />
          </Row>
          <Row label="Max rows to the model">
            <input
              className="field"
              type="number"
              min={1}
              max={500}
              value={s.splunkMaxResults}
              onChange={(e) => setS({ ...s, splunkMaxResults: Math.max(1, Math.min(500, Number(e.target.value) || 50)) })}
            />
          </Row>
          <Row label="Search timeout (s)">
            <input
              className="field"
              type="number"
              min={10}
              max={900}
              value={s.splunkSearchTimeoutSec}
              onChange={(e) => setS({ ...s, splunkSearchTimeoutSec: Math.max(10, Number(e.target.value) || 120) })}
            />
          </Row>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.splunkSyncTab} onChange={(e) => setS({ ...s, splunkSyncTab: e.target.checked })} />
          Show each finished search in my Splunk tab (navigates it to the job's sid)
        </label>
      </section>

      <section className="space-y-4">
        <h2 className="text-base font-semibold">Agent</h2>
        <Row label="Max steps per turn">
          <input
            className="field w-32"
            type="number"
            min={3}
            max={100}
            value={s.maxSteps}
            onChange={(e) => setS({ ...s, maxSteps: Math.max(3, Number(e.target.value) || 25) })}
          />
        </Row>
        <Row
          label="Extra instructions"
          hint="Your environment's conventions, e.g. “App logs are in index=app_prod, sourcetype=app:json; the host is in field host; ServiceNow cmdb_ci equals the Splunk host.”"
        >
          <textarea className="field" rows={5} value={s.extraInstructions} onChange={(e) => setS({ ...s, extraInstructions: e.target.value })} />
        </Row>
      </section>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary px-4 py-1.5 text-sm" onClick={save}>
          Save &amp; grant access
        </button>
        {status && <span className={`text-sm ${status.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>{status.msg}</span>}
      </div>

      <section className="space-y-1 text-xs">
        <h2 className="text-sm font-semibold">Site access</h2>
        {Object.entries(granted).map(([o, ok]) => (
          <div key={o} className="font-mono">
            <span className={ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}>{ok ? '✓' : '✗'}</span> {o}
          </div>
        ))}
      </section>
    </div>
  );
}
