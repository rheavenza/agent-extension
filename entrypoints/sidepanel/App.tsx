import { useEffect, useState } from 'react';
import Chat from '@/components/Chat';
import { loadChat, newChat, type StoredChat } from '@/lib/chat-store';
import { loadSettings, onSettingsChanged, type Settings } from '@/lib/settings';

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [chat, setChat] = useState<StoredChat | null>(null);

  useEffect(() => {
    loadSettings().then(setSettings);
    loadChat().then(setChat);
    return onSettingsChanged(setSettings);
  }, []);

  if (!settings || !chat) return <div className="p-4 text-sm text-zinc-500">Loading…</div>;

  return (
    <Chat
      key={chat.id}
      chat={chat}
      settings={settings}
      onNewChat={async () => setChat(await newChat())}
    />
  );
}
