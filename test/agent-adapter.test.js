const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const test = require('node:test');

const { AgentAdapter } = require('../server/agent-adapter');

function fakeChild({ stdout = '', stderr = '', exitCode = 0 }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    writes: [],
    end(value) {
      if (value) {
        this.writes.push(value);
      }
    },
    write(value) {
      this.writes.push(value);
    }
  };
  process.nextTick(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', exitCode);
  });
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

function hangingChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    end() {},
    write() {}
  };
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

class FakePty extends EventEmitter {
  constructor({ output = '', exitCode = 0 }) {
    super();
    this.output = output;
    this.exitCode = exitCode;
    this.killed = false;
  }

  onData(handler) {
    this.on('data', handler);
    process.nextTick(() => {
      if (this.output) {
        this.emit('data', this.output);
      }
    });
    return { dispose: () => this.off('data', handler) };
  }

  onExit(handler) {
    this.on('exit', handler);
    process.nextTick(() => {
      this.emit('exit', { exitCode: this.exitCode });
    });
    return { dispose: () => this.off('exit', handler) };
  }

  kill() {
    this.killed = true;
  }
}

test('AgentAdapter echo mode returns a structured local turn result', async () => {
  const adapter = new AgentAdapter({
    profiles: {
      echo: { label: 'Echo', mode: 'echo' }
    }
  });

  const result = await adapter.runTurn('echo', { prompt: 'Reply exactly: OK' });

  assert.equal(result.agent, 'echo');
  assert.equal(result.reply, 'Reply exactly: OK');
  assert.equal(result.status, 'completed');
  assert.equal(result.raw.mode, 'echo');
});

test('AgentAdapter command mode appends prompt args and parses opencode JSON output', async () => {
  const spawned = [];
  const adapter = new AgentAdapter({
    profiles: {
      opencode: {
        label: 'opencode',
        mode: 'command',
        command: 'opencode',
        args: ['run', '--pure', '--format', 'json'],
        promptMode: 'arg',
        sessionArg: '--session',
        responseFormat: 'opencode-json'
      }
    },
    spawnFactory(command, args, options) {
      spawned.push({ command, args, options });
      return fakeChild({
        stdout: [
          JSON.stringify({ type: 'step_start', sessionID: 'ses_123' }),
          JSON.stringify({
            type: 'text',
            sessionID: 'ses_123',
            part: { text: 'DIRECT_OK' }
          }),
          JSON.stringify({ type: 'step_finish', sessionID: 'ses_123' })
        ].join('\n')
      });
    }
  });

  const result = await adapter.runTurn('opencode', {
    prompt: 'Reply exactly: DIRECT_OK',
    conversation: {
      agentState: { opencodeSessionId: 'ses_existing' }
    }
  });

  assert.equal(spawned[0].command, 'opencode');
  assert.deepEqual(spawned[0].args, [
    'run',
    '--pure',
    '--format',
    'json',
    '--session',
    'ses_existing',
    'Reply exactly: DIRECT_OK'
  ]);
  assert.equal(result.reply, 'DIRECT_OK');
  assert.deepEqual(result.agentState, { opencodeSessionId: 'ses_123' });
  assert.equal(result.raw.exitCode, 0);
});

test('AgentAdapter command mode sends prompt through stdin when configured', async () => {
  let child;
  const adapter = new AgentAdapter({
    profiles: {
      claude: {
        label: 'Claude Code',
        mode: 'command',
        command: 'claude',
        args: ['-p'],
        promptMode: 'stdin',
        responseFormat: 'text'
      }
    },
    spawnFactory() {
      child = fakeChild({ stdout: 'CLAUDE_OK\n' });
      return child;
    }
  });

  const result = await adapter.runTurn('claude', { prompt: 'Reply exactly: CLAUDE_OK' });

  assert.deepEqual(child.stdin.writes, ['Reply exactly: CLAUDE_OK']);
  assert.equal(result.reply, 'CLAUDE_OK');
});

