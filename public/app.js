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
  const teamStatus = document.getElementById('team-status');
  const teamProfileSelect = document.getElementById('team-profile-select');
  const teamAgentId = document.getElementById('team-agent-id');
  const addTeamAgentButton = document.getElementById('add-team-agent');
  const teamRoster = document.getElementById('team-roster');
  const teamPrompt = document.getElementById('team-prompt');
  const sendTeamTaskButton = document.getElementById('send-team-task');
  const refreshTeamButton = document.getElementById('refresh-team');
  const teamMessages = document.getElementById('team-messages');
  let session = new URLSearchParams(window.location.search).get('session') || 'main';
  let lastConversationSignature = '';
  let lastTeamSignature = '';
  const terminalPanes = new Map();

  sessionEl.textContent = session;
  conversationIdInput.value = window.localStorage.getItem('shareterminal.conversationId') || 'direct-main';
  apiToken.value = window.localStorage.getItem('shareterminal.token') || '';

  function createTerminal() {
    return new Terminal({
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
  }

  function createPaneElement(sessionName, label) {
    const pane = document.createElement('article');
    pane.className = 'terminal-pane';
    pane.dataset.session = sessionName;

    const header = document.createElement('div');
    header.className = 'terminal-pane-header';

    const name = document.createElement('span');
    name.className = 'terminal-pane-name';
    name.textContent = label || sessionName;

    const state = document.createElement('span');
    state.className = 'terminal-pane-status';
    state.textContent = 'connecting';

    const body = document.createElement('div');
    body.className = 'terminal-pane-body';

    header.append(name, state);
    pane.append(header, body);
    terminalEl.appendChild(pane);
    return { pane, body, state };
  }

  function connectPane(sessionName, label, primary = false) {
    const existing = terminalPanes.get(sessionName);
    if (existing) {
      return existing;
    }
    const elements = createPaneElement(sessionName, label);
    const paneTerminal = createTerminal();
    const paneFit = new FitAddon.FitAddon();
    paneTerminal.loadAddon(paneFit);
    paneTerminal.open(elements.body);
    paneFit.fit();

    let paneSocket = null;
    function sendPaneResize() {
      if (paneSocket && paneSocket.readyState === WebSocket.OPEN) {
        paneSocket.send(JSON.stringify({
          type: 'resize',
          cols: paneTerminal.cols,
          rows: paneTerminal.rows
        }));
      }
    }
    function openPaneSocket() {
      if (paneSocket) {
        paneSocket.close();
      }
      elements.state.textContent = 'connecting';
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const nextSocket = new WebSocket(`${scheme}//${window.location.host}/ws?session=${encodeURIComponent(sessionName)}`);
      paneSocket = nextSocket;
      nextSocket.addEventListener('open', () => {
        elements.state.textContent = 'connected';
        sendPaneResize();
      });
      nextSocket.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === 'output') {
          paneTerminal.write(message.data);
        } else if (message.type === 'error') {
          paneTerminal.write(`\r\n[server] ${message.error}\r\n`);
        }
      });
      nextSocket.addEventListener('close', () => {
        if (paneSocket === nextSocket) {
          elements.state.textContent = 'closed';
        }
      });
      nextSocket.addEventListener('error', () => {
        elements.state.textContent = 'error';
      });
    }
    paneTerminal.onData((data) => {
      if (paneSocket && paneSocket.readyState === WebSocket.OPEN) {
        paneSocket.send(JSON.stringify({ type: 'input', data }));
      }
    });
    openPaneSocket();

    const entry = {
      sessionName,
      terminal: paneTerminal,
      fitAddon: paneFit,
      socket: () => paneSocket,
      refit: () => {
        paneFit.fit();
        sendPaneResize();
      },
      focus: () => paneTerminal.focus(),
      primary
    };
    terminalPanes.set(sessionName, entry);
    return entry;
  }

  const mainPane = connectPane(session, session, true);
  const terminal = mainPane.terminal;
  terminal.focus();

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
    terminalPanes.forEach((pane) => pane.refit());
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

  function setTeamStatus(value, state) {
    teamStatus.textContent = value;
    teamStatus.dataset.state = state || '';
  }

  function teamHeaders() {
    return {
      authorization: `Bearer ${apiToken.value}`,
      'content-type': 'application/json'
    };
  }

  function renderTeamAgent(agent) {
    const item = document.createElement('article');
    item.className = 'team-agent';
    item.dataset.role = agent.role || '';

    const main = document.createElement('div');
    main.className = 'team-agent-main';

    const id = document.createElement('div');
    id.className = 'team-agent-id';
    id.textContent = agent.agentId;

    const role = document.createElement('div');
    role.className = 'team-agent-role';
    role.textContent = agent.role === 'leader' ? 'leader' : (agent.role || 'worker');

    const meta = document.createElement('div');
    meta.className = 'team-agent-meta';
    meta.textContent = `${agent.profileId || ''} | ${agent.status || 'idle'} | ${agent.activeTaskId || 'no task'}`;

    main.append(id, role);
    item.append(main, meta);
    return item;
  }

  function renderTeamMessage(message) {
    const item = document.createElement('article');
    item.className = 'team-message';

    const main = document.createElement('div');
    main.className = 'team-message-main';

    const route = document.createElement('div');
    route.className = 'team-message-route';
    route.textContent = `${message.from || 'user'} -> ${message.to || ''}`;

    const status = document.createElement('div');
    status.className = 'team-agent-role';
    status.textContent = message.status || 'pending';

    const body = document.createElement('div');
    body.className = 'team-message-body';
    body.textContent = message.body || '';

    main.append(route, status);
    item.append(main, body);
    return item;
  }

  async function loadTeamProfiles() {
    const response = await fetch('/api/team/agents');
    const body = await response.json();
    if (!response.ok) {
      setTeamStatus(body.error || `profiles ${response.status}`, 'error');
      return;
    }
    teamProfileSelect.innerHTML = '';
    body.agents.forEach((agent) => {
      const option = document.createElement('option');
      option.value = agent.profileId;
      option.textContent = agent.label || agent.profileId;
      teamProfileSelect.appendChild(option);
    });
  }

  function syncAgentPanes(roster) {
    roster
      .filter((agent) => agent.status !== 'removed')
      .forEach((agent) => {
        const sessionName = agent.session || agent.agentId;
        connectPane(sessionName, `${agent.agentId} (${agent.role || 'worker'})`);
      });
    refitTerminal();
  }

  async function loadTeamState(options = {}) {
    const [rosterResponse, messagesResponse] = await Promise.all([
      fetch('/api/team/roster'),
      fetch('/api/team/messages')
    ]);
    const rosterBody = await rosterResponse.json();
    const messagesBody = await messagesResponse.json();
    if (!rosterResponse.ok) {
      setTeamStatus(rosterBody.error || `roster ${rosterResponse.status}`, 'error');
      return;
    }
    if (!messagesResponse.ok) {
      setTeamStatus(messagesBody.error || `messages ${messagesResponse.status}`, 'error');
      return;
    }

    const signature = JSON.stringify({
      roster: rosterBody.roster.map((agent) => [agent.agentId, agent.role, agent.status, agent.activeTaskId]),
      messages: messagesBody.messages.map((message) => [message.messageId, message.status])
    });
    if (signature === lastTeamSignature && options.silent) {
      return;
    }
    teamRoster.replaceChildren(...rosterBody.roster.map(renderTeamAgent));
    teamMessages.replaceChildren(...messagesBody.messages.slice(-6).map(renderTeamMessage));
    syncAgentPanes(rosterBody.roster);
    lastTeamSignature = signature;
    setTeamStatus(`${rosterBody.roster.filter((agent) => agent.status !== 'removed').length} agents`, 'ok');
  }

  async function addTeamAgent() {
    const profileId = teamProfileSelect.value;
    const agentId = teamAgentId.value.trim();
    if (!profileId) {
      setTeamStatus('choose profile', 'error');
      return;
    }
    addTeamAgentButton.disabled = true;
    setTeamStatus('adding', 'running');
    try {
      const response = await fetch('/api/team/roster/agents', {
        method: 'POST',
        headers: teamHeaders(),
        body: JSON.stringify({ profileId, agentId: agentId || undefined, addedBy: 'browser' })
      });
      const body = await response.json();
      if (!response.ok) {
        setTeamStatus(body.error || `add ${response.status}`, 'error');
        return;
      }
      teamAgentId.value = '';
      setTeamStatus(`added ${body.agent.agentId}`, 'ok');
      await loadTeamState();
    } catch (error) {
      setTeamStatus(error.message, 'error');
    } finally {
      addTeamAgentButton.disabled = false;
    }
  }

  async function sendTeamTask() {
    const prompt = teamPrompt.value.trim();
    if (!prompt) {
      setTeamStatus('empty team prompt', 'error');
      return;
    }
    sendTeamTaskButton.disabled = true;
    setTeamStatus('dispatching', 'running');
    window.localStorage.setItem('shareterminal.token', apiToken.value);
    try {
      const response = await fetch('/api/team/tasks', {
        method: 'POST',
        headers: teamHeaders(),
        body: JSON.stringify({
          title: prompt.replace(/\s+/g, ' ').slice(0, 80),
          prompt,
          assignedTo: prompt.includes('@team') ? '@team' : '@leader',
          createdBy: 'browser',
          terminalSession: session
        })
      });
      const body = await response.json();
      if (!response.ok) {
        setTeamStatus(body.error || `dispatch ${response.status}`, 'error');
        return;
      }
      setTeamStatus(`${body.task.status} ${body.task.taskId}`, 'ok');
      await loadTeamState();
    } catch (error) {
      setTeamStatus(error.message, 'error');
    } finally {
      sendTeamTaskButton.disabled = false;
    }
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
    setStatus('connected');
    sendResize();
  }

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
  addTeamAgentButton.addEventListener('click', addTeamAgent);
  sendTeamTaskButton.addEventListener('click', sendTeamTask);
  refreshTeamButton.addEventListener('click', () => {
    Promise.all([loadTeamProfiles(), loadTeamState()]).catch((error) => setTeamStatus(error.message, 'error'));
  });
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
  teamPrompt.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      sendTeamTask();
    }
  });
  sessionSelect.addEventListener('change', () => {
    session = sessionSelect.value || 'main';
    window.location.search = `?session=${encodeURIComponent(session)}`;
  });

  setConversationOpen(window.localStorage.getItem('shareterminal.conversationOpen') === 'true');
  window.setInterval(() => {
    if (document.activeElement === conversationIdInput || document.activeElement === agentPrompt) {
      return;
    }
    loadConversationTurns({ silent: true }).catch(() => {});
  }, 3000);
  window.setInterval(() => {
    if (document.activeElement === teamPrompt || document.activeElement === teamAgentId) {
      return;
    }
    loadTeamState({ silent: true }).catch(() => {});
  }, 3000);

  Promise.all([
    loadProfiles().catch(() => {}),
    loadAgents().then(loadConversationTurns).catch(() => {}),
    loadTeamProfiles().then(loadTeamState).catch((error) => setTeamStatus(error.message, 'error'))
  ]).finally(() => {
    connect();
    terminal.focus();
  });
})();
