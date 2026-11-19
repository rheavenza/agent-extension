import type { UIMessage } from 'ai';

const KEY = 'chat:current';

export interface StoredChat {
  id: string;
  messages: UIMessage[];
}

export async function loadChat(): Promise<StoredChat> {
  const r = await chrome.storage.local.get(KEY);
  const c = r[KEY] as StoredChat | undefined;
  return c?.id ? c : { id: crypto.randomUUID(), messages: [] };
}

export async function saveChat(chat: StoredChat): Promise<void> {
  await chrome.storage.local.set({ [KEY]: chat });
}

export async function newChat(): Promise<StoredChat> {
  const c = { id: crypto.randomUUID(), messages: [] };
  await saveChat(c);
  return c;
}
