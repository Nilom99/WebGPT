import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDatabase,
  formatConversationAsJson,
  formatConversationAsTxt,
} from '../lib/db.js';

test('database persistence lifecycle (create, save messages, search, rename, export, delete)', async () => {
  const db = createDatabase();

  const conv = await db.createConversation('Web Worker Guide');
  assert.ok(conv.id.startsWith('conv_'));
  assert.equal(conv.title, 'Web Worker Guide');
  assert.equal(conv.systemInstruction, undefined);

  await db.saveMessage({
    conversationId: conv.id,
    role: 'user',
    content: 'How do Web Workers operate?',
  });
  await db.saveMessage({
    conversationId: conv.id,
    role: 'assistant',
    content: 'Web Workers run scripts on a background thread.',
  });

  const messages = await db.getMessages(conv.id);
  assert.equal(messages.length, 2);

  const searchHits = await db.searchConversations('background thread');
  assert.equal(searchHits.length, 1);

  const renamed = await db.renameConversation(conv.id, 'Background Threads');
  assert.equal(renamed.title, 'Background Threads');

  const txt = formatConversationAsTxt(renamed, messages);
  assert.ok(txt.includes('SM GPT Conversation Export'));
  assert.ok(txt.includes('Background Threads'));

  const json = JSON.parse(formatConversationAsJson(renamed, messages));
  assert.equal(json.application, 'SM GPT');
  assert.equal(json.creator, 'Abdus Nilom');
  assert.equal(json.messages.length, 2);

  await db.deleteConversation(conv.id);
  const afterDelete = await db.listConversations();
  assert.equal(afterDelete.length, 0);
});
