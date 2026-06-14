const path = require('node:path');
const { appendFile, mkdir, readFile } = require('node:fs/promises');

function defaultId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function safeId(value, label = 'id') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

function readMentions(text) {
  const mentions = String(text || '').match(/@[a-zA-Z0-9_.-]+/g) || [];
  return [...new Set(mentions)];
}

async function readJsonLines(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line.replace(/^\uFEFF/, '')));
}

async function appendJsonLine(file, record) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
}

function latestBy(records, key) {
  const latest = new Map();
  for (const record of records) {
    latest.set(record[key], record);
  }
  return [...latest.values()];
}

function publicProfile(profileId, profile = {}) {
  return {
    profileId,
    label: profile.label || profileId,
    command: profile.command,
    kind: profile.kind || (profile.mode ? 'direct' : 'terminal'),
    mode: profile.mode,
    capabilities: profile.capabilities || [],
    worktreeMode: profile.worktreeMode || 'shared',
    defaultCount: profile.defaultCount || 0,
    enabled: profile.enabled !== false
  };
}

function compactSummary(value, limit = 700) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function addMillisecondsIso(isoValue, milliseconds) {
  return new Date(new Date(isoValue).getTime() + milliseconds).toISOString();
}

class TeamStore {
  constructor(rootDir, options = {}) {
    this.rootDir = rootDir;
    this.now = options.now || (() => new Date().toISOString());
    this.taskIdFactory = options.taskIdFactory || (() => defaultId('task'));
    this.messageIdFactory = options.messageIdFactory || (() => defaultId('message'));
    this.inboxIdFactory = options.inboxIdFactory || (() => defaultId('inbox'));
    this.profiles = options.profiles || {};
    this.staticContext = options.context || {};
  }

  file(name) {
    return path.join(this.rootDir, `${name}.jsonl`);
  }

  async appendEvent(input) {
    const event = {
      eventId: input.eventId || defaultId('event'),
      type: input.type,
      taskId: input.taskId || null,
      agentId: input.agentId || null,
      messageId: input.messageId || null,
      data: input.data || {},
      createdAt: input.createdAt || this.now()
    };
    await appendJsonLine(this.file('events'), event);
    return event;
  }

  async listAgentProfiles() {
    const builtIns = Object.entries(this.profiles).map(([profileId, profile]) => publicProfile(profileId, profile));
    const custom = latestBy(await readJsonLines(this.file('agent-profiles')), 'profileId');
    const merged = new Map();
    for (const profile of builtIns) {
      merged.set(profile.profileId, profile);
    }
    for (const profile of custom) {
      merged.set(profile.profileId, profile);
    }
    return [...merged.values()];
  }

  async addAgentProfile(input) {
    const profileId = safeId(input.profileId, 'profileId');
    const profile = {
      profileId,
      label: input.label || profileId,
      command: input.command || '',
      kind: input.kind || 'terminal',
      mode: input.mode || null,
      capabilities: Array.isArray(input.capabilities) ? input.capabilities : [],
      worktreeMode: input.worktreeMode || 'shared',
      defaultCount: Number.isInteger(input.defaultCount) ? input.defaultCount : 0,
      enabled: input.enabled !== false,
      updatedAt: this.now()
    };
    await appendJsonLine(this.file('agent-profiles'), profile);
    return profile;
  }

  async listRoster() {
    return latestBy(await readJsonLines(this.file('roster')), 'agentId');
  }

  async activeRoster() {
    return (await this.listRoster()).filter((agent) => agent.status !== 'removed');
  }

  async leaderAgent() {
    const roster = await this.activeRoster();
    return roster.find((agent) => agent.role === 'leader') || roster[0] || null;
  }

