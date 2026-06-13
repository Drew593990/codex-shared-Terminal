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

async function publishDirectTurnNotice(sessionManager, sessionName, turn) {
  if (typeof sessionManager.publishSystem !== 'function') {
    return;
  }
  await sessionManager.publishSystem(sessionName || 'main', formatDirectTurnNotice(turn));
}

function createWebServer({ sessionManager, config, conversationStore, agentAdapter }) {
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

  wss.on('connection', (ws, request, url) => {
    const sessionName = url.searchParams.get('session') || 'main';
    const unsubscribe = sessionManager.subscribe(sessionName, (data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data }));
      }
    });

    ws.send(JSON.stringify({
      type: 'ready',
      session: sessionName,
      sessions: sessionManager.listSessions()
    }));

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
