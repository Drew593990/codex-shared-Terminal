const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ConversationStore } = require('../server/conversation-store');

test('ConversationStore stores clean turns and lists latest conversation state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-conversation-'));
  try {
    const store = new ConversationStore(root, {
      now: (() => {
        const values = [
          '2026-06-14T01:00:00.000Z',
          '2026-06-14T01:00:01.000Z',
          '2026-06-14T01:00:02.000Z'
        ];
        return () => values.shift();
      })(),
      idFactory: (() => {
        let index = 0;
        return () => `turn-${++index}`;
      })()
    });

    const first = await store.appendTurn({
      conversationId: 'direct-smoke',
      agent: 'echo',
      prompt: 'hello',
      reply: 'hello',
      status: 'completed',
      raw: { command: 'echo' }
    });
    const second = await store.appendTurn({
      conversationId: 'direct-smoke',
      agent: 'echo',
      prompt: 'again',
      reply: 'again',
      status: 'completed'
    });

    const turns = await store.readTurns('direct-smoke');
    assert.deepEqual(turns.map((turn) => turn.turnId), ['turn-1', 'turn-2']);
    assert.equal(turns[0].conversationId, 'direct-smoke');
    assert.equal(turns[0].prompt, 'hello');
    assert.equal(turns[0].reply, 'hello');
    assert.deepEqual(turns[0].raw, { command: 'echo' });
    assert.equal(second.createdAt, '2026-06-14T01:00:01.000Z');

    const conversations = await store.listConversations();
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].conversationId, 'direct-smoke');
    assert.equal(conversations[0].agent, 'echo');
    assert.equal(conversations[0].turnCount, 2);
    assert.equal(conversations[0].lastPrompt, 'again');
    assert.equal(conversations[0].lastReply, 'again');
    assert.equal(conversations[0].updatedAt, second.createdAt);
    assert.equal(first.status, 'completed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ConversationStore validates conversation ids before writing files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-conversation-'));
  try {
    const store = new ConversationStore(root);
    await assert.rejects(
      () => store.appendTurn({ conversationId: '..\\bad', agent: 'echo', prompt: 'x', reply: 'x' }),
      /Invalid conversation id/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ConversationStore updates an existing turn without increasing turn count', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-conversation-'));
  try {
    const store = new ConversationStore(root, {
      now: (() => {
        const values = [
          '2026-06-14T01:00:00.000Z',
          '2026-06-14T01:00:05.000Z'
        ];
        return () => values.shift();
      })(),
      idFactory: () => 'turn-running'
    });

    const running = await store.appendTurn({
      conversationId: 'direct-running',
      agent: 'opencode',
      prompt: 'inspect',
      status: 'running'
    });
    const completed = await store.updateTurn('direct-running', running.turnId, {
      reply: 'done',
      status: 'completed',
      raw: { exitCode: 0 },
      agentState: { opencodeSessionId: 'ses_done' }
    });

    assert.equal(running.status, 'running');
    assert.equal(running.completedAt, null);
    assert.equal(completed.createdAt, running.createdAt);
    assert.equal(completed.completedAt, '2026-06-14T01:00:05.000Z');

    const turns = await store.readTurns('direct-running');
    assert.equal(turns.length, 1);
    assert.equal(turns[0].turnId, 'turn-running');
    assert.equal(turns[0].status, 'completed');
    assert.equal(turns[0].reply, 'done');

    const conversations = await store.listConversations();
    assert.equal(conversations[0].turnCount, 1);
    assert.equal(conversations[0].status, 'completed');
    assert.equal(conversations[0].lastReply, 'done');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
