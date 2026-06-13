(function () {
  const shellEl = document.querySelector('.shell');
  const statusEl = document.getElementById('status');
  const sessionEl = document.getElementById('session');
  const sessionSelect = document.getElementById('session-select');
  const terminalEl = document.getElementById('terminal');
  const toggleConversationButton = document.getElementById('toggle-conversation');
  const reconnectButton = document.getElementById('reconnect');
  const clearButton = document.getElementById('clear');
  const agentSelect = document.getElementById('agent-select');
  const conversationIdInput = document.getElementById('conversation-id');
  const agentPrompt = document.getElementById('agent-prompt');
  const apiToken = document.getElementById('api-token');
  const sendAgentButton = document.getElementById('send-agent');
  const agentStatus = document.getElementById('agent-status');
  const conversationHistory = document.getElementById('conversation-history');
  let session = new URLSearchParams(window.location.search).get('session') || 'main';
  let lastConversationSignature = '';

  sessionEl.textContent = session;
  conversationIdInput.value = window.localStorage.getItem('shareterminal.conversationId') || 'direct-main';
  apiToken.value = window.localStorage.getItem('shareterminal.token') || '';

  const terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
    fontSize: 14,
    theme: {
      background: '#0b0f14',
      foreground: '#d8dee9',
      cursor: '#f4bf75',
      selectionBackground: '#284b63'
    }
  });
  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalEl);
  fitAddon.fit();
  terminal.focus();

  let socket = null;
  let reconnectTimer = null;

  function refitTerminal() {
    window.requestAnimationFrame(() => {
      fitAddon.fit();
      sendResize();
    });
  }

  function setConversationOpen(open) {
    shellEl.classList.toggle('conversation-collapsed', !open);
    toggleConversationButton.setAttribute('aria-expanded', String(open));
    toggleConversationButton.textContent = open ? 'Hide Direct' : 'Direct';
    window.localStorage.setItem('shareterminal.conversationOpen', open ? 'true' : 'false');
    refitTerminal();
    terminal.focus();
  }

  function setStatus(value) {
    statusEl.textContent = value;
    statusEl.dataset.state = value;
  }

  function sendResize() {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'resize',
        cols: terminal.cols,
        rows: terminal.rows
      }));
    }
  }

  async function loadProfiles() {
    const response = await fetch('/api/profiles');
    const body = await response.json();
    sessionSelect.innerHTML = '';
    body.profiles.forEach((profile) => {
      const option = document.createElement('option');
      option.value = profile.name;
      option.textContent = profile.label;
      sessionSelect.appendChild(option);
    });
    sessionSelect.value = session;
  }

  async function loadAgents() {
    const response = await fetch('/api/agents');
    const body = await response.json();
    agentSelect.innerHTML = '';
    body.agents.forEach((agent) => {
      const option = document.createElement('option');
      option.value = agent.name;
      option.textContent = agent.label;
      agentSelect.appendChild(option);
    });
    agentSelect.value = window.localStorage.getItem('shareterminal.agent') || body.agents[0]?.name || 'echo';
  }

  function setAgentStatus(value, state) {
    agentStatus.textContent = value;
    agentStatus.dataset.state = state || '';
  }

  function renderTurn(turn, options = {}) {
    const item = document.createElement('article');
    item.className = `turn ${turn.status === 'failed' ? 'failed' : ''}`;

    const meta = document.createElement('div');
    meta.className = 'turn-meta';
    meta.textContent = `${turn.agent} | ${turn.status || 'completed'} | ${turn.turnId || ''}`;

    const prompt = document.createElement('pre');
    prompt.className = 'turn-prompt';
    prompt.textContent = options.compact ? (turn.prompt || '').slice(0, 500) : (turn.prompt || '');

    const reply = document.createElement('pre');
    reply.className = 'turn-reply';
    reply.textContent = turn.status === 'running'
      ? 'running...'
      : (options.compact ? (turn.reply || turn.error || '').slice(0, 1200) : (turn.reply || turn.error || ''));

    item.append(meta, prompt, reply);
    return item;
  }

  async function loadConversationTurns(options = {}) {
    const conversationId = conversationIdInput.value.trim();
    if (!conversationId) {
      conversationHistory.replaceChildren();
      lastConversationSignature = '';
      return;
    }
    const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/turns`);
    if (!response.ok) {
      if (!options.silent) {
        setAgentStatus(`history ${response.status}`, 'error');
      }
      return;
    }
    const body = await response.json();
    const signature = body.turns.map((turn) => `${turn.turnId}:${turn.status}:${turn.completedAt || ''}`).join('|');
    if (signature === lastConversationSignature) {
      return;
    }
    const shouldStickToBottom = conversationHistory.scrollHeight -
      conversationHistory.scrollTop -
      conversationHistory.clientHeight < 24;
    conversationHistory.replaceChildren(...body.turns.map(renderTurn));
    lastConversationSignature = signature;
    if (shouldStickToBottom || !options.silent) {
      conversationHistory.scrollTop = conversationHistory.scrollHeight;
    }
  }

  async function sendAgentPrompt() {
    const agent = agentSelect.value || 'echo';
    const conversationId = conversationIdInput.value.trim() || `${agent}-${Date.now()}`;
    const prompt = agentPrompt.value;
    const token = apiToken.value;
    if (!prompt.trim()) {
      setAgentStatus('empty prompt', 'error');
      return;
    }

    conversationIdInput.value = conversationId;
    window.localStorage.setItem('shareterminal.agent', agent);
    window.localStorage.setItem('shareterminal.conversationId', conversationId);
    window.localStorage.setItem('shareterminal.token', token);

    sendAgentButton.disabled = true;
    setAgentStatus('running', 'running');
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agent)}/turns`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ conversationId, prompt, terminalSession: session })
      });
      const body = await response.json();
      if (!response.ok) {
        setAgentStatus(body.error || `error ${response.status}`, 'error');
        return;
      }
      agentPrompt.value = '';
      setAgentStatus(body.turn.status || 'completed', body.turn.status === 'failed' ? 'error' : 'ok');
      await loadConversationTurns();
    } catch (error) {
      setAgentStatus(error.message, 'error');
    } finally {
      sendAgentButton.disabled = false;
      terminal.focus();
    }
  }

  function connect() {
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      socket.close();
    }
    setStatus('connecting');
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const nextSocket = new WebSocket(`${scheme}//${window.location.host}/ws?session=${encodeURIComponent(session)}`);
    socket = nextSocket;

    nextSocket.addEventListener('open', () => {
      setStatus('connected');
      sendResize();
    });

    nextSocket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === 'output') {
        terminal.write(message.data);
      } else if (message.type === 'ready') {
        sessionEl.textContent = message.session;
      } else if (message.type === 'error') {
        terminal.write(`\r\n[server] ${message.error}\r\n`);
      }
    });

    nextSocket.addEventListener('close', () => {
      if (socket !== nextSocket) {
        return;
      }
      setStatus('closed');
      reconnectTimer = window.setTimeout(connect, 1000);
    });
    nextSocket.addEventListener('error', () => setStatus('error'));
  }

  terminal.onData((data) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', data }));
    }
  });

  window.addEventListener('resize', () => {
    fitAddon.fit();
    sendResize();
  });

  toggleConversationButton.addEventListener('click', () => {
    setConversationOpen(shellEl.classList.contains('conversation-collapsed'));
    if (!shellEl.classList.contains('conversation-collapsed')) {
      loadConversationTurns({ silent: true }).catch(() => {});
    }
  });
  reconnectButton.addEventListener('click', () => {
    connect();
    terminal.focus();
  });
  clearButton.addEventListener('click', () => {
    terminal.clear();
    terminal.focus();
  });
  sendAgentButton.addEventListener('click', sendAgentPrompt);
  conversationIdInput.addEventListener('change', () => {
    window.localStorage.setItem('shareterminal.conversationId', conversationIdInput.value.trim());
    lastConversationSignature = '';
    loadConversationTurns().catch((error) => setAgentStatus(error.message, 'error'));
  });
  agentSelect.addEventListener('change', () => {
    window.localStorage.setItem('shareterminal.agent', agentSelect.value);
  });
  agentPrompt.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      sendAgentPrompt();
    }
  });
  sessionSelect.addEventListener('change', () => {
    session = sessionSelect.value || 'main';
    sessionEl.textContent = session;
    terminal.clear();
    connect();
    terminal.focus();
  });

  setConversationOpen(window.localStorage.getItem('shareterminal.conversationOpen') === 'true');
  window.setInterval(() => {
    if (document.activeElement === conversationIdInput || document.activeElement === agentPrompt) {
      return;
    }
    loadConversationTurns({ silent: true }).catch(() => {});
  }, 3000);

  Promise.all([
    loadProfiles().catch(() => {}),
    loadAgents().then(loadConversationTurns).catch(() => {})
  ]).finally(() => {
    connect();
    terminal.focus();
  });
})();
