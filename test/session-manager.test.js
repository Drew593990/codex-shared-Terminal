const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const test = require('node:test');

const { SessionManager } = require('../server/session-manager');

class FakePty extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.resizes = [];
    this.killed = false;
  }

  onData(handler) {
    this.on('data', handler);
    return { dispose: () => this.off('data', handler) };
  }

  write(input) {
    this.writes.push(input);
  }

  resize(cols, rows) {
    this.resizes.push({ cols, rows });
  }

  kill() {
    this.killed = true;
  }
}

test('SessionManager forwards input to PTY and records it', async () => {
  const pty = new FakePty();
  const appended = [];
  const manager = new SessionManager({
    ptyFactory: () => pty,
    transcriptStore: {
      append: async (...args) => appended.push(args),
      read: async () => []
    }
  });

  await manager.write('main', 'Write-Output "hi"\r');

  assert.deepEqual(pty.writes, ['Write-Output "hi"\r']);
  assert.deepEqual(appended[0], ['main', 'input', 'Write-Output "hi"\r']);
});

test('SessionManager records PTY output and broadcasts to subscribers', async () => {
  const pty = new FakePty();
  const appended = [];
  const seen = [];
  const manager = new SessionManager({
    ptyFactory: () => pty,
    transcriptStore: {
      append: async (...args) => appended.push(args),
      read: async () => []
    }
  });

  const unsubscribe = manager.subscribe('main', (data) => seen.push(data));
  pty.emit('data', 'hello\r\n');
  unsubscribe();
  pty.emit('data', 'ignored\r\n');

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(seen, ['hello\r\n']);
  assert.deepEqual(appended[0], ['main', 'output', 'hello\r\n']);
});

test('SessionManager publishes system messages to transcript and subscribers without PTY input', async () => {
  const pty = new FakePty();
  const appended = [];
  const seen = [];
  const manager = new SessionManager({
    ptyFactory: () => pty,
    transcriptStore: {
      append: async (...args) => appended.push(args),
      read: async () => []
    }
  });

  const unsubscribe = manager.subscribe('main', (data) => seen.push(data));
  await manager.publishSystem('main', '[opencode running] turn-1\r\n');
  unsubscribe();

  assert.deepEqual(seen, ['[opencode running] turn-1\r\n']);
  assert.deepEqual(appended[0], ['main', 'system', '[opencode running] turn-1\r\n']);
  assert.deepEqual(pty.writes, []);
});

test('SessionManager resizes the PTY', () => {
  const pty = new FakePty();
  const manager = new SessionManager({
    ptyFactory: () => pty,
    transcriptStore: {
      append: async () => {},
      read: async () => []
    }
  });

  manager.resize('main', 120, 40);

  assert.deepEqual(pty.resizes, [{ cols: 120, rows: 40 }]);
});

test('SessionManager starts named sessions with matching CLI profile', () => {
  const spawned = [];
  const manager = new SessionManager({
    config: {
      cwd: 'D:\\shareterminal',
      shell: 'powershell.exe',
      profiles: {
        main: { command: 'powershell.exe', args: ['-NoLogo'], cwd: 'D:\\shareterminal' },
        opencode: { command: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-Command', 'opencode'], cwd: 'D:\\shareterminal' }
      }
    },
    ptyFactory: (profile) => {
      spawned.push(profile);
      return new FakePty();
    },
    transcriptStore: {
      append: async () => {},
      read: async () => []
    }
  });

  const session = manager.getOrCreate('opencode');

  assert.equal(session.name, 'opencode');
  assert.equal(session.command, 'powershell.exe');
  assert.deepEqual(spawned[0].args, ['-NoLogo', '-NoExit', '-Command', 'opencode']);
});

test('SessionManager starts a named agent session from a provider profile', () => {
  const spawned = [];
  const manager = new SessionManager({
    config: {
      cwd: 'D:\\shareterminal',
      shell: 'powershell.exe',
      profiles: {
        main: { command: 'powershell.exe', args: ['-NoLogo'], cwd: 'D:\\shareterminal' },
        opencode: { command: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-Command', 'opencode'], cwd: 'D:\\shareterminal' }
      }
    },
    ptyFactory: (profile) => {
      spawned.push(profile);
      return new FakePty();
    },
    transcriptStore: {
      append: async () => {},
      read: async () => []
    }
  });

  const session = manager.getOrCreateWithProfile('opencode1', 'opencode');

  assert.equal(session.name, 'opencode1');
  assert.equal(session.label, 'opencode1');
  assert.equal(session.command, 'powershell.exe');
  assert.deepEqual(spawned[0].args, ['-NoLogo', '-NoExit', '-Command', 'opencode']);
});
