const path = require('node:path');
const { appendFile, mkdir, readFile } = require('node:fs/promises');

function safeConversationId(conversationId) {
  if (typeof conversationId !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(conversationId)) {
    throw new Error(`Invalid conversation id: ${conversationId}`);
  }
  return conversationId;
}

function defaultIdFactory() {
  return `turn_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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

function latestTurns(records) {
  const latest = new Map();
  for (const record of records) {
    latest.set(record.turnId, record);
  }
  return [...latest.values()];
}

class ConversationStore {
  constructor(rootDir, options = {}) {
    this.rootDir = rootDir;
    this.now = options.now || (() => new Date().toISOString());
    this.idFactory = options.idFactory || defaultIdFactory;
  }

  conversationsFile() {
    return path.join(this.rootDir, 'conversations.jsonl');
  }

  turnsFile(conversationId) {
    const safeId = safeConversationId(conversationId);
    return path.join(this.rootDir, 'turns', `${safeId}.jsonl`);
  }

  async appendTurn(input) {
    const conversationId = safeConversationId(input.conversationId);
    const previous = await this.getConversation(conversationId);
    const createdAt = this.now();
    const turn = {
      conversationId,
      turnId: input.turnId || this.idFactory(),
      agent: input.agent,
      prompt: String(input.prompt || ''),
      reply: String(input.reply || ''),
      status: input.status || 'completed',
      error: input.error || null,
      raw: input.raw || {},
      agentState: input.agentState || previous?.agentState || {},
      createdAt,
      completedAt: input.completedAt ?? (input.status === 'running' ? null : createdAt)
    };

    await appendJsonLine(this.turnsFile(conversationId), turn);

    const metadata = {
      conversationId,
      agent: turn.agent,
      createdAt: previous?.createdAt || createdAt,
      updatedAt: turn.createdAt,
      lastTurnId: turn.turnId,
      lastPrompt: turn.prompt,
      lastReply: turn.reply,
      status: turn.status,
      turnCount: (previous?.turnCount || 0) + 1,
      agentState: turn.agentState
    };
    await appendJsonLine(this.conversationsFile(), metadata);
    return turn;
  }

  async updateTurn(conversationId, turnId, updates = {}) {
    const safeId = safeConversationId(conversationId);
    const records = await readJsonLines(this.turnsFile(safeId));
    const previousTurn = records.findLast((turn) => turn.turnId === turnId);
    if (!previousTurn) {
      throw new Error(`Unknown turn: ${turnId}`);
    }

    const previousConversation = await this.getConversation(safeId);
    const now = this.now();
    const status = updates.status || previousTurn.status || 'completed';
    const turn = {
      ...previousTurn,
      ...updates,
      conversationId: safeId,
      turnId,
      status,
      error: updates.error === undefined ? previousTurn.error || null : updates.error,
      raw: updates.raw || previousTurn.raw || {},
      agentState: updates.agentState || previousTurn.agentState || previousConversation?.agentState || {},
      createdAt: previousTurn.createdAt,
      completedAt: updates.completedAt ?? (status === 'running' ? null : now)
    };

    await appendJsonLine(this.turnsFile(safeId), turn);

    const metadata = {
      conversationId: safeId,
      agent: turn.agent,
      createdAt: previousConversation?.createdAt || turn.createdAt,
      updatedAt: turn.completedAt || now,
      lastTurnId: turn.turnId,
      lastPrompt: turn.prompt,
      lastReply: turn.reply,
      status: turn.status,
      turnCount: previousConversation?.turnCount || latestTurns(records).length,
      agentState: turn.agentState
    };
    await appendJsonLine(this.conversationsFile(), metadata);
    return turn;
  }

  async readTurns(conversationId, limit = 200) {
    const records = await readJsonLines(this.turnsFile(conversationId));
    const turns = latestTurns(records);
    const count = Math.max(0, Number.parseInt(limit, 10) || 0);
    return count > 0 ? turns.slice(-count) : turns;
  }

  async listConversations(limit = 200) {
    const records = await readJsonLines(this.conversationsFile());
    const latest = new Map();
    for (const record of records) {
      latest.set(record.conversationId, record);
    }
    const conversations = Array.from(latest.values())
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    const count = Math.max(0, Number.parseInt(limit, 10) || 0);
    return count > 0 ? conversations.slice(0, count) : conversations;
  }

  async getConversation(conversationId) {
    const safeId = safeConversationId(conversationId);
    const records = await readJsonLines(this.conversationsFile());
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].conversationId === safeId) {
        return records[index];
      }
    }
    return null;
  }
}

module.exports = {
  ConversationStore,
  safeConversationId
};
