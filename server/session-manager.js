const os = require('node:os');
const { safeSessionName } = require('./transcript-store');

function createDefaultPtyFactory(config) {
  return (profile) => {
    const pty = require('node-pty');
    return pty.spawn(profile.command, profile.args || [], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: profile.cwd || config.cwd,
      env: process.env
    });
  };
}

class SessionManager {
  constructor({ config = {}, transcriptStore, ptyFactory } = {}) {
    if (!transcriptStore) {
      throw new Error('SessionManager requires transcriptStore');
    }

    this.config = {
      shell: os.platform() === 'win32' ? 'powershell.exe' : 'bash',
      cwd: process.cwd(),
      profiles: null,
      ...config
    };
    this.config.profiles = this.config.profiles || {
      main: {
        label: 'Shell',
        command: this.config.shell,
        args: [],
        cwd: this.config.cwd
      }
    };
    this.transcriptStore = transcriptStore;
    this.ptyFactory = ptyFactory || createDefaultPtyFactory(this.config);
    this.sessions = new Map();
  }

  profileFor(sessionName) {
    return this.config.profiles[sessionName] || {
      ...this.config.profiles.main,
      label: sessionName
    };
  }

  getOrCreate(name = 'main') {
    const sessionName = safeSessionName(name);
    const existing = this.sessions.get(sessionName);
    if (existing) {
      return existing;
    }

    const profile = this.profileFor(sessionName);
    const ptyProcess = this.ptyFactory({
      name: sessionName,
      ...profile,
      cwd: profile.cwd || this.config.cwd
    });
    const session = {
      name: sessionName,
      label: profile.label || sessionName,
      command: profile.command,
      args: profile.args || [],
      cwd: profile.cwd || this.config.cwd,
      createdAt: new Date().toISOString(),
      clients: new Set(),
      pty: ptyProcess
    };

    ptyProcess.onData((data) => {
      this.transcriptStore.append(sessionName, 'output', data).catch((error) => {
        session.clients.forEach((client) => client(`\r\n[transcript error] ${error.message}\r\n`));
      });
      session.clients.forEach((client) => client(data));
    });

    this.sessions.set(sessionName, session);
    return session;
  }

  listSessions() {
    return [...this.sessions.values()].map((session) => ({
      name: session.name,
      label: session.label,
      command: session.command,
      args: session.args,
      cwd: session.cwd,
      createdAt: session.createdAt,
      clients: session.clients.size
    }));
  }

  subscribe(name, handler) {
    const session = this.getOrCreate(name);
    session.clients.add(handler);
    return () => session.clients.delete(handler);
  }

  async write(name, input) {
    if (typeof input !== 'string') {
      throw new Error('input must be a string');
    }
    const session = this.getOrCreate(name);
    session.pty.write(input);
    await this.transcriptStore.append(session.name, 'input', input);
  }

  async publishSystem(name, data) {
    const sessionName = safeSessionName(name);
    const text = String(data);
    await this.transcriptStore.append(sessionName, 'system', text);
    const session = this.sessions.get(sessionName);
    if (session) {
      session.clients.forEach((client) => client(text));
    }
  }

  resize(name, cols, rows) {
    const parsedCols = Number.parseInt(cols, 10);
    const parsedRows = Number.parseInt(rows, 10);
    if (parsedCols < 10 || parsedRows < 3) {
      return;
    }
    const session = this.getOrCreate(name);
    session.pty.resize(parsedCols, parsedRows);
  }

  async readTranscript(name, limit) {
    const sessionName = safeSessionName(name);
    return this.transcriptStore.read(sessionName, limit);
  }

  closeAll() {
    for (const session of this.sessions.values()) {
      session.pty.kill();
    }
    this.sessions.clear();
  }
}

module.exports = {
  SessionManager,
  createDefaultPtyFactory
};
