const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { WebSocketServer } = require('ws');

function parseLimit(value) {
  const limit = Number.parseInt(value, 10);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 2000) : 200;
}

function requireToken(expectedToken) {
  return (request, response, next) => {
    const header = request.get('authorization') || '';
    if (header !== `Bearer ${expectedToken}`) {
      response.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    next();
  };
}

function sendVendorFile(rootDir, packagePath) {
  return (request, response) => {
    response.sendFile(path.join(rootDir, 'node_modules', ...packagePath));
  };
}

function publicProfiles(profiles = {}) {
  return Object.entries(profiles).map(([name, profile]) => ({
    name,
    label: profile.label || name,
    command: profile.command,
    args: profile.args || [],
    cwd: profile.cwd
  }));
}

function publicAgentProfiles(profiles = {}) {
  return Object.entries(profiles).map(([name, profile]) => ({
    name,
    label: profile.label || name,
    mode: profile.mode,
    command: profile.mode === 'command' ? profile.command : undefined
  }));
}

function requireConversationStore(conversationStore) {
  if (!conversationStore) {
    const error = new Error('conversation store is not configured');
    error.statusCode = 503;
    throw error;
  }
}

function requireAgentAdapter(agentAdapter) {
  if (!agentAdapter) {
    const error = new Error('agent adapter is not configured');
    error.statusCode = 503;
    throw error;
  }
}

function requireTeamStore(teamStore) {
  if (!teamStore) {
    const error = new Error('team store is not configured');
    error.statusCode = 503;
    throw error;
  }
}

function defaultConversationId(agentName) {
  return `${agentName}-${Date.now()}`;
}

function oneLine(value, limit) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function formatDirectTurnNotice(turn) {
  const status = turn.status || 'completed';
  const prompt = oneLine(turn.prompt, 180);
  const result = status === 'running'
    ? 'running...'
    : oneLine(turn.reply || turn.error, 700);
  return `\r\n[${turn.agent} ${status}] ${turn.turnId || ''}\r\n> ${prompt}\r\n${result}\r\n`;
}

function formatTeamTaskNotice(task) {
  const prompt = oneLine(task.prompt, 240);
  const leader = task.leaderAgentId ? ` leader=${task.leaderAgentId}` : '';
  return `\r\n[team ${task.status}] ${task.taskId || ''}${leader}\r\n> ${prompt}\r\n`;
}

async function publishDirectTurnNotice(sessionManager, sessionName, turn) {
  if (typeof sessionManager.publishSystem !== 'function') {
    return;
  }
  await sessionManager.publishSystem(sessionName || 'main', formatDirectTurnNotice(turn));
}

async function publishTeamTaskNotice(sessionManager, sessionName, task) {
  if (typeof sessionManager.publishSystem !== 'function') {
    return;
  }
  await sessionManager.publishSystem(sessionName || 'main', formatTeamTaskNotice(task));
}

async function resolveDispatchAgent(teamStore, task) {
  const roster = await teamStore.listRoster();
  let agentId = task.assignedTo;
  if (agentId === '@team' || agentId === '@leader') {
    agentId = task.leaderAgentId || (await teamStore.leaderAgent())?.agentId;
  } else if (typeof agentId === 'string' && agentId.startsWith('@')) {
    agentId = agentId.slice(1);
  }
  const agent = roster.find((item) => item.agentId === agentId && item.status !== 'removed');
  if (!agent) {
    throw new Error(`Unknown dispatch agent: ${agentId}`);
  }
  return agent;
}

function mentionedRosterAgents(task, roster) {
  const mentionIds = new Set((task.mentions || [])
    .map((mention) => mention.replace(/^@/, ''))
    .filter((mention) => mention && !['team', 'leader'].includes(mention)));
  for (const route of task.mentionRoutes || []) {
    if (route.agentId) {
      mentionIds.add(route.agentId);
    }
  }
  return roster.filter((agent) => mentionIds.has(agent.agentId) && agent.status !== 'removed');
}

async function runDirectTeamTask({ teamStore, agentAdapter, sessionManager, task, agent, terminalSession }) {
  const runningTask = await teamStore.startTask(task.taskId, {
    agentId: agent.agentId,
    mode: 'direct'
  });
  await publishTeamTaskNotice(sessionManager, terminalSession || agent.session || 'main', runningTask);
  try {
    const result = await agentAdapter.runTurn(agent.profileId, {
      prompt: task.prompt,
      conversation: null,
      task,
      agent
    });
    const completedTask = await teamStore.completeTask(task.taskId, {
      agentId: agent.agentId,
      result: result.reply || result.error || '',
      turnId: result.turnId || null
    });
    await publishTeamTaskNotice(sessionManager, terminalSession || agent.session || 'main', completedTask);
    return completedTask;
  } catch (error) {
    const failedTask = await teamStore.failTask(task.taskId, {
      agentId: agent.agentId,
      error: error.message
    });
    await publishTeamTaskNotice(sessionManager, terminalSession || agent.session || 'main', failedTask);
    throw error;
  }
}

async function dispatchSplitTeamTask({ teamStore, agentAdapter, sessionManager, task, leaderAgent, workerAgents, terminalSession }) {
  const runningParent = await teamStore.startTask(task.taskId, {
    agentId: leaderAgent.agentId,
    mode: 'team'
  });
  await publishTeamTaskNotice(sessionManager, terminalSession || leaderAgent.session || 'main', runningParent);

  const workerResults = [];
  for (const worker of workerAgents) {
    const childTask = await teamStore.createChildTask(task.taskId, {
      title: `${worker.agentId}: ${task.title}`,
      prompt: `Parent task ${task.taskId}\nAssigned agent: @${worker.agentId}\n\n${task.prompt}`,
      assignedTo: worker.agentId,
      createdBy: leaderAgent.agentId
    });
    const completedChild = await runDirectTeamTask({
      teamStore,
      agentAdapter,
      sessionManager,
      task: childTask,
      agent: worker,
      terminalSession: worker.session
    });
    workerResults.push({
      agentId: worker.agentId,
      taskId: childTask.taskId,
      result: completedChild.result || ''
    });
  }

  const finalPrompt = [
    `Final delivery for task ${task.taskId}.`,
    '',
    'Original request:',
    task.prompt,
    '',
    'Worker results:',
    ...workerResults.map((result) => `- @${result.agentId} (${result.taskId}): ${result.result}`),
    '',
    'Check the worker results against the original request and produce one concise final delivery.'
  ].join('\n');
  const leaderResult = await agentAdapter.runTurn(leaderAgent.profileId, {
    prompt: finalPrompt,
    conversation: null,
    task,
    agent: leaderAgent,
    workerResults
  });
  const completedParent = await teamStore.completeTask(task.taskId, {
    agentId: leaderAgent.agentId,
    result: leaderResult.reply || leaderResult.error || finalPrompt,
    turnId: leaderResult.turnId || null,
    reviewedBy: leaderAgent.agentId,
    reviewStatus: 'checked'
  });
  await publishTeamTaskNotice(sessionManager, terminalSession || leaderAgent.session || 'main', completedParent);
  return completedParent;
}

function createWebServer({ sessionManager, config, conversationStore, teamStore, agentAdapter }) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const rootDir = config.rootDir || path.resolve(__dirname, '..');

  app.use(express.json({ limit: '64kb' }));

  app.get('/vendor/xterm/xterm.css', sendVendorFile(rootDir, ['@xterm', 'xterm', 'css', 'xterm.css']));
  app.get('/vendor/xterm/xterm.js', sendVendorFile(rootDir, ['@xterm', 'xterm', 'lib', 'xterm.js']));
  app.get('/vendor/xterm/addon-fit.js', sendVendorFile(rootDir, ['@xterm', 'addon-fit', 'lib', 'addon-fit.js']));

  app.get('/api/sessions', (request, response) => {
    response.json({ sessions: sessionManager.listSessions() });
  });

  app.get('/api/profiles', (request, response) => {
    response.json({ profiles: publicProfiles(config.profiles) });
  });

  app.get('/api/agents', (request, response) => {
    const agents = agentAdapter?.listAgents
      ? agentAdapter.listAgents()
      : publicAgentProfiles(config.agentProfiles);
    response.json({ agents });
  });

  app.get('/api/team/agents', async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      response.json({ agents: await teamStore.listAgentProfiles() });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/team/agents', requireToken(config.token), async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const profile = await teamStore.addAgentProfile(request.body || {});
      response.json({ ok: true, profile });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/team/agents/:agentId/inbox', async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const inbox = await teamStore.agentInbox(request.params.agentId);
      const sessionName = inbox.agent.session || inbox.agent.agentId;
      if (typeof sessionManager.getOrCreateWithProfile === 'function') {
        sessionManager.getOrCreateWithProfile(sessionName, inbox.agent.profileId);
      }
      const sessions = typeof sessionManager.listSessions === 'function' ? sessionManager.listSessions() : [];
      const activeSession = sessions.find((item) => item.name === sessionName) || null;
      const recentTranscript = typeof sessionManager.readTranscript === 'function'
        ? await sessionManager.readTranscript(sessionName, parseLimit(request.query.transcriptLimit) || 20)
        : [];
      response.json({
        inbox: {
          ...inbox,
          terminal: {
            session: sessionName,
            profileId: inbox.agent.profileId,
            activeSession,
            recentTranscript
          }
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/team/roster', async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const roster = await teamStore.listRoster();
      if (typeof sessionManager.getOrCreateWithProfile === 'function') {
        roster
          .filter((agent) => agent.status !== 'removed')
          .forEach((agent) => sessionManager.getOrCreateWithProfile(agent.session || agent.agentId, agent.profileId));
      }
      response.json({ roster });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/team/roster/agents', requireToken(config.token), async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const agent = await teamStore.addRosterAgent(request.body || {});
      if (typeof sessionManager.getOrCreateWithProfile === 'function') {
        sessionManager.getOrCreateWithProfile(agent.session || agent.agentId, agent.profileId);
      }
      response.json({ ok: true, agent });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/team/roster/leader', requireToken(config.token), async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const agentId = request.body && request.body.agentId;
      const agent = await teamStore.setLeader(agentId);
      response.json({ ok: true, agent });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/team/roster/agents/:agentId/remove', requireToken(config.token), async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const agent = await teamStore.removeRosterAgent(request.params.agentId);
      response.json({ ok: true, agent });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/team/tasks', async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      response.json({ tasks: await teamStore.listTasks() });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/team/tasks/:taskId', async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const task = await teamStore.getTask(request.params.taskId);
      if (!task) {
        response.status(404).json({ ok: false, error: 'task not found' });
        return;
      }
      response.json({ task });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/team/tasks/recover-stale', requireToken(config.token), async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const tasks = await teamStore.recoverStaleTasks(request.body || {});
      response.json({ ok: true, tasks });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/team/tasks/:taskId/claim', requireToken(config.token), async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const task = await teamStore.claimTask(request.params.taskId, request.body || {});
      await publishTeamTaskNotice(sessionManager, request.body.terminalSession || request.body.session || task.claimedBy || 'main', task);
      response.json({ ok: true, task });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/team/tasks/:taskId/heartbeat', requireToken(config.token), async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const task = await teamStore.heartbeatTask(request.params.taskId, request.body || {});
      response.json({ ok: true, task });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/team/tasks/:taskId/complete', requireToken(config.token), async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const task = await teamStore.completeClaimedTask(request.params.taskId, request.body || {});
      await publishTeamTaskNotice(sessionManager, request.body.terminalSession || request.body.session || task.claimedBy || task.leaderAgentId || 'main', task);
      response.json({ ok: true, task });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/team/tasks/:taskId/fail', requireToken(config.token), async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const task = await teamStore.failClaimedTask(request.params.taskId, request.body || {});
      await publishTeamTaskNotice(sessionManager, request.body.terminalSession || request.body.session || task.leaderAgentId || 'main', task);
      response.json({ ok: true, task });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/team/tasks/:taskId/needs-user', requireToken(config.token), async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const task = await teamStore.requestUserInput(request.params.taskId, request.body || {});
      await publishTeamTaskNotice(sessionManager, request.body.terminalSession || request.body.session || task.leaderAgentId || 'main', task);
      response.json({ ok: true, task });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/team/tasks/:taskId/resume', requireToken(config.token), async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const task = await teamStore.resumeTask(request.params.taskId, request.body || {});
      await publishTeamTaskNotice(sessionManager, request.body.terminalSession || request.body.session || task.leaderAgentId || 'main', task);
      response.json({ ok: true, task });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/team/tasks/:taskId/cancel', requireToken(config.token), async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const task = await teamStore.cancelTask(request.params.taskId, request.body || {});
      await publishTeamTaskNotice(sessionManager, request.body.terminalSession || request.body.session || 'main', task);
      response.json({ ok: true, task });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/team/tasks/:taskId/retry', requireToken(config.token), async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const task = await teamStore.retryTask(request.params.taskId, request.body || {});
      await publishTeamTaskNotice(sessionManager, request.body.terminalSession || request.body.session || 'main', task);
      response.json({ ok: true, task });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/team/tasks/:taskId/dispatch', requireToken(config.token), async (request, response, next) => {
    let runningTask = null;
    let dispatchAgent = null;
    try {
      requireTeamStore(teamStore);
      requireAgentAdapter(agentAdapter);
      const task = await teamStore.getTask(request.params.taskId);
      if (!task) {
        response.status(404).json({ ok: false, error: 'task not found' });
        return;
      }
      dispatchAgent = await resolveDispatchAgent(teamStore, task);
      const roster = await teamStore.listRoster();
      const workerAgents = task.assignedTo === '@team'
        ? mentionedRosterAgents(task, roster).filter((agent) => agent.agentId !== dispatchAgent.agentId)
        : [];
      const completedTask = workerAgents.length > 0
        ? await dispatchSplitTeamTask({
          teamStore,
          agentAdapter,
          sessionManager,
          task,
          leaderAgent: dispatchAgent,
          workerAgents,
          terminalSession: request.body.terminalSession || request.body.session || dispatchAgent.session || 'main'
        })
        : await runDirectTeamTask({
          teamStore,
          agentAdapter,
          sessionManager,
          task,
          agent: dispatchAgent,
          terminalSession: request.body.terminalSession || request.body.session || dispatchAgent.session || 'main'
        });
      response.json({ ok: true, task: completedTask });
    } catch (error) {
      if (runningTask && dispatchAgent) {
        try {
          const failedTask = await teamStore.failTask(runningTask.taskId, {
            agentId: dispatchAgent.agentId,
            error: error.message
          });
          await publishTeamTaskNotice(sessionManager, request.body.terminalSession || request.body.session || dispatchAgent.session || 'main', failedTask);
        } catch {
          // Preserve the original dispatch error.
        }
      }
      next(error);
    }
  });

  app.post('/api/team/tasks', requireToken(config.token), async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const prompt = request.body && request.body.prompt;
      if (typeof prompt !== 'string') {
        response.status(400).json({ ok: false, error: 'prompt must be a string' });
        return;
      }
      const task = await teamStore.createTask(request.body || {});
      await publishTeamTaskNotice(sessionManager, request.body.terminalSession || request.body.session || 'main', task);
      response.json({ ok: true, task });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/team/context', async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      response.json({ context: await teamStore.getContext() });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/team/trace/:id', async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      response.json({ trace: await teamStore.trace(request.params.id) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/team/inbox', async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      response.json({ items: await teamStore.listInbox({ status: request.query.status }) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/team/inbox/:inboxId/ack', requireToken(config.token), async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const item = await teamStore.ackInboxItem(request.params.inboxId, request.body || {});
      response.json({ ok: true, item });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/team/context/notes', requireToken(config.token), async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const note = await teamStore.addContextNote(request.body || {});
      response.json({ ok: true, note });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/team/messages', async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      response.json({ messages: await teamStore.listMessages({ agent: request.query.agent }) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/team/messages', requireToken(config.token), async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const message = await teamStore.sendMessage(request.body || {});
      response.json({ ok: true, message });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/team/messages/:messageId/read', requireToken(config.token), async (request, response, next) => {
    try {
      requireTeamStore(teamStore);
      const message = await teamStore.markMessageRead(request.params.messageId);
      response.json({ ok: true, message });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/conversations', async (request, response, next) => {
    try {
      requireConversationStore(conversationStore);
      const conversations = await conversationStore.listConversations(parseLimit(request.query.limit));
      response.json({ conversations });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/conversations/:id/turns', async (request, response, next) => {
    try {
      requireConversationStore(conversationStore);
      const turns = await conversationStore.readTurns(request.params.id, parseLimit(request.query.limit));
      response.json({ conversationId: request.params.id, turns });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sessions/:name/transcript', async (request, response, next) => {
    try {
      const records = await sessionManager.readTranscript(request.params.name, parseLimit(request.query.limit));
      response.json({ session: request.params.name, records });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/sessions/:name/input', requireToken(config.token), async (request, response, next) => {
    try {
      const input = request.body && request.body.input;
      if (typeof input !== 'string') {
        response.status(400).json({ ok: false, error: 'input must be a string' });
        return;
      }
      await sessionManager.write(request.params.name, input);
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/agents/:agent/turns', requireToken(config.token), async (request, response, next) => {
    try {
      requireConversationStore(conversationStore);
      requireAgentAdapter(agentAdapter);

      const prompt = request.body && request.body.prompt;
      if (typeof prompt !== 'string') {
        response.status(400).json({ ok: false, error: 'prompt must be a string' });
        return;
      }

      const agent = request.params.agent;
      const conversationId = request.body.conversationId || defaultConversationId(agent);
      const terminalSession = request.body.terminalSession || request.body.session || 'main';
      const conversation = await conversationStore.getConversation(conversationId);
      const runningTurn = await conversationStore.appendTurn({
        conversationId,
        agent,
        prompt,
        reply: '',
        status: 'running',
        raw: {},
        agentState: conversation?.agentState || {}
      });
      await publishDirectTurnNotice(sessionManager, terminalSession, runningTurn);

      try {
        const result = await agentAdapter.runTurn(agent, { prompt, conversation });
        const turn = await conversationStore.updateTurn(conversationId, runningTurn.turnId, {
          reply: result.reply || '',
          status: result.status || 'completed',
          error: result.error || null,
          raw: result.raw || {},
          agentState: result.agentState || conversation?.agentState || {}
        });
        await publishDirectTurnNotice(sessionManager, terminalSession, turn);
        response.json({ ok: true, turn });
      } catch (error) {
        const failedTurn = await conversationStore.updateTurn(conversationId, runningTurn.turnId, {
          reply: '',
          status: 'failed',
          error: error.message,
          raw: {},
          agentState: conversation?.agentState || {}
        });
        await publishDirectTurnNotice(sessionManager, terminalSession, failedTurn);
        throw error;
      }
    } catch (error) {
      if (/^Unknown agent:/.test(error.message) || error.message === 'prompt must be a string') {
        response.status(400).json({ ok: false, error: error.message });
        return;
      }
      next(error);
    }
  });

  app.use(express.static(config.publicDir));

  app.use((error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    response.status(error.statusCode || 500).json({ ok: false, error: error.message });
  });

  async function ensureRosterSessionProfile(sessionName) {
    if (!teamStore || typeof sessionManager.getOrCreateWithProfile !== 'function') {
      return;
    }
    const roster = await teamStore.listRoster();
    const agent = roster.find((item) => item.status !== 'removed' && (item.session || item.agentId) === sessionName);
    if (agent) {
      sessionManager.getOrCreateWithProfile(agent.session || agent.agentId, agent.profileId);
    }
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, url);
    });
  });

  wss.on('connection', async (ws, request, url) => {
    const sessionName = url.searchParams.get('session') || 'main';
    let unsubscribe = () => {};
    try {
      await ensureRosterSessionProfile(sessionName);
      unsubscribe = sessionManager.subscribe(sessionName, (data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'output', data }));
        }
      });

      ws.send(JSON.stringify({
        type: 'ready',
        session: sessionName,
        sessions: sessionManager.listSessions()
      }));
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', error: error.message }));
      ws.close();
      return;
    }

    ws.on('message', async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'invalid message json' }));
        return;
      }

      try {
        if (message.type === 'input') {
          await sessionManager.write(sessionName, message.data || '');
        } else if (message.type === 'resize') {
          sessionManager.resize(sessionName, message.cols, message.rows);
        }
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', error: error.message }));
      }
    });

    ws.on('close', unsubscribe);
    ws.on('error', unsubscribe);
  });

  return { app, server, wss };
}

module.exports = {
  createWebServer,
  parseLimit,
  publicProfiles,
  publicAgentProfiles,
  formatDirectTurnNotice
};
