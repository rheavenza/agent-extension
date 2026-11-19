import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LocalAgentTransport } from '@/lib/agent/agent';
import { saveChat, type StoredChat } from '@/lib/chat-store';
import { PROVIDER_LABELS, saveSettings, type ProviderId, type Settings } from '@/lib/settings';
import ErrorBoundary from './ErrorBoundary';
import Message from './Message';

const SUGGESTIONS = [
  'Read the ServiceNow ticket open in my tab and find related errors in Splunk.',
  'List the active tickets I opened.',
  'Which Splunk indexes can I search?',
];

export default function Chat({
  chat,
  settings,
  onNewChat,
}: {
  chat: StoredChat;
  settings: Settings;
  onNewChat: () => void;
}) {
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const transport = useMemo(() => new LocalAgentTransport(() => settingsRef.current), []);

  const { messages, sendMessage, status, stop, error, regenerate, addToolApprovalResponse, clearError } = useChat({
    id: chat.id,
    messages: chat.messages,
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  const busy = status === 'submitted' || status === 'streaming';

  // Save the conversation whenever a turn settles.
  useEffect(() => {
    if (!busy) saveChat({ id: chat.id, messages: messages as UIMessage[] }).catch(console.error);
  }, [busy, messages, chat.id]);

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Block body on purpose: newer Chrome returns a Promise from scrollIntoView(), and React
    // would treat any returned value as the effect's cleanup and crash calling it.
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const [input, setInput] = useState('');
  const submit = (text = input) => {
    const t = text.trim();
    if (!t || busy) return;
    clearError();
    sendMessage({ text: t });
    setInput('');
  };

  const p = settings.providers[settings.provider];
  const needsKey = !p.apiKey && settings.provider !== 'nim';

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
        <select
          className="rounded border border-zinc-300 bg-transparent px-1 py-0.5 text-xs dark:border-zinc-700"
          value={settings.provider}
          onChange={(e) => saveSettings({ ...settings, provider: e.target.value as ProviderId })}
          title="Provider"
        >
          {(Object.keys(PROVIDER_LABELS) as ProviderId[]).map((id) => (
            <option key={id} value={id} className="bg-white dark:bg-zinc-900">
              {PROVIDER_LABELS[id]}
            </option>
          ))}
        </select>
        <span className="truncate text-xs text-zinc-500" title={p.model}>
          {p.model}
        </span>
        <div className="ml-auto flex gap-1">
          <button className="btn" onClick={onNewChat} disabled={busy} title="New chat">
            New
          </button>
          <button className="btn" onClick={() => chrome.runtime.openOptionsPage()} title="Settings">
            Settings
          </button>
        </div>
      </header>

      <main className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {needsKey && (
          <div className="rounded border border-amber-400 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            No API key set for {PROVIDER_LABELS[settings.provider]}.{' '}
            <button className="underline" onClick={() => chrome.runtime.openOptionsPage()}>
              Open Settings
            </button>
          </div>
        )}
        {messages.length === 0 && (
          <div className="space-y-2 pt-6 text-sm">
            <p className="text-zinc-500">
              I work in your open ServiceNow and Splunk tabs using the sessions you're already logged in with.
            </p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                className="block w-full rounded border border-zinc-200 px-3 py-2 text-left hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                onClick={() => submit(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) => (
          <ErrorBoundary key={m.id} inline>
            <Message message={m as UIMessage} onApproval={addToolApprovalResponse} />
          </ErrorBoundary>
        ))}
        {status === 'submitted' && <div className="text-xs text-zinc-500">Thinking…</div>}
        {error && (
          <div className="rounded border border-red-400 bg-red-50 p-2 text-xs text-red-900 dark:bg-red-950 dark:text-red-200">
            <div className="font-medium">Error</div>
            <div className="whitespace-pre-wrap break-words">{error.message}</div>
            <button className="mt-1 underline" onClick={() => regenerate()}>
              Retry
            </button>
          </div>
        )}
        <div ref={bottomRef} />
      </main>

      <form
        className="border-t border-zinc-200 p-2 dark:border-zinc-800"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          className="w-full resize-none rounded border border-zinc-300 bg-transparent p-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700"
          rows={3}
          placeholder="Ask about a ticket, e.g. “Check INC0012345 in Splunk”. Enter sends, Shift+Enter adds a new line."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="mt-1 flex justify-end gap-2">
          {busy ? (
            <button type="button" className="btn btn-danger" onClick={() => stop()}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={!input.trim()}>
              Send
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
