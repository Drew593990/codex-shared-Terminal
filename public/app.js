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
  const teamTasks = document.getElementById('team-tasks');
  const teamInbox = document.getElementById('team-inbox');
  const teamTrace = document.getElementById('team-trace');
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

  function createPaneElement(sessionName, label, primary = false) {
    const pane = document.createElement('article');
    pane.className = 'terminal-pane';
    pane.dataset.session = sessionName;
    pane.setAttribute('data-agent-id', sessionName);
    pane.dataset.agentId = sessionName;
    pane.dataset.role = primary ? 'main' : 'agent';
    pane.dataset.taskStatus = 'idle';

    const header = document.createElement('div');
    header.className = 'terminal-pane-header';

    const name = document.createElement('span');
    name.className = 'terminal-pane-name';
    name.textContent = label || sessionName;

    const meta = document.createElement('div');
    meta.className = 'terminal-pane-meta';

    const role = document.createElement('span');
    role.className = 'terminal-pane-role';
    role.textContent = primary ? 'main' : 'agent';

    const task = document.createElement('span');
    task.className = 'terminal-pane-task';
    task.textContent = 'idle';

    const workspace = document.createElement('span');
    workspace.className = 'terminal-pane-workspace';
    workspace.textContent = '';

    const state = document.createElement('span');
    state.className = 'terminal-pane-status';
    state.textContent = 'connecting';

    const body = document.createElement('div');
    body.className = 'terminal-pane-body';

    meta.append(role, task, workspace);
    header.append(name, meta, state);
    pane.append(header, body);
    terminalEl.appendChild(pane);
    return { pane, body, state, role, task, workspace };
  }

  function updatePaneMetadata(entry, agent = {}) {
    if (!entry || !entry.elements) {
      return;
    }
    const agentId = agent.agentId || entry.sessionName;
    const role = agent.role || (entry.primary ? 'main' : 'agent');
    const taskState = agent.activeTaskId || agent.status || 'idle';
    entry.elements.pane.setAttribute('data-agent-id', agentId);
    entry.elements.pane.dataset.agentId = agentId;
    entry.elements.pane.dataset.role = role;
    entry.elements.pane.dataset.taskStatus = agent.status || 'idle';
    entry.elements.role.textContent = role;
    entry.elements.task.textContent = taskState;
    entry.elements.workspace.textContent = formatAgentWorkspace(agent);
  }

  function connectPane(sessionName, label, primary = false) {
    const existing = terminalPanes.get(sessionName);
    if (existing) {
      return existing;
    }
    const elements = createPaneElement(sessionName, label, primary);
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
      elements,
      primary
    };
    terminalPanes.set(sessionName, entry);
    updatePaneMetadata(entry);
    return entry;
  }

  const mainPane = connectPane(session, session, true);
  const terminal = mainPane.terminal;
  terminal.focus();

  let reconnectTimer = null;

  function refitTerminal() {
    window.requestAnimationFrame(() => {
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

  function formatAgentWorkspace(agent) {
    const workspace = agent.workspace || {};
    if (!workspace.mode) {
      return '';
    }
    return [
      workspace.mode,
      workspace.status,
      workspace.path
    ].filter(Boolean).join(' | ');
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

    const workspace = document.createElement('div');
    workspace.className = 'team-agent-workspace';
    workspace.textContent = formatAgentWorkspace(agent);

    main.append(id, role);
    item.append(main, meta);
    if (workspace.textContent) {
      item.append(workspace);
    }
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

  function renderTeamTask(task) {
    const item = document.createElement('article');
    item.className = 'team-task';

    const main = document.createElement('div');
    main.className = 'team-task-main';

    const title = document.createElement('div');
    title.className = 'team-task-title';
    title.textContent = task.title || task.taskId;

    const status = document.createElement('div');
    status.className = 'team-agent-role';
    status.textContent = task.status || 'queued';

    const meta = document.createElement('div');
    meta.className = 'team-task-meta';
    meta.textContent = `${task.taskId} | leader ${task.leaderAgentId || 'none'} | ${task.assignedTo || ''}`;

    const result = document.createElement('div');
    result.className = 'team-task-result';
    result.textContent = task.result ? task.result.slice(0, 360) : '';

    const actions = document.createElement('div');
    actions.className = 'conversation-toolbar';

    const dispatch = document.createElement('button');
    dispatch.type = 'button';
    dispatch.textContent = 'Run';
    dispatch.disabled = !['queued', 'failed'].includes(task.status);
    dispatch.addEventListener('click', () => {
      dispatchTeamTask(task).catch((error) => setTeamStatus(error.message, 'error'));
    });

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.disabled = !['queued', 'running'].includes(task.status);
    cancel.addEventListener('click', () => {
      cancelTeamTask(task).catch((error) => setTeamStatus(error.message, 'error'));
    });

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry';
    retry.disabled = !['failed', 'cancelled'].includes(task.status);
    retry.addEventListener('click', () => {
      retryTeamTask(task).catch((error) => setTeamStatus(error.message, 'error'));
    });

    const resume = document.createElement('button');
    resume.type = 'button';
    resume.textContent = 'Resume';
    resume.disabled = task.status !== 'needs_user';
    resume.addEventListener('click', () => {
      resumeTeamTask(task).catch((error) => setTeamStatus(error.message, 'error'));
    });

    const trace = document.createElement('button');
    trace.type = 'button';
    trace.textContent = 'Trace';
    trace.addEventListener('click', () => {
      loadTeamTrace(task.taskId).catch((error) => setTeamStatus(error.message, 'error'));
    });

    main.append(title, status);
    actions.append(dispatch, cancel, retry, resume, trace);
    item.append(main, meta);
    if (task.result) {
      item.append(result);
    }
    item.append(actions);
    return item;
  }

  function renderInboxItem(item) {
    const row = document.createElement('article');
    row.className = 'team-inbox-item';
    row.dataset.status = item.status || '';

    const main = document.createElement('div');
    main.className = 'team-task-main';

    const title = document.createElement('div');
    title.className = 'team-task-title';
    title.textContent = item.title || item.taskId || item.inboxId;

    const status = document.createElement('div');
    status.className = 'team-agent-role';
    status.textContent = item.status || 'unread';

    const summary = document.createElement('div');
    summary.className = 'team-task-result';
    summary.textContent = item.summary || '';

    const meta = document.createElement('div');
    meta.className = 'team-task-meta';
    meta.textContent = `${item.inboxId} | ${item.taskId || ''} | ${item.taskStatus || ''}`;

    const actions = document.createElement('div');
    actions.className = 'conversation-toolbar';

    const ack = document.createElement('button');
    ack.type = 'button';
    ack.textContent = 'Ack';
    ack.disabled = item.status === 'acked';
    ack.addEventListener('click', () => {
      ackInboxItem(item).catch((error) => setTeamStatus(error.message, 'error'));
    });

    const trace = document.createElement('button');
    trace.type = 'button';
    trace.textContent = 'Trace';
    trace.disabled = !item.inboxId;
    trace.addEventListener('click', () => {
      loadTeamTrace(item.inboxId).catch((error) => setTeamStatus(error.message, 'error'));
    });

    main.append(title, status);
    actions.append(ack, trace);
    row.append(main, meta);
    if (item.summary) {
      row.append(summary);
    }
    row.append(actions);
    return row;
  }

  function renderTraceEvent(event) {
    const item = document.createElement('article');
    item.className = 'team-trace-event';

    const main = document.createElement('div');
    main.className = 'team-trace-main';

    const type = document.createElement('div');
    type.className = 'team-trace-type';
    type.textContent = event.type || 'event';

    const time = document.createElement('div');
    time.className = 'team-agent-role';
    time.textContent = (event.createdAt || '').slice(11, 19);

    const data = document.createElement('div');
    data.className = 'team-trace-data';
    data.textContent = `${event.agentId || ''} ${JSON.stringify(event.data || {})}`.trim();

    main.append(type, time);
    item.append(main, data);
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
        const entry = connectPane(sessionName, `${agent.agentId} (${agent.role || 'worker'})`);
        updatePaneMetadata(entry, agent);
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
      roster: rosterBody.roster.map((agent) => [
        agent.agentId,
        agent.role,
        agent.status,
        agent.activeTaskId,
        agent.workspace?.mode,
        agent.workspace?.status,
        agent.workspace?.path
      ]),
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
    await Promise.all([
      loadTeamTasks({ silent: true }),
      loadTeamInbox({ silent: true })
    ]);
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
      await loadTeamTrace(body.task.taskId);
    } catch (error) {
      setTeamStatus(error.message, 'error');
    } finally {
      sendTeamTaskButton.disabled = false;
    }
  }

  async function loadTeamTasks(options = {}) {
    const response = await fetch('/api/team/tasks');
    const body = await response.json();
    if (!response.ok) {
      if (!options.silent) {
        setTeamStatus(body.error || `tasks ${response.status}`, 'error');
      }
      return;
    }
    teamTasks.replaceChildren(...body.tasks.slice(-8).reverse().map(renderTeamTask));
  }

  async function loadTeamInbox(options = {}) {
    const response = await fetch('/api/team/inbox');
    const body = await response.json();
    if (!response.ok) {
      if (!options.silent) {
        setTeamStatus(body.error || `inbox ${response.status}`, 'error');
      }
      return;
    }
    teamInbox.replaceChildren(...body.items.slice(-6).reverse().map(renderInboxItem));
  }

  async function dispatchTeamTask(task) {
    setTeamStatus(`running ${task.taskId}`, 'running');
    const response = await fetch(`/api/team/tasks/${encodeURIComponent(task.taskId)}/dispatch`, {
      method: 'POST',
      headers: teamHeaders(),
      body: JSON.stringify({ terminalSession: session })
    });
    const body = await response.json();
    if (!response.ok) {
      setTeamStatus(body.error || `dispatch ${response.status}`, 'error');
      return;
    }
    setTeamStatus(`${body.task.status} ${body.task.taskId}`, body.task.status === 'failed' ? 'error' : 'ok');
    await Promise.all([loadTeamTasks(), loadTeamInbox()]);
    await loadTeamState({ silent: true });
    await loadTeamTrace(body.task.taskId);
  }

  async function cancelTeamTask(task) {
    setTeamStatus(`cancelling ${task.taskId}`, 'running');
    const response = await fetch(`/api/team/tasks/${encodeURIComponent(task.taskId)}/cancel`, {
      method: 'POST',
      headers: teamHeaders(),
      body: JSON.stringify({ terminalSession: session, reason: 'cancelled from browser' })
    });
    const body = await response.json();
    if (!response.ok) {
      setTeamStatus(body.error || `cancel ${response.status}`, 'error');
      return;
    }
    setTeamStatus(`${body.task.status} ${body.task.taskId}`, 'ok');
    await loadTeamTasks();
    await loadTeamState({ silent: true });
    await loadTeamTrace(body.task.taskId);
  }

  async function retryTeamTask(task) {
    setTeamStatus(`retrying ${task.taskId}`, 'running');
    const response = await fetch(`/api/team/tasks/${encodeURIComponent(task.taskId)}/retry`, {
      method: 'POST',
      headers: teamHeaders(),
      body: JSON.stringify({ terminalSession: session, createdBy: 'browser', reason: 'retry from browser' })
    });
    const body = await response.json();
    if (!response.ok) {
      setTeamStatus(body.error || `retry ${response.status}`, 'error');
      return;
    }
    setTeamStatus(`queued ${body.task.taskId}`, 'ok');
    await loadTeamTasks();
    await loadTeamState({ silent: true });
    await loadTeamTrace(task.taskId);
  }

  async function resumeTeamTask(task) {
    const answer = teamPrompt.value.trim();
    setTeamStatus(`resuming ${task.taskId}`, 'running');
    const response = await fetch(`/api/team/tasks/${encodeURIComponent(task.taskId)}/resume`, {
      method: 'POST',
      headers: teamHeaders(),
      body: JSON.stringify({
        terminalSession: session,
        resumedBy: 'browser',
        answer: answer || 'resume from browser'
      })
    });
    const body = await response.json();
    if (!response.ok) {
      setTeamStatus(body.error || `resume ${response.status}`, 'error');
      return;
    }
    setTeamStatus(`queued ${body.task.taskId}`, 'ok');
    await loadTeamTasks();
    await loadTeamInbox();
    await loadTeamState({ silent: true });
    await loadTeamTrace(task.taskId);
  }

  async function ackInboxItem(item) {
    setTeamStatus(`acking ${item.inboxId}`, 'running');
    const response = await fetch(`/api/team/inbox/${encodeURIComponent(item.inboxId)}/ack`, {
      method: 'POST',
      headers: teamHeaders(),
      body: JSON.stringify({ ackedBy: 'browser' })
    });
    const body = await response.json();
    if (!response.ok) {
      setTeamStatus(body.error || `ack ${response.status}`, 'error');
      return;
    }
    setTeamStatus(`acked ${body.item.inboxId}`, 'ok');
    await loadTeamInbox();
  }

  async function loadTeamTrace(taskId) {
    const response = await fetch(`/api/team/trace/${encodeURIComponent(taskId)}`);
    const body = await response.json();
    if (!response.ok) {
      setTeamStatus(body.error || `trace ${response.status}`, 'error');
      return;
    }
    teamTrace.replaceChildren(...body.trace.events.slice(-8).map(renderTraceEvent));
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
