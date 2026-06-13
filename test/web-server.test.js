const assert = require('node:assert/strict');
const test = require('node:test');

const { createWebServer } = require('../server/web-server');

function createFakeManager() {
  const systemMessages = [];
  return {
    systemMessages,
    listSessions() {
      return [{ name: 'main', shell: 'powershell.exe', clients: 0 }];
    },
    readTranscript: async (name) => [{ session: name, direction: 'output', data: 'ready' }],
    write: async (name, input) => ({ name, input }),
    publishSystem: async (name, data) => {
      systemMessages.push({ name, data });
    }
  };
}

function createFakeConversationStore() {
  return {
    conversations: [
      {
        conversationId: 'direct-smoke',
        agent: 'echo',
        turnCount: 1,
        lastPrompt: 'hello',
        lastReply: 'hello'
      }
    ],
    turns: [],
    getConversation: async (conversationId) => ({ conversationId, agentState: { opencodeSessionId: 'ses_1' } }),
    listConversations: async () => [
      {
        conversationId: 'direct-smoke',
        agent: 'echo',
        turnCount: 1,
        lastPrompt: 'hello',
        lastReply: 'hello'
      }
    ],
    readTurns: async (conversationId) => [
      {
        conversationId,
        turnId: 'turn-1',
        agent: 'echo',
        prompt: 'hello',
        reply: 'hello',
        status: 'completed'
      }
    ],
    appendTurn: async (turn) => {
      const stored = { ...turn, turnId: 'turn-2', createdAt: '2026-06-14T01:00:00.000Z' };
      return stored;
    },
    updateTurn: async (conversationId, turnId, updates) => {
      const stored = {
        conversationId,
        turnId,
        agent: 'opencode',
        prompt: 'hello',
        ...updates,
        createdAt: '2026-06-14T01:00:00.000Z',
        completedAt: '2026-06-14T01:00:01.000Z'
      };
      return stored;
    }
  };
}

function createFakeAgentAdapter() {
  return {
    calls: [],
    listAgents() {
      return [
        { name: 'echo', label: 'Echo', mode: 'echo' },
        { name: 'opencode', label: 'opencode', mode: 'command', command: 'opencode' }
      ];
    },
    async runTurn(agent, input) {
      this.calls.push({ agent, input });
      return {
        agent,
        reply: `reply:${input.prompt}`,
        status: 'completed',
        raw: { mode: 'test' },
        agentState: { opencodeSessionId: 'ses_2' }
      };
    }
  };
}

