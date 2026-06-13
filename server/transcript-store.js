const path = require('node:path');
const { appendFile, mkdir, readFile } = require('node:fs/promises');

function safeSessionName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(name)) {
    throw new Error(`Invalid session name: ${name}`);
  }
  return name;
}

class TranscriptStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  fileFor(sessionName) {
    const safeName = safeSessionName(sessionName);
    return path.join(this.rootDir, `${safeName}.jsonl`);
  }

  async append(sessionName, direction, data) {
    if (direction !== 'input' && direction !== 'output' && direction !== 'system') {
      throw new Error(`Invalid transcript direction: ${direction}`);
    }

    const file = this.fileFor(sessionName);
    await mkdir(path.dirname(file), { recursive: true });
    const record = {
      at: new Date().toISOString(),
      session: sessionName,
      direction,
      data: String(data)
    };
    await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  async read(sessionName, limit = 200) {
    const file = this.fileFor(sessionName);
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const records = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const count = Math.max(0, Number.parseInt(limit, 10) || 0);
    return count > 0 ? records.slice(-count) : records;
  }
}

module.exports = {
  TranscriptStore,
  safeSessionName
};