test('AgentAdapter command mode cancels a running subprocess when aborted', async () => {
  let child;
  const controller = new AbortController();
  const adapter = new AgentAdapter({
    profiles: {
      cli: {
        label: 'Cancelable CLI',
        mode: 'command',
        command: 'cli',
        args: [],
        promptMode: 'arg',
        responseFormat: 'text'
      }
    },
    spawnFactory() {
      child = hangingChild();
      return child;
    }
  });

  const run = adapter.runTurn('cli', {
    prompt: 'long task',
    signal: controller.signal
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('user stopped task'));
  const result = await run;

  assert.equal(result.status, 'cancelled');
  assert.match(result.error, /user stopped task/);
  assert.equal(result.raw.cancelled, true);
  assert.equal(child.killed, true);
});

test('AgentAdapter PTY command mode cancels a running subprocess when aborted', async () => {
  let commandPty;
  const controller = new AbortController();
  const adapter = new AgentAdapter({
    profiles: {
      opencode: {
        label: 'opencode',
        mode: 'command',
        command: 'opencode.exe',
        args: ['run'],
        promptMode: 'arg',
        responseFormat: 'text',
        usePty: true
      }
    },
    ptyFactory(command, args, options) {
      commandPty = new FakePty({ output: '' });
      commandPty.onExit = (handler) => {
        commandPty.on('exit', handler);
        return { dispose: () => commandPty.off('exit', handler) };
      };
      return commandPty;
    }
  });

  const run = adapter.runTurn('opencode', {
    prompt: 'long task',
    signal: controller.signal
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('user stopped pty'));
  const result = await run;

  assert.equal(result.status, 'cancelled');
  assert.match(result.error, /user stopped pty/);
  assert.equal(result.raw.cancelled, true);
  assert.equal(commandPty.killed, true);
});

test('AgentAdapter pty command mode captures TTY-only CLI output', async () => {
  const spawned = [];
  const adapter = new AgentAdapter({
    profiles: {
      opencode: {
        label: 'opencode',
        mode: 'command',
        command: 'opencode.exe',
        args: ['run', '--format', 'json'],
        promptMode: 'arg',
        responseFormat: 'opencode-json',
        usePty: true
      }
    },
    ptyFactory(command, args, options) {
      spawned.push({ command, args, options });
      return new FakePty({
        output: [
          '\u001b[?25l',
          JSON.stringify({ type: 'text', sessionID: 'ses_pty', part: { text: 'PTY_OK' } }),
          '\r\n',
          JSON.stringify({ type: 'step_finish', sessionID: 'ses_pty' }),
          '\r\n'
        ].join('')
      });
    }
  });

  const result = await adapter.runTurn('opencode', { prompt: 'Reply exactly: PTY_OK' });

  assert.equal(spawned[0].command, 'opencode.exe');
  assert.deepEqual(spawned[0].args, ['run', '--format', 'json', 'Reply exactly: PTY_OK']);
  assert.equal(result.reply, 'PTY_OK');
  assert.deepEqual(result.agentState, { opencodeSessionId: 'ses_pty' });
  assert.equal(result.raw.pty, true);
});

test('AgentAdapter parses opencode PTY JSON when terminal controls and wraps are present', async () => {
  const textEvent = JSON.stringify({
    type: 'text',
    sessionID: 'ses_wrapped',
    part: { text: 'ShareTerminal 项目分析\nDirect API 路由' }
  })
    .replace('ShareTerminal', 'Share\r\nTerminal')
    .replace('\\n', '\\\r\nn');

  const adapter = new AgentAdapter({
    profiles: {
      opencode: {
        label: 'opencode',
        mode: 'command',
        command: 'opencode.exe',
        args: ['run', '--format', 'json'],
        promptMode: 'arg',
        responseFormat: 'opencode-json',
        usePty: true
      }
    },
    ptyFactory() {
      return new FakePty({
        output: [
          '\u001b]0;npm\u0007',
          JSON.stringify({ type: 'step_start', sessionID: 'ses_wrapped' }),
          '\r\n',
          textEvent,
          '\r\n',
          JSON.stringify({ type: 'step_finish', sessionID: 'ses_wrapped' }),
          '\r\n'
        ].join('')
      });
    }
  });

  const result = await adapter.runTurn('opencode', { prompt: 'summarize project' });

  assert.equal(result.reply, 'ShareTerminal 项目分析\nDirect API 路由');
  assert.deepEqual(result.agentState, { opencodeSessionId: 'ses_wrapped' });
});

test('AgentAdapter reports command failures as failed turn results', async () => {
  const adapter = new AgentAdapter({
    profiles: {
      cli: {
        label: 'Broken CLI',
        mode: 'command',
        command: 'broken',
        args: [],
        promptMode: 'arg',
        responseFormat: 'text'
      }
    },
    spawnFactory() {
      return fakeChild({ stderr: 'boom', exitCode: 7 });
    }
  });

  const result = await adapter.runTurn('cli', { prompt: 'test' });

  assert.equal(result.status, 'failed');
  assert.match(result.error, /exited with code 7/);
  assert.equal(result.raw.stderr, 'boom');
});
