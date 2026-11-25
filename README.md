# SNOW → Splunk Agent

A Chrome/Edge (MV3) side-panel chat agent. It reads ServiceNow tickets from a tab you already have open, then runs Splunk searches in a Splunk tab you already have open. It uses your existing browser sessions, so there's no login, no stored credentials and no backend. The agent loop runs in the side panel and calls Anthropic, OpenAI or NVIDIA NIM directly with your API key.

## Install

```bash
pnpm install
pnpm build            # → .output/chrome-mv3   (pnpm build:edge for Edge)
```

1. Go to `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick `.output/chrome-mv3`.
3. The Settings page opens on first install. Set:
   - the provider, API key and model
   - your ServiceNow URL pattern, e.g. `https://acme.service-now.com/*`
   - your Splunk URL pattern, e.g. `https://splunk.corp.example.com:8000/*`
4. Click **Save & grant access**. Chrome asks for access to exactly those sites plus the provider's API host.
5. Click the toolbar icon to open the chat.

For development, `pnpm dev` launches Chromium with hot reload (it needs Chrome or Chromium installed).

## How it works

| Tool | What it does | Approval |
|---|---|---|
| `list_tabs` | Lists the open ServiceNow and Splunk tabs plus the tab you're looking at. Other tabs are only counted, so their titles and URLs never reach the model provider. | – |
| `read_servicenow_ticket` | Reads the record open in the ServiceNow tab, or one you name by number, via `/api/now/table` with your session token (`g_ck`). Includes the journal, the indicators found in the text (hosts, IPs, IDs, error codes, exceptions) and a suggested Splunk time window, both worked out in code. | – |
| `servicenow_query` | Runs an encoded query, e.g. tickets you opened | – |
| `servicenow_add_note` | Adds a work note or comment | **always** |
| `splunk_search` | Runs SPL through Splunk Web's `splunkd/__raw` proxy with your session and CSRF cookie, polls the job, and returns capped results. It then shows the job (`?sid=`) in a Splunk tab the agent opens in the background and reuses, so you see the same search. Your own Splunk tabs are never navigated. | only for `delete`, `collect`, `outputlookup`, `sendemail`, `map`, `rest`, `script`, `savedsearch`, …, and for macros not listed under **Settings → Trusted Splunk macros** |
| `splunk_get_results` | Reads more rows from a job by sid (paging, specific fields) without running the search again | – |
| `splunk_metadata` | Lists indexes, sourcetypes, hosts or sources | – |
| `read_page_text` | Reads the visible text of any tab (shadow DOM and iframes included). Fallback when the APIs are blocked by ACLs. | – |

A turn that pauses for your approval keeps its step and time budget when it resumes. Time spent waiting for you to click Approve doesn't count.

Each request is injected into your tab with `chrome.scripting.executeScript` and runs with that page's origin, so the browser attaches your cookies itself.

Searches that time out are finalized (Splunk stops and keeps what it found), searches you stop are cancelled, and every job is created with `auto_cancel` so a closed panel doesn't leave it running against your search quota.

To keep long investigations within the context window, one Splunk result is capped at about 40k characters, and only the three most recent large results stay in full in what the model sees. Older ones are cut to their metadata and a few sample rows. The chat keeps every result in full.

Ticket text and log events are treated as untrusted. They reach the model wrapped in `<untrusted source="...">` tags, with any such tag inside the data defused. The system prompt tells the model to ignore instructions found in them, and every write needs your approval. Images in the model's replies are never rendered, so injected text can't leak data through an image URL, and only http(s) links are kept.

**Tip:** put your environment's conventions in **Settings → Extra instructions**, for example: "app logs: `index=app_prod sourcetype=app:json`; ServiceNow `cmdb_ci` equals the Splunk `host`". This is the biggest single improvement to search quality.

## Layout

```
entrypoints/  background.ts (opens side panel), sidepanel/ (chat), options/ (settings)
components/   Chat, Message, ToolCard (incl. approve/deny), SettingsPage
lib/agent/    ToolLoopAgent + in-page transport, system prompt
lib/llm/      provider factory (Anthropic / OpenAI / NIM via OpenAI-compatible)
lib/tools/    tool definitions + approval rules
lib/servicenow, lib/splunk   REST clients + pure helpers (URL parsing, SPL guard, result trimming)
lib/injected/ functions executed inside your tabs (must stay self-contained)
tests/        vitest
```

## Test

```bash
pnpm test        # URL parsing, SPL guard, time normalization, result trimming, approval gating
pnpm typecheck
```

## Troubleshooting

- **"The extension has no access to this tab's site"**: add the site's pattern in Settings and click Save & grant access.
- **ServiceNow 401**: the `g_ck` token is missing or expired. Reload the ServiceNow tab.
- **ServiceNow 403**: ACLs block REST for your role. The agent falls back to `read_page_text`.
- **Splunk 401/403**: the session expired, or the `splunkweb_csrf_token_<port>` cookie is missing. Reload or log in to the Splunk tab.
- **NIM**: pick a model that supports tool calling. The default `integrate.api.nvidia.com` base URL needs an `nvapi-` key; a self-hosted NIM usually doesn't.
