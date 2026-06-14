const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const WebSocket = require('ws');

const { createWebServer, parseGitStatusChangedFiles } = require('../server/web-server');
const { TeamStore } = require('../server/team-store');

function createFakeManager() {
  const systemMessages = [];
  const createdAgentSessions = [];
  return {
    systemMessages,
    createdAgentSessions,
    listSessions() {
      return [
        { name: 'main', shell: 'powershell.exe', clients: 0 },
        ...createdAgentSessions.map((session) => ({
          name: session.name,
          profileName: session.profileName,
          command: `profile:${session.profileName}`,
          cwd: 'test-cwd',
          clients: 0
        }))
      ];
    },
    getOrCreateWithProfile: (name, profileName) => {
      createdAgentSessions.push({ name, profileName });
      return { name, profileName };
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

test('parseGitStatusChangedFiles preserves filenames after porcelain status columns', () => {
  assert.deepEqual(parseGitStatusChangedFiles(' M README.md\r\n?? docs/phase2.md\r\n'), [
    'README.md',
    'docs/phase2.md'
  ]);
});

function createFakeTeamStore() {
  const roster = [];
  const messages = [];
  const tasks = [];
  return {
    roster,
    messages,
    tasks,
    listAgentProfiles: async () => [
      { profileId: 'opencode', label: 'opencode', kind: 'direct', enabled: true },
      { profileId: 'claude', label: 'Claude Code', kind: 'direct', enabled: true }
    ],
    addAgentProfile: async (profile) => ({ enabled: true, ...profile }),
    listRoster: async () => roster,
    addRosterAgent: async (input) => {
      const agent = {
        agentId: input.agentId || `${input.profileId}${roster.length + 1}`,
        profileId: input.profileId,
        role: roster.some((item) => item.role === 'leader') ? (input.role || 'worker') : 'leader',
        status: 'idle'
      };
      roster.push(agent);
      return agent;
    },
    setLeader: async (agentId) => {
      roster.forEach((agent) => {
        agent.role = agent.agentId === agentId ? 'leader' : 'worker';
      });
      return roster.find((agent) => agent.agentId === agentId);
    },
    removeRosterAgent: async (agentId) => {
      const agent = roster.find((item) => item.agentId === agentId);
      agent.status = 'removed';
      return agent;
    },
    createTask: async (input) => {
      const task = {
        taskId: 'task-api-1',
        status: 'queued',
        leaderAgentId: roster.find((agent) => agent.role === 'leader')?.agentId || null,
        ...input
      };
      tasks.push(task);
      return task;
    },
    listTasks: async () => tasks,
    getTask: async (taskId) => tasks.find((task) => task.taskId === taskId) || null,
    getContext: async () => ({ roster, activeTasks: tasks }),
    sendMessage: async (input) => {
      const message = { messageId: 'message-api-1', status: 'pending', ...input };
      messages.push(message);
      return message;
    },
    listMessages: async () => messages,
    markMessageRead: async (messageId) => {
      const message = messages.find((item) => item.messageId === messageId);
      message.status = 'read';
      return message;
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

test('team APIs expose roster lifecycle, @team tasks, and messages', async () => {
  const teamStore = createFakeTeamStore();
  const manager = createFakeManager();
  const { server } = createWebServer({
    sessionManager: manager,
    teamStore,
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    const addFirst = await fetch(`${base}/api/team/roster/agents`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'opencode', agentId: 'opencode1' })
    });
    assert.equal(addFirst.status, 200);
    const addSecond = await fetch(`${base}/api/team/roster/agents`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'opencode', agentId: 'opencode2' })
    });
    assert.equal(addSecond.status, 200);
    assert.deepEqual(manager.createdAgentSessions, [
      { name: 'opencode1', profileName: 'opencode' },
      { name: 'opencode2', profileName: 'opencode' }
    ]);

    const rosterResponse = await fetch(`${base}/api/team/roster`);
    const rosterBody = await rosterResponse.json();
    assert.deepEqual(rosterBody.roster.map((agent) => agent.agentId), ['opencode1', 'opencode2']);
    assert.equal(rosterBody.roster[0].role, 'leader');

    const taskResponse = await fetch(`${base}/api/team/tasks`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Parser team task',
        prompt: '@team split work and ask @opencode2 to test',
        assignedTo: '@team',
        createdBy: 'codex'
      })
    });
    const taskBody = await taskResponse.json();
    assert.equal(taskResponse.status, 200);
    assert.equal(taskBody.task.leaderAgentId, 'opencode1');
    assert.equal(taskBody.task.assignedTo, '@team');
    assert.match(manager.systemMessages.at(-1).data, /\[team queued\] task-api-1/);

    const messageResponse = await fetch(`${base}/api/team/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'codex', to: '@leader', body: '@leader check the final delivery' })
    });
    const messageBody = await messageResponse.json();
    assert.equal(messageResponse.status, 200);
    assert.equal(messageBody.message.to, '@leader');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('team workspace API ensures isolated agent worktrees and updates roster state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-api-'));
  const projectRoot = 'X:\\workspace\\project';
  const calls = [];
  const teamStore = new TeamStore(root, {
    context: {
      workspace: {
        projectRoot,
        cwd: projectRoot
      }
    },
    profiles: {
      researcher: { label: 'Researcher', mode: 'command', worktreeMode: 'isolated' }
    }
  });
  const manager = createFakeManager();
  const worktreeProvider = {
    ensure: async (input) => {
      calls.push(input);
      return {
        path: input.path,
        branch: input.branch,
        status: 'ready',
        head: 'abc1234'
      };
    }
  };
  const { server } = createWebServer({
    sessionManager: manager,
    teamStore,
    worktreeProvider,
    config: { token: 'secret', publicDir: process.cwd(), cwd: projectRoot }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    await teamStore.addRosterAgent({ profileId: 'researcher', agentId: 'researcher1' });

    const response = await fetch(`${base}/api/team/roster/agents/researcher1/workspace/ensure`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    const body = await response.json();
    const roster = await teamStore.listRoster();

    assert.equal(response.status, 200);
    assert.equal(body.agent.workspace.status, 'ready');
    assert.equal(body.agent.workspace.head, 'abc1234');
    assert.deepEqual(calls.map((call) => ({
      cwd: call.cwd,
      path: call.path,
      branch: call.branch,
      agentId: call.agent.agentId
    })), [{
      cwd: projectRoot,
      path: path.join(projectRoot, '.worktrees', 'researcher1'),
      branch: 'shareterminal/researcher1',
      agentId: 'researcher1'
    }]);
    assert.equal(roster[0].workspace.status, 'ready');
    assert.equal(roster[0].workspace.head, 'abc1234');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('team workspace API reads isolated worktree status and removes it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-api-'));
  const projectRoot = 'X:\\workspace\\project';
  const calls = [];
  const teamStore = new TeamStore(root, {
    context: {
      workspace: {
        projectRoot,
        cwd: projectRoot
      }
    },
    profiles: {
      researcher: { label: 'Researcher', mode: 'command', worktreeMode: 'isolated' }
    }
  });
  const manager = createFakeManager();
  const worktreeProvider = {
    status: async (input) => {
      calls.push({ type: 'status', ...input });
      return {
        path: input.path,
        branch: input.branch,
        status: 'ready',
        head: 'abc1234',
        dirty: true,
        changedFiles: ['README.md']
      };
    },
    remove: async (input) => {
      calls.push({ type: 'remove', ...input });
      return {
        path: input.path,
        branch: input.branch,
        status: 'removed'
      };
    }
  };
  const { server } = createWebServer({
    sessionManager: manager,
    teamStore,
    worktreeProvider,
    config: { token: 'secret', publicDir: process.cwd(), cwd: projectRoot }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    await teamStore.addRosterAgent({ profileId: 'researcher', agentId: 'researcher1' });

    const statusResponse = await fetch(`${base}/api/team/roster/agents/researcher1/workspace/status`);
    const statusBody = await statusResponse.json();
    assert.equal(statusResponse.status, 200);
    assert.equal(statusBody.agent.workspace.status, 'ready');
    assert.equal(statusBody.agent.workspace.dirty, true);
    assert.deepEqual(statusBody.agent.workspace.changedFiles, ['README.md']);

    const removeResponse = await fetch(`${base}/api/team/roster/agents/researcher1/workspace/remove`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    const removeBody = await removeResponse.json();
    const roster = await teamStore.listRoster();

    assert.equal(removeResponse.status, 200);
    assert.equal(removeBody.agent.workspace.status, 'removed');
    assert.equal(roster[0].workspace.status, 'removed');
    assert.deepEqual(calls.map((call) => [call.type, call.cwd, call.path, call.branch]), [
      ['status', projectRoot, path.join(projectRoot, '.worktrees', 'researcher1'), 'shareterminal/researcher1'],
      ['remove', projectRoot, path.join(projectRoot, '.worktrees', 'researcher1'), 'shareterminal/researcher1']
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('team dispatch API runs the assigned direct agent and exposes trace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-api-'));
  const teamStore = new TeamStore(root, {
    profiles: {
      echo: { label: 'Echo', mode: 'echo' }
    },
    taskIdFactory: () => 'task-dispatch-1',
    messageIdFactory: (() => {
      let index = 0;
      return () => `message-dispatch-${++index}`;
    })()
  });
  const manager = createFakeManager();
  const agentAdapter = createFakeAgentAdapter();
  const { server } = createWebServer({
    sessionManager: manager,
    teamStore,
    agentAdapter,
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    await teamStore.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    const task = await teamStore.createTask({
      title: 'Dispatch through echo',
      prompt: '@leader produce a checked answer',
      createdBy: 'codex',
      assignedTo: '@leader'
    });

    const dispatchResponse = await fetch(`${base}/api/team/tasks/${task.taskId}/dispatch`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ terminalSession: 'main' })
    });
    const dispatchBody = await dispatchResponse.json();
    assert.equal(dispatchResponse.status, 200);
    assert.equal(dispatchBody.task.status, 'completed');
    assert.equal(dispatchBody.task.result, 'reply:@leader produce a checked answer');
    assert.equal(agentAdapter.calls[0].agent, 'echo');
    assert.equal(agentAdapter.calls[0].input.prompt, '@leader produce a checked answer');
    assert.match(manager.systemMessages.at(-1).data, /\[team completed\] task-dispatch-1/);

    const traceResponse = await fetch(`${base}/api/team/trace/${task.taskId}`);
    const traceBody = await traceResponse.json();
    assert.equal(traceResponse.status, 200);
    assert.deepEqual(traceBody.trace.events.map((event) => event.type).slice(-2), [
      'task.running',
      'task.completed'
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('team inbox API exposes completed results and supports ack', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-api-'));
  const teamStore = new TeamStore(root, {
    profiles: {
      echo: { label: 'Echo', mode: 'echo' }
    },
    taskIdFactory: () => 'task-inbox-1',
    messageIdFactory: (() => {
      let index = 0;
      return () => `message-inbox-${++index}`;
    })(),
    inboxIdFactory: () => 'inbox-api-1'
  });
  const manager = createFakeManager();
  const agentAdapter = createFakeAgentAdapter();
  const { server } = createWebServer({
    sessionManager: manager,
    teamStore,
    agentAdapter,
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    await teamStore.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    const task = await teamStore.createTask({
      title: 'Inbox through echo',
      prompt: '@leader produce an inbox result',
      createdBy: 'codex',
      assignedTo: '@leader'
    });

    await fetch(`${base}/api/team/tasks/${task.taskId}/dispatch`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ terminalSession: 'main' })
    });

    const inboxResponse = await fetch(`${base}/api/team/inbox`);
    const inboxBody = await inboxResponse.json();
    assert.equal(inboxResponse.status, 200);
    assert.equal(inboxBody.items.length, 1);
    assert.equal(inboxBody.items[0].inboxId, 'inbox-api-1');
    assert.equal(inboxBody.items[0].taskId, task.taskId);
    assert.equal(inboxBody.items[0].status, 'unread');

    const ackResponse = await fetch(`${base}/api/team/inbox/inbox-api-1/ack`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ ackedBy: 'user' })
    });
    const ackBody = await ackResponse.json();
    assert.equal(ackResponse.status, 200);
    assert.equal(ackBody.item.status, 'acked');
    assert.equal(ackBody.item.ackedBy, 'user');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('team task API cancels queued work and creates retry tasks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-api-'));
  let taskIndex = 0;
  const teamStore = new TeamStore(root, {
    profiles: {
      echo: { label: 'Echo', mode: 'echo' }
    },
    taskIdFactory: () => `task-recover-${++taskIndex}`,
    messageIdFactory: (() => {
      let index = 0;
      return () => `message-recover-${++index}`;
    })()
  });
  const manager = createFakeManager();
  const { server } = createWebServer({
    sessionManager: manager,
    teamStore,
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    await teamStore.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    const task = await teamStore.createTask({
      title: 'Retry through API',
      prompt: '@leader do work later',
      createdBy: 'codex',
      assignedTo: '@leader'
    });

    const cancelResponse = await fetch(`${base}/api/team/tasks/${task.taskId}/cancel`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'echo1', reason: 'user stopped the task' })
    });
    const cancelBody = await cancelResponse.json();
    assert.equal(cancelResponse.status, 200);
    assert.equal(cancelBody.task.status, 'cancelled');

    const retryResponse = await fetch(`${base}/api/team/tasks/${task.taskId}/retry`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ createdBy: 'codex', reason: 'retry after cancellation' })
    });
    const retryBody = await retryResponse.json();
    assert.equal(retryResponse.status, 200);
    assert.equal(retryBody.task.taskId, 'task-recover-2');
    assert.equal(retryBody.task.retryOf, task.taskId);
    assert.equal(retryBody.task.status, 'queued');

    const traceResponse = await fetch(`${base}/api/team/trace/${task.taskId}`);
    const traceBody = await traceResponse.json();
    assert.equal(traceResponse.status, 200);
    assert.deepEqual(traceBody.trace.events.map((event) => event.type).slice(-2), [
      'task.cancelled',
      'task.retry.created'
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('team task API pauses for user input and resumes queued work', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-api-'));
  let taskIndex = 0;
  const teamStore = new TeamStore(root, {
    profiles: {
      echo: { label: 'Echo', mode: 'echo' }
    },
    taskIdFactory: () => `task-user-api-${++taskIndex}`,
    messageIdFactory: () => `message-user-api-${taskIndex}`,
    inboxIdFactory: () => 'inbox-user-api-1'
  });
  const manager = createFakeManager();
  const { server } = createWebServer({
    sessionManager: manager,
    teamStore,
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    await teamStore.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    const task = await teamStore.createTask({
      title: 'Needs user API',
      prompt: '@leader ask before continuing',
      createdBy: 'codex',
      assignedTo: '@leader'
    });
    await teamStore.claimTask(task.taskId, { agentId: 'echo1', leaseMs: 60000 });

    const pauseResponse = await fetch(`${base}/api/team/tasks/${task.taskId}/needs-user`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'echo1',
        question: 'Should this continue?',
        reason: 'needs approval',
        terminalSession: 'main'
      })
    });
    const pauseBody = await pauseResponse.json();
    assert.equal(pauseResponse.status, 200);
    assert.equal(pauseBody.task.status, 'needs_user');

    const inboxResponse = await fetch(`${base}/api/team/inbox`);
    const inboxBody = await inboxResponse.json();
    assert.equal(inboxBody.items[0].type, 'user_request');
    assert.equal(inboxBody.items[0].summary, 'Should this continue?');
    assert.match(manager.systemMessages.at(-1).data, /\[team needs_user\] task-user-api-1/);

    const resumeResponse = await fetch(`${base}/api/team/tasks/${task.taskId}/resume`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        resumedBy: 'user',
        answer: 'Continue with constraints.',
        terminalSession: 'main'
      })
    });
    const resumeBody = await resumeResponse.json();
    assert.equal(resumeResponse.status, 200);
    assert.equal(resumeBody.task.status, 'queued');
    assert.equal(resumeBody.task.userResponse.answer, 'Continue with constraints.');
    assert.match(manager.systemMessages.at(-1).data, /\[team queued\] task-user-api-1/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('team agent inbox API returns messages, assigned tasks, and context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-api-'));
  let taskIndex = 0;
  const teamStore = new TeamStore(root, {
    profiles: {
      echo: { label: 'Echo', mode: 'echo' }
    },
    taskIdFactory: () => `task-agent-inbox-${++taskIndex}`,
    messageIdFactory: (() => {
      let index = 0;
      return () => `message-agent-inbox-${++index}`;
    })()
  });
  const manager = createFakeManager();
  const { server } = createWebServer({
    sessionManager: manager,
    teamStore,
    gitProvider: async () => ({
      available: true,
      branch: 'phase2',
      commit: 'abc1234',
      dirty: true,
      changedFiles: ['server/web-server.js']
    }),
    config: {
      token: 'secret',
      publicDir: process.cwd(),
      rootDir: 'X:\\shareterminal',
      cwd: 'X:\\workspace\\project',
      shell: 'powershell.exe'
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    await teamStore.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    await teamStore.addRosterAgent({ profileId: 'echo', agentId: 'echo2' });
    const task = await teamStore.createTask({
      title: 'External agent inbox',
      prompt: '@echo2 inspect via inbox',
      createdBy: 'codex',
      assignedTo: 'echo2'
    });
    await teamStore.requestUserInput(task.taskId, {
      agentId: 'echo2',
      question: 'Please provide the missing input.'
    });

    const inboxResponse = await fetch(`${base}/api/team/agents/echo2/inbox`);
    const inboxBody = await inboxResponse.json();
    assert.equal(inboxResponse.status, 200);
    assert.equal(inboxBody.inbox.agent.agentId, 'echo2');
    assert.deepEqual(inboxBody.inbox.tasks.map((item) => item.taskId), [task.taskId]);
    assert.deepEqual(inboxBody.inbox.items.map((item) => item.type), ['user_request']);
    assert.equal(inboxBody.inbox.items[0].summary, 'Please provide the missing input.');
    assert.equal(inboxBody.inbox.messages[0].to, 'echo2');
    assert.equal(inboxBody.inbox.context.leader.agentId, 'echo1');
    assert.equal(inboxBody.inbox.context.workspace.cwd, 'X:\\workspace\\project');
    assert.equal(inboxBody.inbox.context.runtime.shell, 'powershell.exe');
    assert.deepEqual(inboxBody.inbox.context.git, {
      available: true,
      branch: 'phase2',
      commit: 'abc1234',
      dirty: true,
      changedFiles: ['server/web-server.js']
    });
    assert.deepEqual(inboxBody.inbox.context.terminalSessions.map((session) => session.name), ['main', 'echo2']);
    assert.equal(inboxBody.inbox.terminal.session, 'echo2');
    assert.equal(inboxBody.inbox.terminal.profileId, 'echo');
    assert.deepEqual(manager.createdAgentSessions, [{ name: 'echo2', profileName: 'echo' }]);
    assert.equal(inboxBody.inbox.terminal.activeSession.name, 'echo2');
    assert.equal(inboxBody.inbox.terminal.activeSession.cwd, 'test-cwd');
    assert.equal(inboxBody.inbox.terminal.recentTranscript[0].data, 'ready');

    const contextResponse = await fetch(`${base}/api/team/context`);
    const contextBody = await contextResponse.json();
    assert.equal(contextResponse.status, 200);
    assert.equal(contextBody.context.git.branch, 'phase2');
    assert.equal(contextBody.context.git.dirty, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('team claim API supports agent heartbeat and stale recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-api-'));
  const clockValues = [
    '2026-06-14T03:00:00.000Z',
    '2026-06-14T03:00:01.000Z',
    '2026-06-14T03:00:02.000Z',
    '2026-06-14T03:00:03.000Z',
    '2026-06-14T03:00:04.000Z',
    '2026-06-14T03:00:05.000Z',
    '2026-06-14T03:00:06.000Z',
    '2026-06-14T03:00:07.000Z',
    '2026-06-14T03:00:08.000Z',
    '2026-06-14T03:10:00.000Z',
    '2026-06-14T03:10:01.000Z',
    '2026-06-14T03:10:02.000Z',
    '2026-06-14T03:10:03.000Z',
    '2026-06-14T03:12:00.000Z',
    '2026-06-14T03:12:01.000Z',
    '2026-06-14T03:12:02.000Z',
    '2026-06-14T03:12:03.000Z'
  ];
  const teamStore = new TeamStore(root, {
    now: () => clockValues.shift() || '2026-06-14T03:10:59.000Z',
    profiles: {
      echo: { label: 'Echo', mode: 'echo' }
    },
    taskIdFactory: () => 'task-claim-api-1',
    messageIdFactory: () => 'message-claim-api-1'
  });
  const manager = createFakeManager();
  const { server } = createWebServer({
    sessionManager: manager,
    teamStore,
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    await teamStore.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    const task = await teamStore.createTask({
      title: 'Claim API task',
      prompt: '@leader claim through API',
      createdBy: 'codex',
      assignedTo: '@leader'
    });

    const claimResponse = await fetch(`${base}/api/team/tasks/${task.taskId}/claim`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'echo1', mode: 'external', leaseMs: 60000 })
    });
    const claimBody = await claimResponse.json();
    assert.equal(claimResponse.status, 200);
    assert.equal(claimBody.task.status, 'running');
    assert.equal(claimBody.task.claimedBy, 'echo1');

    const heartbeatResponse = await fetch(`${base}/api/team/tasks/${task.taskId}/heartbeat`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'echo1', leaseMs: 60000, note: 'still active' })
    });
    const heartbeatBody = await heartbeatResponse.json();
    assert.equal(heartbeatResponse.status, 200);
    assert.equal(heartbeatBody.task.leaseExpiresAt, '2026-06-14T03:11:00.000Z');

    const recoverResponse = await fetch(`${base}/api/team/tasks/recover-stale`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ staleBefore: '2026-06-14T03:12:00.000Z', reason: 'lease expired' })
    });
    const recoverBody = await recoverResponse.json();
    assert.equal(recoverResponse.status, 200);
    assert.equal(recoverBody.tasks.length, 1);
    assert.equal(recoverBody.tasks[0].status, 'queued');
    assert.equal(recoverBody.tasks[0].error, 'lease expired');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('team claimed task API accepts claimant completion and leader handoff', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-api-'));
  let taskIndex = 0;
  let messageIndex = 0;
  const teamStore = new TeamStore(root, {
    profiles: {
      echo: { label: 'Echo', mode: 'echo' }
    },
    taskIdFactory: () => `task-submit-api-${++taskIndex}`,
    messageIdFactory: () => `message-submit-api-${++messageIndex}`,
    inboxIdFactory: () => 'inbox-submit-api-1'
  });
  const manager = createFakeManager();
  const { server } = createWebServer({
    sessionManager: manager,
    teamStore,
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    await teamStore.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    await teamStore.addRosterAgent({ profileId: 'echo', agentId: 'echo2' });
    const task = await teamStore.createTask({
      title: 'API submit task',
      prompt: '@echo2 return result through API',
      createdBy: 'echo1',
      assignedTo: 'echo2',
      leaderAgentId: 'echo1'
    });
    await teamStore.claimTask(task.taskId, { agentId: 'echo2', leaseMs: 60000 });

    const completeResponse = await fetch(`${base}/api/team/tasks/${task.taskId}/complete`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'echo2', result: 'api worker result', turnId: 'turn-api-submit' })
    });
    const completeBody = await completeResponse.json();
    assert.equal(completeResponse.status, 200);
    assert.equal(completeBody.task.status, 'completed');
    assert.equal(completeBody.task.result, 'api worker result');

    const inboxResponse = await fetch(`${base}/api/team/inbox`);
    const inboxBody = await inboxResponse.json();
    assert.equal(inboxBody.items[0].taskId, task.taskId);

    const leaderInboxResponse = await fetch(`${base}/api/team/agents/echo1/inbox`);
    const leaderInboxBody = await leaderInboxResponse.json();
    assert.match(leaderInboxBody.inbox.messages.at(-1).body, /api worker result/);
    assert.match(manager.systemMessages.at(-1).data, /\[team completed\] task-submit-api-1/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('team claimed task API records claimant failure for retry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-api-'));
  let taskIndex = 0;
  const teamStore = new TeamStore(root, {
    profiles: {
      echo: { label: 'Echo', mode: 'echo' }
    },
    taskIdFactory: () => `task-fail-api-${++taskIndex}`,
    messageIdFactory: () => `message-fail-api-${taskIndex}`,
    inboxIdFactory: () => 'inbox-fail-api-1'
  });
  const manager = createFakeManager();
  const { server } = createWebServer({
    sessionManager: manager,
    teamStore,
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    await teamStore.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    await teamStore.addRosterAgent({ profileId: 'echo', agentId: 'echo2' });
    const task = await teamStore.createTask({
      title: 'API fail task',
      prompt: '@echo2 fail through API',
      createdBy: 'echo1',
      assignedTo: 'echo2',
      leaderAgentId: 'echo1'
    });
    await teamStore.claimTask(task.taskId, { agentId: 'echo2', leaseMs: 60000 });

    const failResponse = await fetch(`${base}/api/team/tasks/${task.taskId}/fail`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'echo2', error: 'api worker failure' })
    });
    const failBody = await failResponse.json();
    assert.equal(failResponse.status, 200);
    assert.equal(failBody.task.status, 'failed');
    assert.equal(failBody.task.error, 'api worker failure');

    const inboxResponse = await fetch(`${base}/api/team/inbox`);
    const inboxBody = await inboxResponse.json();
    assert.equal(inboxBody.items[0].type, 'task_failure');
    assert.equal(inboxBody.items[0].summary, 'api worker failure');
    assert.match(manager.systemMessages.at(-1).data, /\[team failed\] task-fail-api-1/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('team WebSocket sessions use roster profile even before roster API is read', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-api-'));
  const teamStore = new TeamStore(root, {
    profiles: {
      opencode: { label: 'opencode', mode: 'command' }
    }
  });
  const createdAgentSessions = [];
  const subscriptions = [];
  const manager = {
    listSessions: () => [],
    getOrCreateWithProfile: (name, profileName) => {
      createdAgentSessions.push({ name, profileName });
      return { name, profileName };
    },
    subscribe: (name) => {
      subscriptions.push(name);
      return () => {};
    },
    write: async () => {},
    resize: () => {},
    readTranscript: async () => [],
    publishSystem: async () => {}
  };
  const { server } = createWebServer({
    sessionManager: manager,
    teamStore,
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await teamStore.addRosterAgent({ profileId: 'opencode', agentId: 'opencode1' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?session=opencode1`);
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket ready timeout')), 1000);
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'ready') {
          clearTimeout(timeout);
          resolve(message);
        }
      });
      socket.on('error', reject);
    });
    socket.close();

    assert.equal(ready.session, 'opencode1');
    assert.deepEqual(createdAgentSessions, [{ name: 'opencode1', profileName: 'opencode' }]);
    assert.deepEqual(subscriptions, ['opencode1']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('team dispatch marks failed agent runs as retryable inbox items', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-api-'));
  const teamStore = new TeamStore(root, {
    profiles: {
      echo: { label: 'Echo', mode: 'echo' }
    },
    taskIdFactory: () => 'task-failure-1',
    messageIdFactory: (() => {
      let index = 0;
      return () => `message-failure-${++index}`;
    })(),
    inboxIdFactory: () => 'inbox-failure-1'
  });
  const manager = createFakeManager();
  const agentAdapter = {
    listAgents: () => [{ name: 'echo', label: 'Echo', mode: 'echo' }],
    runTurn: async () => {
      throw new Error('adapter exploded');
    }
  };
  const { server } = createWebServer({
    sessionManager: manager,
    teamStore,
    agentAdapter,
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    await teamStore.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    const task = await teamStore.createTask({
      title: 'Fail through echo',
      prompt: '@leader fail and recover',
      createdBy: 'codex',
      assignedTo: '@leader'
    });

    const dispatchResponse = await fetch(`${base}/api/team/tasks/${task.taskId}/dispatch`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ terminalSession: 'main' })
    });
    const dispatchBody = await dispatchResponse.json();
    assert.equal(dispatchResponse.status, 500);
    assert.equal(dispatchBody.error, 'adapter exploded');

    const failedTask = await teamStore.getTask(task.taskId);
    assert.equal(failedTask.status, 'failed');
    assert.equal(failedTask.error, 'adapter exploded');

    const inboxResponse = await fetch(`${base}/api/team/inbox`);
    const inboxBody = await inboxResponse.json();
    assert.equal(inboxResponse.status, 200);
    assert.equal(inboxBody.items[0].type, 'task_failure');
    assert.equal(inboxBody.items[0].taskId, task.taskId);
    assert.equal(inboxBody.items[0].summary, 'adapter exploded');

    const traceResponse = await fetch(`${base}/api/team/trace/${task.taskId}`);
    const traceBody = await traceResponse.json();
    assert.deepEqual(traceBody.trace.events.map((event) => event.type).slice(-2), [
      'task.running',
      'task.failed'
    ]);
    assert.match(manager.systemMessages.at(-1).data, /\[team failed\] task-failure-1/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('team dispatch splits mentioned workers and returns leader final delivery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-api-'));
  let taskIndex = 0;
  const teamStore = new TeamStore(root, {
    profiles: {
      echo: { label: 'Echo', mode: 'echo' }
    },
    taskIdFactory: () => `task-team-${++taskIndex}`,
    messageIdFactory: (() => {
      let index = 0;
      return () => `message-team-${++index}`;
    })()
  });
  const manager = createFakeManager();
  const agentAdapter = createFakeAgentAdapter();
  const { server } = createWebServer({
    sessionManager: manager,
    teamStore,
    agentAdapter,
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    await teamStore.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    await teamStore.addRosterAgent({ profileId: 'echo', agentId: 'echo2' });
    const task = await teamStore.createTask({
      title: 'Team split delivery',
      prompt: '@team ask @echo2 to inspect the code, then produce one checked delivery',
      createdBy: 'codex',
      assignedTo: '@team'
    });

    const dispatchResponse = await fetch(`${base}/api/team/tasks/${task.taskId}/dispatch`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ terminalSession: 'main' })
    });
    const dispatchBody = await dispatchResponse.json();

    assert.equal(dispatchResponse.status, 200);
    assert.equal(dispatchBody.task.status, 'completed');
    assert.equal(dispatchBody.task.reviewedBy, 'echo1');
    assert.equal(dispatchBody.task.reviewStatus, 'checked');
    assert.match(dispatchBody.task.result, /Final delivery/);
    assert.match(dispatchBody.task.result, /echo2/);
    assert.deepEqual(agentAdapter.calls.map((call) => call.input.agent.agentId), ['echo2', 'echo1']);

    const traceResponse = await fetch(`${base}/api/team/trace/${task.taskId}`);
    const traceBody = await traceResponse.json();
    assert.equal(traceResponse.status, 200);
    assert.equal(traceBody.trace.tasks.length, 2);
    assert.deepEqual(traceBody.trace.events.map((event) => event.type).filter((type) => type === 'task.completed'), [
      'task.completed',
      'task.completed'
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('team dispatch splits profile mentions to concrete idle workers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-api-'));
  let taskIndex = 0;
  const teamStore = new TeamStore(root, {
    profiles: {
      echo: { label: 'Echo', mode: 'echo' }
    },
    taskIdFactory: () => `task-profile-team-${++taskIndex}`,
    messageIdFactory: (() => {
      let index = 0;
      return () => `message-profile-team-${++index}`;
    })()
  });
  const manager = createFakeManager();
  const agentAdapter = createFakeAgentAdapter();
  const { server } = createWebServer({
    sessionManager: manager,
    teamStore,
    agentAdapter,
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    await teamStore.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    await teamStore.addRosterAgent({ profileId: 'echo', agentId: 'echo2' });
    const task = await teamStore.createTask({
      title: 'Profile team split',
      prompt: '@team ask @echo to inspect the code, then produce one checked delivery',
      createdBy: 'codex',
      assignedTo: '@team'
    });

    const dispatchResponse = await fetch(`${base}/api/team/tasks/${task.taskId}/dispatch`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ terminalSession: 'main' })
    });
    const dispatchBody = await dispatchResponse.json();
    const storedTask = await teamStore.getTask(task.taskId);

    assert.equal(dispatchResponse.status, 200);
    assert.deepEqual(storedTask.mentionRoutes.map((route) => [route.mention, route.agentId]), [
      ['@echo', 'echo2']
    ]);
    assert.equal(dispatchBody.task.status, 'completed');
    assert.match(dispatchBody.task.result, /echo2/);
    assert.deepEqual(agentAdapter.calls.map((call) => call.input.agent.agentId), ['echo2', 'echo1']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
