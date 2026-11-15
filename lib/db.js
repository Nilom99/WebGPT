/**
 * IndexedDB Persistence Layer for SM GPT
 * Stores conversations, ordered messages, and user settings locally in the browser
 * with graceful in-memory fallback if storage is blocked or unavailable.
 */

import { DEFAULT_SETTINGS } from '../config/app.config.js';

const DB_NAME = 'sm_gpt_db_v1';
const DB_VERSION = 1;
const STORES = {
  CONVERSATIONS: 'conversations',
  MESSAGES: 'messages',
  SETTINGS: 'settings',
};

function generateId(prefix = 'id') {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function createDatabase() {
  let dbPromise = null;
  let memoryFallback = false;

  // In-memory fallback stores if IndexedDB is blocked in private mode
  const memConversations = new Map();
  const memMessages = new Map();
  const memSettings = new Map();

  function openDb() {
    if (memoryFallback || typeof indexedDB === 'undefined') {
      memoryFallback = true;
      return Promise.resolve(null);
    }
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORES.CONVERSATIONS)) {
            const convStore = db.createObjectStore(STORES.CONVERSATIONS, { keyPath: 'id' });
            convStore.createIndex('updatedAt', 'updatedAt', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORES.MESSAGES)) {
            const msgStore = db.createObjectStore(STORES.MESSAGES, { keyPath: 'id' });
            msgStore.createIndex('conversationId', 'conversationId', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
            db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
          memoryFallback = true;
          resolve(null);
        };
      } catch {
        memoryFallback = true;
        resolve(null);
      }
    });

    return dbPromise;
  }

  function runTx(storeNames, mode, fn) {
    return openDb().then((db) => {
      if (!db) return fn(null);
      return new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(storeNames, mode);
          let result;
          const maybePromise = fn(tx, (val) => {
            result = val;
          });
          tx.oncomplete = () => resolve(result !== undefined ? result : maybePromise);
          tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
          tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  return {
    isUsingMemoryFallback() {
      return memoryFallback;
    },

    async getSettings() {
      try {
        const stored = await runTx([STORES.SETTINGS], 'readonly', (tx, setResult) => {
          if (!tx) return memSettings.get('user_settings') ?? null;
          const req = tx.objectStore(STORES.SETTINGS).get('user_settings');
          req.onsuccess = () => setResult(req.result?.value ?? null);
        });
        const merged = { ...DEFAULT_SETTINGS, ...(stored || {}) };
        delete merged.customInstructions;
        delete merged.preferredDevice;
        return merged;
      } catch {
        return { ...DEFAULT_SETTINGS };
      }
    },

    async saveSettings(partialSettings) {
      const current = await this.getSettings();
      const merged = { ...current, ...partialSettings };
      try {
        await runTx([STORES.SETTINGS], 'readwrite', (tx) => {
          if (!tx) {
            memSettings.set('user_settings', merged);
            return;
          }
          tx.objectStore(STORES.SETTINGS).put({ key: 'user_settings', value: merged });
        });
      } catch {
        memSettings.set('user_settings', merged);
      }
      return merged;
    },

    async createConversation(title = 'New Chat') {
      const now = Date.now();
      const conversation = {
        id: generateId('conv'),
        title: title.trim() || 'New Chat',
        createdAt: now,
        updatedAt: now,
      };
      try {
        await runTx([STORES.CONVERSATIONS], 'readwrite', (tx) => {
          if (!tx) {
            memConversations.set(conversation.id, conversation);
            return;
          }
          tx.objectStore(STORES.CONVERSATIONS).put(conversation);
        });
      } catch {
        memConversations.set(conversation.id, conversation);
      }
      return conversation;
    },

    async listConversations() {
      try {
        const items = await runTx([STORES.CONVERSATIONS], 'readonly', (tx, setResult) => {
          if (!tx) return Array.from(memConversations.values());
          const req = tx.objectStore(STORES.CONVERSATIONS).getAll();
          req.onsuccess = () => setResult(req.result || []);
        });
        return (items || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      } catch {
        return Array.from(memConversations.values()).sort((a, b) => b.updatedAt - a.updatedAt);
      }
    },

    async getConversation(id) {
      if (!id) return null;
      try {
        return await runTx([STORES.CONVERSATIONS], 'readonly', (tx, setResult) => {
          if (!tx) return memConversations.get(id) ?? null;
          const req = tx.objectStore(STORES.CONVERSATIONS).get(id);
          req.onsuccess = () => setResult(req.result ?? null);
        });
      } catch {
        return memConversations.get(id) ?? null;
      }
    },

    async renameConversation(id, newTitle) {
      const cleanTitle = (newTitle || '').trim();
      if (!id || !cleanTitle) return null;
      const existing = await this.getConversation(id);
      if (!existing) return null;
      const updated = {
        ...existing,
        title: cleanTitle.slice(0, 80),
        updatedAt: Date.now(),
      };
      try {
        await runTx([STORES.CONVERSATIONS], 'readwrite', (tx) => {
          if (!tx) {
            memConversations.set(id, updated);
            return;
          }
          tx.objectStore(STORES.CONVERSATIONS).put(updated);
        });
      } catch {
        memConversations.set(id, updated);
      }
      return updated;
    },

    async touchConversation(id, maybeTitle = null) {
      const existing = await this.getConversation(id);
      if (!existing) return null;
      const updated = {
        ...existing,
        title: maybeTitle ? maybeTitle.slice(0, 80) : existing.title,
        updatedAt: Date.now(),
      };
      try {
        await runTx([STORES.CONVERSATIONS], 'readwrite', (tx) => {
          if (!tx) {
            memConversations.set(id, updated);
            return;
          }
          tx.objectStore(STORES.CONVERSATIONS).put(updated);
        });
      } catch {
        memConversations.set(id, updated);
      }
      return updated;
    },

    async deleteConversation(id) {
      if (!id) return;
      try {
        await runTx([STORES.CONVERSATIONS, STORES.MESSAGES], 'readwrite', (tx) => {
          if (!tx) {
            memConversations.delete(id);
            for (const [msgId, msg] of memMessages.entries()) {
              if (msg.conversationId === id) memMessages.delete(msgId);
            }
            return;
          }
          tx.objectStore(STORES.CONVERSATIONS).delete(id);
          const msgStore = tx.objectStore(STORES.MESSAGES);
          const index = msgStore.index('conversationId');
          const req = index.getAllKeys(id);
          req.onsuccess = () => {
            for (const key of req.result || []) {
              msgStore.delete(key);
            }
          };
        });
      } catch {
        memConversations.delete(id);
      }
    },

    async getMessages(conversationId) {
      if (!conversationId) return [];
      try {
        const msgs = await runTx([STORES.MESSAGES], 'readonly', (tx, setResult) => {
          if (!tx) {
            return Array.from(memMessages.values()).filter((m) => m.conversationId === conversationId);
          }
          const index = tx.objectStore(STORES.MESSAGES).index('conversationId');
          const req = index.getAll(conversationId);
          req.onsuccess = () => setResult(req.result || []);
        });
        return (msgs || []).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      } catch {
        return Array.from(memMessages.values())
          .filter((m) => m.conversationId === conversationId)
          .sort((a, b) => a.createdAt - b.createdAt);
      }
    },

    async saveMessage(message) {
      const record = {
        id: message.id || generateId('msg'),
        conversationId: message.conversationId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt || Date.now(),
        status: message.status || 'completed',
        meta: message.meta || {},
      };
      try {
        await runTx([STORES.MESSAGES], 'readwrite', (tx) => {
          if (!tx) {
            memMessages.set(record.id, record);
            return;
          }
          tx.objectStore(STORES.MESSAGES).put(record);
        });
      } catch {
        memMessages.set(record.id, record);
      }
      return record;
    },

    async deleteMessage(messageId) {
      if (!messageId) return;
      try {
        await runTx([STORES.MESSAGES], 'readwrite', (tx) => {
          if (!tx) {
            memMessages.delete(messageId);
            return;
          }
          tx.objectStore(STORES.MESSAGES).delete(messageId);
        });
      } catch {
        memMessages.delete(messageId);
      }
    },

    async searchConversations(query) {
      const clean = (query || '').trim().toLowerCase();
      const all = await this.listConversations();
      if (!clean) return all;

      const matched = [];
      for (const conv of all) {
        if ((conv.title || '').toLowerCase().includes(clean)) {
          matched.push(conv);
          continue;
        }
        const msgs = await this.getMessages(conv.id);
        if (msgs.some((m) => (m.content || '').toLowerCase().includes(clean))) {
          matched.push(conv);
        }
      }
      return matched;
    },
  };
}

/**
 * Formats a conversation + messages as clean plain text (.txt export).
 */
export function formatConversationAsTxt(conversation, messages) {
  const lines = [
    `SM GPT Conversation Export`,
    `Title: ${conversation.title}`,
    `Created: ${new Date(conversation.createdAt).toISOString()}`,
    `Updated: ${new Date(conversation.updatedAt).toISOString()}`,
    '------------------------------------------------------------',
    '',
  ];

  for (const msg of messages) {
    const speaker = msg.role === 'user' ? 'You' : 'SM GPT';
    const time = new Date(msg.createdAt).toLocaleString();
    lines.push(`[${speaker}] (${time})`);
    lines.push(msg.content);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Formats a conversation + messages as structured JSON (.json export).
 */
export function formatConversationAsJson(conversation, messages) {
  return JSON.stringify(
    {
      application: 'SM GPT',
      creator: 'Abdus Nilom',
      exportedAt: new Date().toISOString(),
      conversation: {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        status: m.status,
        createdAt: m.createdAt,
      })),
    },
    null,
    2
  );
}
