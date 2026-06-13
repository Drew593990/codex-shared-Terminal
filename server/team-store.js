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
    .map((line) => JSON.parse(line));
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

class TeamStore {
  constructor(rootDir, options = {}) {
    this.rootDir = rootDir;
    this.now = options.now || (() => new Date().toISOString());
    this.taskIdFactory = options.taskIdFactory || (() => defaultId('task'));
    this.messageIdFactory = options.messageIdFactory || (() => defaultId('message'));
    this.profiles = options.profiles || {};
  }

  file(name) {
    return path.join(this.rootDir, `${name}.jsonl`);
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

  nextAgentId(profileId, roster) {
    let index = 1;
    const existing = new Set(roster.map((agent) => agent.agentId));
    while (existing.has(`${profileId}${index}`)) {
      index += 1;
    }
    return `${profileId}${index}`;
  }

  async addRosterAgent(input) {
    const profileId = safeId(input.profileId, 'profileId');
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
    const now = this.now();
    const task = {
      taskId: input.taskId || this.taskIdFactory(),
      title: String(input.title || 'Team task'),
      prompt: String(input.prompt || ''),
      createdBy: input.createdBy || 'user',
      assignedTo: input.assignedTo || '@leader',
      leaderAgentId: input.leaderAgentId || leader?.agentId || null,
      rosterId: input.rosterId || 'default',
      status: input.status || 'queued',
      mentions,
      childTaskIds: [],
      handoffFrom: null,
      handoffTo: null,
      reviewedBy: null,
      reviewStatus: null,
      result: null,
      error: null,
      attempts: [],
      createdAt: now,
      updatedAt: now
    };
    await appendJsonLine(this.file('tasks'), task);
    const messageTarget = task.assignedTo === '@team' ? task.leaderAgentId : task.assignedTo;
    if (messageTarget) {
      await this.sendMessage({
        messageId: input.messageId,
        from: task.createdBy,
        to: messageTarget,
        taskId: task.taskId,
        body: task.prompt,
        mentions
      });
    }
    return task;
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
      status: input.status || 'pending',
      createdAt: now,
      readAt: null,
      replyTo: input.replyTo || null
    };
    await appendJsonLine(this.file('messages'), message);
    return message;
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
    return note;
  }

  async getContext() {
    return {
      roster: await this.activeRoster(),
      leader: await this.leaderAgent(),
      activeTasks: (await this.listTasks()).filter((task) => !['completed', 'failed', 'cancelled'].includes(task.status)),
      recentMessages: (await this.listMessages()).slice(-20),
      notes: latestBy(await readJsonLines(this.file('context-notes')), 'noteId')
    };
  }
}

module.exports = {
  TeamStore,
  readMentions,
  safeId
};