  async resolveMentionRoutes(mentions) {
    const roster = await this.activeRoster();
    const agentIds = new Set(roster.map((agent) => agent.agentId));
    const reserved = new Set(['team', 'leader']);
    const usedAgentIds = new Set();
    const routes = [];
    for (const mention of mentions || []) {
      const token = String(mention).replace(/^@/, '');
      if (!token || reserved.has(token) || agentIds.has(token)) {
        continue;
      }
      const candidates = roster.filter((agent) => (
        agent.profileId === token &&
        agent.status !== 'removed' &&
        !usedAgentIds.has(agent.agentId)
      ));
      if (candidates.length === 0) {
        continue;
      }
      const idleCandidates = candidates.filter((agent) => agent.status === 'idle' && !agent.activeTaskId);
      const selected = idleCandidates.find((agent) => agent.role !== 'leader') ||
        idleCandidates[0] ||
        candidates.find((agent) => agent.role !== 'leader') ||
        candidates[0];
      usedAgentIds.add(selected.agentId);
      routes.push({
        mention,
        profileId: selected.profileId,
        agentId: selected.agentId,
        role: selected.role
      });
    }
    return routes;
  }

  nextAgentId(profileId, roster) {
    let index = 1;
    const existing = new Set(roster.map((agent) => agent.agentId));
    while (existing.has(`${profileId}${index}`)) {
      index += 1;
    }
    return `${profileId}${index}`;
  }

  async assertAgentProfileAvailable(profileId) {
    const profiles = await this.listAgentProfiles();
    if (profiles.length === 0) {
      return;
    }
    const profile = profiles.find((item) => item.profileId === profileId);
    if (!profile) {
      throw new Error(`Unknown agent profile: ${profileId}`);
    }
    if (profile.enabled === false) {
      throw new Error(`Agent profile is disabled: ${profileId}`);
    }
  }

  async addRosterAgent(input) {
    const profileId = safeId(input.profileId, 'profileId');
    await this.assertAgentProfileAvailable(profileId);
    const roster = await this.listRoster();
    const agentId = safeId(input.agentId || this.nextAgentId(profileId, roster), 'agentId');
    if (roster.some((agent) => agent.agentId === agentId && agent.status !== 'removed')) {
      throw new Error(`Agent already exists: ${agentId}`);
    }
    const hasLeader = roster.some((agent) => agent.role === 'leader' && agent.status !== 'removed');
    const role = input.role || (hasLeader ? 'worker' : 'leader');
    const now = this.now();
    let records = [];
    if (role === 'leader') {
      records = roster
        .filter((agent) => agent.status !== 'removed' && agent.role === 'leader')
        .map((agent) => ({ ...agent, role: 'worker', updatedAt: now }));
    }
    const agent = {
      agentId,
      profileId,
      role,
      session: input.session || agentId,
      conversationId: input.conversationId || `${agentId}-conversation`,
      status: input.status || 'idle',
      activeTaskId: input.activeTaskId || null,
      lastActivityAt: now,
      addedBy: input.addedBy || 'user',
      addedAt: now,
      removedAt: null
    };
    for (const record of records) {
      await appendJsonLine(this.file('roster'), record);
    }
    await appendJsonLine(this.file('roster'), agent);
    return agent;
  }

  async setLeader(agentId) {
    const safeAgentId = safeId(agentId, 'agentId');
    const roster = await this.listRoster();
    const target = roster.find((agent) => agent.agentId === safeAgentId && agent.status !== 'removed');
    if (!target) {
      throw new Error(`Unknown agent: ${safeAgentId}`);
    }
    const now = this.now();
    for (const agent of roster.filter((item) => item.status !== 'removed')) {
      await appendJsonLine(this.file('roster'), {
        ...agent,
        role: agent.agentId === safeAgentId ? 'leader' : 'worker',
        lastActivityAt: now
      });
    }
    return { ...target, role: 'leader', lastActivityAt: now };
  }