test('GET /api/profiles returns configured CLI profiles', async () => {
  const { server } = createWebServer({
    sessionManager: createFakeManager(),
    config: {
      token: 'secret',
      publicDir: process.cwd(),
      profiles: {
        main: { label: 'PowerShell', command: 'powershell.exe', args: [] },
        opencode: { label: 'opencode', command: 'powershell.exe', args: ['-Command', 'opencode'] }
      }
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/profiles`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.profiles.map((profile) => profile.name), ['main', 'opencode']);
    assert.equal(body.profiles[0].label, 'PowerShell');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/sessions returns available sessions', async () => {
  const { server } = createWebServer({
    sessionManager: createFakeManager(),
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.sessions[0].name, 'main');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/sessions/:name/input rejects missing token', async () => {
  const { server } = createWebServer({
    sessionManager: createFakeManager(),
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/main/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'whoami\r' })
    });
    assert.equal(response.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/sessions/:name/input accepts authorized input', async () => {
  let written = null;
  const manager = createFakeManager();
  manager.write = async (name, input) => {
    written = { name, input };
  };
  const { server } = createWebServer({
    sessionManager: manager,
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/main/input`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ input: 'whoami\r' })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(written, { name: 'main', input: 'whoami\r' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/agents returns direct conversation agents', async () => {
  const { server } = createWebServer({
    sessionManager: createFakeManager(),
    conversationStore: createFakeConversationStore(),
    agentAdapter: createFakeAgentAdapter(),
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/agents`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.agents.map((agent) => agent.name), ['echo', 'opencode']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/conversations and /api/conversations/:id/turns expose clean history', async () => {
  const { server } = createWebServer({
    sessionManager: createFakeManager(),
    conversationStore: createFakeConversationStore(),
    agentAdapter: createFakeAgentAdapter(),
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const conversationsResponse = await fetch(`http://127.0.0.1:${port}/api/conversations`);
    const conversationsBody = await conversationsResponse.json();
    assert.equal(conversationsResponse.status, 200);
    assert.equal(conversationsBody.conversations[0].conversationId, 'direct-smoke');

    const turnsResponse = await fetch(`http://127.0.0.1:${port}/api/conversations/direct-smoke/turns`);
    const turnsBody = await turnsResponse.json();
    assert.equal(turnsResponse.status, 200);
    assert.equal(turnsBody.turns[0].reply, 'hello');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/agents/:agent/turns rejects missing token', async () => {
  const { server } = createWebServer({
    sessionManager: createFakeManager(),
    conversationStore: createFakeConversationStore(),
    agentAdapter: createFakeAgentAdapter(),
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/agents/echo/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'direct-smoke', prompt: 'hello' })
    });
    assert.equal(response.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/agents/:agent/turns runs agent and stores structured turn', async () => {
  const agentAdapter = createFakeAgentAdapter();
  const conversationStore = createFakeConversationStore();
  const manager = createFakeManager();
  let stored = null;
  let updated = null;
  conversationStore.appendTurn = async (turn) => {
    stored = turn;
    return { ...turn, turnId: 'turn-2', createdAt: '2026-06-14T01:00:00.000Z', completedAt: null };
  };
  conversationStore.updateTurn = async (conversationId, turnId, updates) => {
    updated = { conversationId, turnId, ...updates };
    return {
      ...stored,
      ...updates,
      conversationId,
      turnId,
      createdAt: '2026-06-14T01:00:00.000Z',
      completedAt: '2026-06-14T01:00:01.000Z'
    };
  };

  const { server } = createWebServer({
    sessionManager: manager,
    conversationStore,
    agentAdapter,
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/agents/opencode/turns`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ conversationId: 'direct-smoke', prompt: 'hello' })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.turn.reply, 'reply:hello');
    assert.equal(stored.conversationId, 'direct-smoke');
    assert.equal(stored.agent, 'opencode');
    assert.equal(stored.status, 'running');
    assert.equal(updated.status, 'completed');
    assert.deepEqual(updated.agentState, { opencodeSessionId: 'ses_2' });
    assert.equal(agentAdapter.calls[0].input.conversation.agentState.opencodeSessionId, 'ses_1');
    assert.equal(manager.systemMessages.length, 2);
    assert.equal(manager.systemMessages[0].name, 'main');
    assert.match(manager.systemMessages[0].data, /\[opencode running\] turn-2/);
    assert.match(manager.systemMessages[1].data, /\[opencode completed\] turn-2/);
    assert.match(manager.systemMessages[1].data, /reply:hello/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/agents/:agent/turns exposes a running turn while agent is still working', async () => {
  const turns = [];
  const conversationStore = {
    getConversation: async (conversationId) => ({ conversationId, agentState: { opencodeSessionId: 'ses_1' } }),
    listConversations: async () => [],
    readTurns: async () => turns,
    appendTurn: async (turn) => {
      const stored = {
        ...turn,
        turnId: 'turn-running',
        createdAt: '2026-06-14T01:00:00.000Z',
        completedAt: null
      };
      turns.push(stored);
      return stored;
    },
    updateTurn: async (conversationId, turnId, updates) => {
      const index = turns.findIndex((turn) => turn.turnId === turnId);
      const stored = {
        ...turns[index],
        ...updates,
        conversationId,
        turnId,
        completedAt: '2026-06-14T01:00:05.000Z'
      };
      turns[index] = stored;
      return stored;
    }
  };
  const agentAdapter = {
    listAgents: () => [{ name: 'opencode', label: 'opencode', mode: 'command', command: 'opencode' }],
    runTurn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        agent: 'opencode',
        reply: 'done',
        status: 'completed',
        raw: { mode: 'test' },
        agentState: { opencodeSessionId: 'ses_2' }
      };
    }
  };
  const manager = createFakeManager();

  const { server } = createWebServer({
    sessionManager: manager,
    conversationStore,
    agentAdapter,
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const postPromise = fetch(`http://127.0.0.1:${port}/api/agents/opencode/turns`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ conversationId: 'direct-running', prompt: 'hello' })
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const runningResponse = await fetch(`http://127.0.0.1:${port}/api/conversations/direct-running/turns`);
    const runningBody = await runningResponse.json();
    assert.equal(runningBody.turns[0].status, 'running');
    assert.equal(runningBody.turns[0].reply, '');
    assert.equal(manager.systemMessages.length, 1);
    assert.match(manager.systemMessages[0].data, /\[opencode running\] turn-running/);

    const completedResponse = await postPromise;
    const completedBody = await completedResponse.json();
    assert.equal(completedBody.turn.status, 'completed');
    assert.equal(completedBody.turn.reply, 'done');
    assert.equal(turns[0].status, 'completed');
    assert.equal(manager.systemMessages.length, 2);
    assert.match(manager.systemMessages[1].data, /\[opencode completed\] turn-running/);
    assert.match(manager.systemMessages[1].data, /done/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
