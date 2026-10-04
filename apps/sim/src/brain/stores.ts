import type { ConversationStore, NotesStore, SavedConversation } from '@peeqo/brain';

/**
 * Where the simulator keeps Peeqo's memory and recent conversation: as files kept by the dev server
 * (apps/sim/.data/memory.md and conversation.json, so you can open them), or without it (a built page), in this
 * browser. The first load decides which.
 */
export function createStores(): { notes: NotesStore; conversation: ConversationStore } {
  let server: boolean | null = null;

  const load = async (path: string, key: string): Promise<string | null> => {
    if (server !== false) {
      const response = await fetch(path, { cache: 'no-store' }).catch(() => null);
      server ??= response?.ok ?? false;
      if (response?.ok) return response.text();
      if (server) throw new Error(`Loading failed (${response?.status ?? 'no answer'})`);
    }
    try {
      return localStorage.getItem(key);
    } catch {
      return null; // storage blocked: nothing saved
    }
  };
  const save = async (path: string, key: string, type: string, body: string): Promise<void> => {
    if (!server) {
      localStorage.setItem(key, body);
      return;
    }
    const response = await fetch(path, { method: 'PUT', headers: { 'Content-Type': type }, body });
    if (!response.ok) throw new Error(`Saving failed (${response.status})`);
  };

  return {
    notes: {
      load: async () => (await load('/api/memory', 'peeqo.memory')) || null,
      save: (markdown) => save('/api/memory', 'peeqo.memory', 'text/markdown; charset=utf-8', markdown),
    },
    conversation: {
      load: async () => {
        const text = await load('/api/conversation', 'peeqo.conversation');
        try {
          return text ? (JSON.parse(text) as SavedConversation | null) : null;
        } catch {
          return null; // damaged: start afresh
        }
      },
      save: (conversation) => save('/api/conversation', 'peeqo.conversation', 'application/json', JSON.stringify(conversation)),
    },
  };
}