  async removeRosterAgent(agentId) {
    const safeAgentId = safeId(agentId, 'agentId');
    const roster = await this.listRoster();
    const target = roster.find((agent) => agent.agentId === safeAgentId && agent.status !== 'removed');
    if (!target) {
      throw new Error(`Unknown agent: ${safeAgentId}`);
    }
    if (['planning', 'running', 'reviewing'].includes(target.status)) {
      throw new Error(`Agent is busy: ${safeAgentId}`);
    }
    const removed = {
      ...target,
      status: 'removed',
      removedAt: this.now()
    };
    await appendJsonLine(this.file('roster'), removed);
    return removed;
  }

  async listTasks() {
    return latestBy(await readJsonLines(this.file('tasks')), 'taskId');
  }

  async getTask(taskId) {
    const safeTaskId = safeId(taskId, 'taskId');
    return (await this.listTasks()).find((task) => task.taskId === safeTaskId) || null;
  }

  async createTask(input) {
    const leader = await this.leaderAgent();
    const mentions = readMentions(input.prompt);
    const mentionRoutes = await this.resolveMentionRoutes(mentions);
    const now = this.now();
    const task = {
      taskId: input.taskId || this.taskIdFactory(),
      title: String(input.title || 'Team task'),
      prompt: String(input.prompt || ''),
      createdBy: input.createdBy || 'user',
      assignedTo: input.assignedTo || '@leader',
      leaderAgentId: input.leaderAgentId || leader?.agentId || null,
      rosterId: input.rosterId || 'default',
      parentTaskId: input.parentTaskId || null,
      retryOf: input.retryOf || null,
      status: input.status || 'queued',
      mentions,
      mentionRoutes,
      childTaskIds: [],
      handoffFrom: null,
      handoffTo: null,
      reviewedBy: null,
      reviewStatus: null,
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
      result: null,
      error: null,
      attempts: [],
      createdAt: now,
      updatedAt: now
    };
    await appendJsonLine(this.file('tasks'), task);
    await this.appendEvent({
      type: 'task.created',
      taskId: task.taskId,
      agentId: task.leaderAgentId,
      data: { assignedTo: task.assignedTo, mentions: task.mentions, mentionRoutes: task.mentionRoutes }
    });
    const messageTarget = task.assignedTo === '@team' ? task.leaderAgentId : task.assignedTo;
    if (messageTarget) {
      await this.sendMessage({
        messageId: input.messageId,
        from: task.createdBy,
        to: messageTarget,
        taskId: task.taskId,
        body: task.prompt,
        mentions,
        mentionRoutes
      });
    }
    return task;
  }

  async createChildTask(parentTaskId, input = {}) {
    const parent = await this.getTask(parentTaskId);
    if (!parent) {
      throw new Error(`Unknown task: ${parentTaskId}`);
    }
    const child = await this.createTask({
      ...input,
      parentTaskId: parent.taskId,
      leaderAgentId: parent.leaderAgentId,
      rosterId: parent.rosterId
    });
    const latestParent = await this.getTask(parent.taskId);
    const childTaskIds = [...(latestParent.childTaskIds || []), child.taskId];
    await this.updateTask(parent.taskId, { childTaskIds });
    await this.appendEvent({
      type: 'task.child.created',
      taskId: parent.taskId,
      agentId: child.assignedTo,
      data: { childTaskId: child.taskId, assignedTo: child.assignedTo }
    });
    return child;
  }

  resolveMessageTarget(to) {
    return String(to || '');
  }

  async sendMessage(input) {
    let target = this.resolveMessageTarget(input.to);
    if (target === '@leader') {
      target = (await this.leaderAgent())?.agentId || '@leader';
    }
    const now = this.now();
    const message = {
      messageId: input.messageId || this.messageIdFactory(),
      from: input.from || 'user',
      to: target,
      taskId: input.taskId || null,
      body: String(input.body || ''),
      mentions: input.mentions || readMentions(input.body),
      mentionRoutes: input.mentionRoutes || [],
      status: input.status || 'pending',
      createdAt: now,
      readAt: null,
      replyTo: input.replyTo || null
    };
    await appendJsonLine(this.file('messages'), message);
    await this.appendEvent({
      type: 'message.sent',
      taskId: message.taskId,
      agentId: message.to,
      messageId: message.messageId,
      data: { from: message.from, to: message.to, mentions: message.mentions }
    });
    return message;
  }

  async updateRosterAgent(agentId, updates = {}) {
    const safeAgentId = safeId(agentId, 'agentId');
    const roster = await this.listRoster();
    const previous = roster.find((agent) => agent.agentId === safeAgentId);
    if (!previous) {
      throw new Error(`Unknown agent: ${safeAgentId}`);
    }
    const updated = {
      ...previous,
      ...updates,
      agentId: safeAgentId,
      lastActivityAt: this.now()
    };
    await appendJsonLine(this.file('roster'), updated);
    return updated;
  }

  async updateTask(taskId, updates = {}) {
    const safeTaskId = safeId(taskId, 'taskId');
    const previous = await this.getTask(safeTaskId);
    if (!previous) {
      throw new Error(`Unknown task: ${safeTaskId}`);
    }
    const updated = {
      ...previous,
      ...updates,
      taskId: safeTaskId,
      updatedAt: this.now()
    };
    await appendJsonLine(this.file('tasks'), updated);
    return updated;
  }

  async startTask(taskId, input = {}) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    const agentId = safeId(input.agentId || task.leaderAgentId, 'agentId');
    const startedAt = this.now();
    const attempt = {
      agentId,
      mode: input.mode || 'direct',
      turnId: input.turnId || null,
      startedAt,
      completedAt: null,
      status: 'running'
    };
    const updated = await this.updateTask(task.taskId, {
      status: 'running',
      attempts: [...(task.attempts || []), attempt],
      error: null
    });
    await this.updateRosterAgent(agentId, { status: 'running', activeTaskId: task.taskId });
    await this.appendEvent({
      type: 'task.running',
      taskId: task.taskId,
      agentId,
      data: { mode: attempt.mode, turnId: attempt.turnId }
    });
    return updated;
  }

  async createInboxItem(task, input = {}) {
    const inboxItem = {
      inboxId: input.inboxId || this.inboxIdFactory(),
      type: input.type || 'task_result',
      taskId: task.taskId,
      parentTaskId: task.parentTaskId || null,
      agentId: input.agentId || task.reviewedBy || task.leaderAgentId || null,
      status: input.status || 'unread',
      taskStatus: task.status,
      title: task.title,
      summary: compactSummary(input.summary || task.result || task.error || ''),
      createdAt: this.now(),
      ackedAt: null,
      ackedBy: null
    };
    await appendJsonLine(this.file('inbox'), inboxItem);
    return inboxItem;
  }

  async listInbox(filter = {}) {
    const items = latestBy(await readJsonLines(this.file('inbox')), 'inboxId')
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    if (!filter.status) {
      return items;
    }
    return items.filter((item) => item.status === filter.status);
  }

  async ackInboxItem(inboxId, input = {}) {
    const safeInboxId = safeId(inboxId, 'inboxId');
    const previous = (await this.listInbox()).find((item) => item.inboxId === safeInboxId);
    if (!previous) {
      throw new Error(`Unknown inbox item: ${safeInboxId}`);
    }
    const updated = {
      ...previous,
      status: 'acked',
      ackedAt: this.now(),
      ackedBy: input.ackedBy || 'user'
    };
    await appendJsonLine(this.file('inbox'), updated);
    return updated;
  }

  async agentInbox(agentId) {
    const safeAgentId = safeId(agentId, 'agentId');
    const roster = await this.activeRoster();
    const agent = roster.find((item) => item.agentId === safeAgentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${safeAgentId}`);
    }
    const messages = await this.listMessages({ agent: safeAgentId });
    const inboxItems = (await this.listInbox()).filter((item) => (
      item.agentId === safeAgentId ||
      (!item.agentId && item.taskId && item.taskId === agent.activeTaskId)
    ));
    const tasks = (await this.listTasks()).filter((task) => {
      if (!['queued', 'needs_user'].includes(task.status)) {
        return false;
      }
      if (task.assignedTo === safeAgentId || task.assignedTo === `@${safeAgentId}`) {
        return true;
      }
      if (task.assignedTo === '@leader' && task.leaderAgentId === safeAgentId) {
        return true;
      }
      if ((task.mentionRoutes || []).some((route) => route.agentId === safeAgentId)) {
        return true;
      }
      return (task.mentions || []).includes(`@${safeAgentId}`);
    });
    return {
      agent,
      tasks,
      items: inboxItems,
      messages,
      context: await this.getContext()
    };
  }

  async assertAgentCanClaim(task, agentId) {
    const roster = await this.activeRoster();
    const agent = roster.find((item) => item.agentId === agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    if (agent.status === 'removed') {
      throw new Error(`Agent is removed: ${agentId}`);
    }
    const assigned = task.assignedTo;
    const canClaim = assigned === agentId ||
      assigned === `@${agentId}` ||
      (assigned === '@leader' && task.leaderAgentId === agentId) ||
      (task.mentionRoutes || []).some((route) => route.agentId === agentId) ||
      (task.mentions || []).includes(`@${agentId}`);
    if (!canClaim) {
      throw new Error(`Task is not assigned to agent: ${agentId}`);
    }
    return agent;
  }

  async claimTask(taskId, input = {}) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    if (task.status !== 'queued') {
      throw new Error(`Task is not claimable: ${task.taskId}`);
    }
    const agentId = safeId(input.agentId || task.leaderAgentId, 'agentId');
    await this.assertAgentCanClaim(task, agentId);
    const claimedAt = this.now();
    const leaseMs = Number.isInteger(input.leaseMs) && input.leaseMs > 0 ? input.leaseMs : 120000;
    const attempt = {
      agentId,
      mode: input.mode || 'external',
      turnId: input.turnId || null,
      startedAt: claimedAt,
      completedAt: null,
      lastHeartbeatAt: claimedAt,
      leaseExpiresAt: addMillisecondsIso(claimedAt, leaseMs),
      status: 'running'
    };
    const updated = await this.updateTask(task.taskId, {
      status: 'running',
      claimedBy: agentId,
      claimedAt,
      leaseExpiresAt: attempt.leaseExpiresAt,
      attempts: [...(task.attempts || []), attempt],
      error: null
    });
    await this.updateRosterAgent(agentId, { status: 'running', activeTaskId: task.taskId });
    await this.appendEvent({
      type: 'task.claimed',
      taskId: task.taskId,
      agentId,
      data: { mode: attempt.mode, leaseExpiresAt: attempt.leaseExpiresAt }
    });
    return updated;
  }

  async heartbeatTask(taskId, input = {}) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    const agentId = safeId(input.agentId || task.claimedBy || task.leaderAgentId, 'agentId');
    if (task.status !== 'running' || task.claimedBy !== agentId) {
      throw new Error(`Task is not claimed by agent: ${agentId}`);
    }
    const heartbeatAt = this.now();
    const leaseMs = Number.isInteger(input.leaseMs) && input.leaseMs > 0 ? input.leaseMs : 120000;
    const leaseExpiresAt = addMillisecondsIso(heartbeatAt, leaseMs);
    const attempts = (task.attempts || []).map((attempt, index, values) => {
      if (index !== values.length - 1 || attempt.agentId !== agentId) {
        return attempt;
      }
      return {
        ...attempt,
        lastHeartbeatAt: heartbeatAt,
        leaseExpiresAt
      };
    });
    const updated = await this.updateTask(task.taskId, { leaseExpiresAt, attempts });
    await this.updateRosterAgent(agentId, { status: 'running', activeTaskId: task.taskId });
    await this.appendEvent({
      type: 'task.heartbeat',
      taskId: task.taskId,
      agentId,
      data: { leaseExpiresAt, note: input.note || null }
    });
    return updated;
  }

  async requestUserInput(taskId, input = {}) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    const agentId = safeId(input.agentId || task.claimedBy || task.leaderAgentId, 'agentId');
    if (task.status === 'running' && task.claimedBy && task.claimedBy !== agentId) {
      throw new Error(`Task is not claimed by agent: ${agentId}`);
    }
    if (!['queued', 'running', 'needs_user'].includes(task.status)) {
      throw new Error(`Task cannot request user input: ${task.taskId}`);
    }
    const question = String(input.question || input.prompt || 'User input required');
    const reason = String(input.reason || '');
    const paused = await this.updateTask(task.taskId, {
      status: 'needs_user',
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      userRequest: {
        agentId,
        question,
        reason,
        requestedAt: this.now()
      }
    });
    await this.updateRosterAgent(agentId, { status: 'waiting', activeTaskId: task.taskId });
    await this.createInboxItem(paused, {
      type: 'user_request',
      agentId,
      summary: question
    });
    await this.appendEvent({
      type: 'task.needs_user',
      taskId: task.taskId,
      agentId,
      data: { question, reason }
    });
    return paused;
  }

  async resumeTask(taskId, input = {}) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    if (task.status !== 'needs_user') {
      throw new Error(`Task is not waiting for user input: ${task.taskId}`);
    }
    const resumedBy = String(input.resumedBy || 'user');
    const answer = String(input.answer || input.response || '');
    const note = await this.addContextNote({
      taskId: task.taskId,
      createdBy: resumedBy,
      body: `User response for ${task.taskId}: ${answer}`
    });
    const resumed = await this.updateTask(task.taskId, {
      status: input.status || 'queued',
      error: null,
      userResponse: {
        resumedBy,
        answer,
        noteId: note.noteId,
        resumedAt: this.now()
      }
    });
    if (task.userRequest?.agentId) {
      await this.updateRosterAgent(task.userRequest.agentId, { status: 'idle', activeTaskId: null });
    }
    await this.appendEvent({
      type: 'task.resumed',
      taskId: task.taskId,
      agentId: task.leaderAgentId,
      data: { resumedBy, answer, noteId: note.noteId, status: resumed.status }
    });
    return resumed;
  }

  async assertTaskClaimedBy(task, agentId) {
    if (task.status !== 'running' || task.claimedBy !== agentId) {
      throw new Error(`Task is not claimed by agent: ${agentId}`);
    }
  }

  async completeClaimedTask(taskId, input = {}) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    const agentId = safeId(input.agentId || task.claimedBy || task.leaderAgentId, 'agentId');
    await this.assertTaskClaimedBy(task, agentId);
    const completed = await this.completeTask(task.taskId, {
      agentId,
      result: input.result,
      turnId: input.turnId || null,
      reviewedBy: input.reviewedBy || task.leaderAgentId || agentId,
      reviewStatus: input.reviewStatus || 'submitted'
    });
    if (task.leaderAgentId && task.leaderAgentId !== agentId) {
      await this.sendMessage({
        from: agentId,
        to: task.leaderAgentId,
        taskId: task.taskId,
        body: `@${task.leaderAgentId} ${agentId} completed ${task.taskId}: ${completed.result}`,
        replyTo: input.replyTo || null
      });
    }
    return completed;
  }

  async failClaimedTask(taskId, input = {}) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    const agentId = safeId(input.agentId || task.claimedBy || task.leaderAgentId, 'agentId');
    await this.assertTaskClaimedBy(task, agentId);
    const failed = await this.failTask(task.taskId, {
      agentId,
      error: input.error || input.reason || 'task failed'
    });
    if (task.leaderAgentId && task.leaderAgentId !== agentId) {
      await this.sendMessage({
        from: agentId,
        to: task.leaderAgentId,
        taskId: task.taskId,
        body: `@${task.leaderAgentId} ${agentId} failed ${task.taskId}: ${failed.error}`,
        replyTo: input.replyTo || null
      });
    }
    return failed;
  }

  async recoverStaleTasks(input = {}) {
    const staleBefore = input.staleBefore || this.now();
    const reason = String(input.reason || 'task lease expired');
    const tasks = await this.listTasks();
    const staleTasks = tasks.filter((task) => (
      task.status === 'running' &&
      task.claimedBy &&
      task.leaseExpiresAt &&
      String(task.leaseExpiresAt).localeCompare(String(staleBefore)) < 0
    ));
    const recovered = [];
    for (const task of staleTasks) {
      const agentId = task.claimedBy;
      const attempts = (task.attempts || []).map((attempt, index, values) => {
        if (index !== values.length - 1 || attempt.agentId !== agentId) {
          return attempt;
        }
        return {
          ...attempt,
          status: 'stale',
          completedAt: this.now()
        };
      });
      const updated = await this.updateTask(task.taskId, {
        status: 'queued',
        claimedBy: null,
        claimedAt: null,
        leaseExpiresAt: null,
        error: reason,
        attempts
      });
      await this.updateRosterAgent(agentId, { status: 'idle', activeTaskId: null });
      await this.appendEvent({
        type: 'task.recovered',
        taskId: task.taskId,
        agentId,
        data: { reason, staleBefore, previousLeaseExpiresAt: task.leaseExpiresAt }
      });
      recovered.push(updated);
    }
    return recovered;
  }

  async completeTask(taskId, input = {}) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    const agentId = safeId(input.agentId || task.leaderAgentId, 'agentId');
    const completedAt = this.now();
    const attempts = (task.attempts || []).map((attempt, index, values) => {
      if (index !== values.length - 1 || attempt.agentId !== agentId) {
        return attempt;
      }
      return {
        ...attempt,
        turnId: input.turnId || attempt.turnId || null,
        completedAt,
        status: 'completed'
      };
    });
    const updated = await this.updateTask(task.taskId, {
      status: 'completed',
      result: String(input.result || ''),
      reviewedBy: input.reviewedBy || task.leaderAgentId || agentId,
      reviewStatus: input.reviewStatus || 'checked',
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
      attempts
    });
    await this.updateRosterAgent(agentId, { status: 'idle', activeTaskId: null });
    await this.appendEvent({
      type: 'task.completed',
      taskId: task.taskId,
      agentId,
      data: { turnId: input.turnId || null, result: updated.result }
    });
    await this.createInboxItem(updated, { agentId, summary: updated.result });
    return updated;
  }

  async failTask(taskId, input = {}) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    const agentId = input.agentId || task.leaderAgentId;
    const updated = await this.updateTask(task.taskId, {
      status: 'failed',
      error: String(input.error || 'task failed'),
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null
    });
    if (agentId) {
      await this.updateRosterAgent(agentId, { status: 'idle', activeTaskId: null });
    }
    await this.appendEvent({
      type: 'task.failed',
      taskId: task.taskId,
      agentId,
      data: { error: updated.error }
    });
    await this.createInboxItem(updated, {
      agentId,
      type: 'task_failure',
      summary: updated.error
    });
    return updated;
  }

  async cancelTask(taskId, input = {}) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      throw new Error(`Task is already closed: ${task.taskId}`);
    }
    const agentId = input.agentId || task.leaderAgentId;
    const updated = await this.updateTask(task.taskId, {
      status: 'cancelled',
      error: String(input.reason || input.error || 'task cancelled'),
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null
    });
    if (agentId) {
      await this.updateRosterAgent(agentId, { status: 'idle', activeTaskId: null });
    }
    await this.appendEvent({
      type: 'task.cancelled',
      taskId: task.taskId,
      agentId,
      data: { reason: updated.error }
    });
    return updated;
  }

  async retryTask(taskId, input = {}) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    if (!['failed', 'cancelled'].includes(task.status)) {
      throw new Error(`Task is not retryable: ${task.taskId}`);
    }
    const retry = await this.createTask({
      title: input.title || task.title,
      prompt: input.prompt || task.prompt,
      createdBy: input.createdBy || 'user',
      assignedTo: input.assignedTo || task.assignedTo,
      leaderAgentId: input.leaderAgentId || task.leaderAgentId,
      rosterId: input.rosterId || task.rosterId,
      parentTaskId: input.parentTaskId || task.parentTaskId || null,
      retryOf: task.taskId,
      status: 'queued'
    });
    await this.appendEvent({
      type: 'task.retry.created',
      taskId: task.taskId,
      agentId: retry.leaderAgentId,
      data: { retryTaskId: retry.taskId, reason: input.reason || null }
    });
    return retry;
  }

  async listMessages(filter = {}) {
    const messages = latestBy(await readJsonLines(this.file('messages')), 'messageId');
    if (!filter.agent) {
      return messages;
    }
    return messages.filter((message) => message.to === filter.agent);
  }

  async markMessageRead(messageId) {
    const safeMessageId = safeId(messageId, 'messageId');
    const messages = await this.listMessages();
    const previous = messages.find((message) => message.messageId === safeMessageId);
    if (!previous) {
      throw new Error(`Unknown message: ${safeMessageId}`);
    }
    const updated = {
      ...previous,
      status: 'read',
      readAt: this.now()
    };
    await appendJsonLine(this.file('messages'), updated);
    return updated;
  }

  async addContextNote(input) {
    const note = {
      noteId: input.noteId || defaultId('note'),
      body: String(input.body || ''),
      createdBy: input.createdBy || 'user',
      createdAt: this.now()
    };
    await appendJsonLine(this.file('context-notes'), note);
    await this.appendEvent({
      type: 'context.note',
      taskId: input.taskId || null,
      agentId: input.createdBy || 'user',
      data: { noteId: note.noteId }
    });
    return note;
  }

  async getContext() {
    return {
      ...this.staticContext,
      roster: await this.activeRoster(),
      leader: await this.leaderAgent(),
      activeTasks: (await this.listTasks()).filter((task) => !['completed', 'failed', 'cancelled'].includes(task.status)),
      recentMessages: (await this.listMessages()).slice(-20),
      notes: latestBy(await readJsonLines(this.file('context-notes')), 'noteId')
    };
  }

  async trace(id) {
    const safeTraceId = safeId(id, 'trace id');
    const inboxItem = (await this.listInbox()).find((item) => item.inboxId === safeTraceId) || null;
    const message = (await this.listMessages()).find((item) => item.messageId === safeTraceId) || null;
    const rootTaskId = inboxItem?.taskId || message?.taskId || safeTraceId;
    const task = await this.getTask(rootTaskId);
    const allTasks = await this.listTasks();
    const childTasks = task
      ? (await Promise.all((task.childTaskIds || []).map((childTaskId) => this.getTask(childTaskId)))).filter(Boolean)
      : [];
    const retryTasks = task
      ? allTasks.filter((item) => item.retryOf === task.taskId)
      : [];
    const taskIds = new Set([
      rootTaskId,
      ...childTasks.map((child) => child.taskId)
    ]);
    const events = (await readJsonLines(this.file('events')))
      .filter((event) => taskIds.has(event.taskId) || event.messageId === safeTraceId)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    return {
      id: safeTraceId,
      task,
      inboxItem,
      message,
      tasks: [task, ...childTasks, ...retryTasks].filter(Boolean),
      events
    };
  }
}

module.exports = {
  TeamStore,
  readMentions,
  safeId
};
