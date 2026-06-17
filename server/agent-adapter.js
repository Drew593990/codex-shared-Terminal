const { spawn } = require('node:child_process');
const pty = require('node-pty');

function publicAgents(profiles = {}) {
  return Object.entries(profiles).map(([name, profile]) => ({
    name,
    label: profile.label || name,
    mode: profile.mode,
    command: profile.mode === 'command' ? profile.command : undefined
  }));
}

function readJsonObject(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const lines = trimmed.split(/\r?\n/).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      // Keep trying older lines. Some CLIs print progress before JSON.
    }
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function readJsonObjects(text) {
  const trimmed = stripAnsi(text).trim();
  if (!trimmed) {
    return [];
  }

  const scannedObjects = scanJsonObjects(trimmed);
  if (scannedObjects.length > 0) {
    return scannedObjects;
  }

  const objects = [];
  for (const line of trimmed.split(/\r?\n/).filter(Boolean)) {
    try {
      objects.push(JSON.parse(line));
    } catch {
      // Ignore non-JSON log lines.
    }
  }
  if (objects.length > 0) {
    return objects;
  }

  const object = readJsonObject(trimmed);
  return object ? [object] : [];
}

function stripAnsi(text) {
  return String(text)
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function scanJsonObjects(text) {
  const objects = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') {
      continue;
    }

    const candidate = readBalancedJsonCandidate(text, start);
    if (!candidate) {
      continue;
    }

    try {
      objects.push(JSON.parse(candidate.json));
      start = candidate.end;
    } catch {
      // Keep scanning. A noisy terminal line may contain brace-like text before JSON.
    }
  }
  return objects;
}

function readBalancedJsonCandidate(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let json = '';

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        if (char === '\r' || char === '\n') {
          continue;
        }
        json += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        json += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        json += char;
        inString = false;
        continue;
      }
      if (char === '\r' || char === '\n') {
        continue;
      }
      json += char;
      continue;
    }

    json += char;
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return { json, end: index };
      }
    }
  }

  return null;
}

function pickReply(parsed, stdout) {
  const records = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  const textEvents = records
    .map((record) => {
      if (record?.type === 'text' && typeof record.part?.text === 'string') {
        return record.part.text;
      }
      if (record?.type === 'text' && typeof record.text === 'string') {
        return record.text;
      }
      return null;
    })
    .filter((value) => typeof value === 'string');
  if (textEvents.length > 0) {
    return textEvents.join('').trim();
  }

  if (records.length === 0) {
    return stdout.trim();
  }

  const parsedObject = records[records.length - 1];
  const candidates = [
    parsedObject.result,
    parsedObject.reply,
    parsedObject.message,
    parsedObject.text,
    parsedObject.output,
    parsedObject.response
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      return candidate.trim();
    }
  }
  return stdout.trim();
}

function pickOpencodeSessionId(parsed) {
  const records = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  if (records.length === 0) {
    return null;
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const sessionId = record.sessionID ||
      record.sessionId ||
      record.part?.sessionID ||
      record.part?.sessionId ||
      record.info?.sessionID ||
      record.info?.sessionId ||
      record.session?.id ||
      record.metadata?.sessionID ||
      null;
    if (sessionId) {
      return sessionId;
    }
  }
  return null;
}

function killProcessTree(child, spawnFactory) {
  if (!child || !child.pid) {
    if (child && typeof child.kill === 'function') {
      child.kill();
    }
    return;
  }
  if (process.platform === 'win32') {
    try {
      spawnFactory('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        shell: false,
        windowsHide: true
      });
      return;
    } catch {
      // Fall back to child.kill below.
    }
  }
  if (typeof child.kill === 'function') {
    child.kill();
  }
}

function abortReason(signal) {
  const reason = signal?.reason;
  if (!reason) {
    return 'agent run cancelled';
  }
  if (reason instanceof Error) {
    return reason.message;
  }
  return String(reason);
}

class AgentAdapter {
  constructor(options = {}) {
    this.profiles = options.profiles || {};
    this.spawnFactory = options.spawnFactory || spawn;
    this.ptyFactory = options.ptyFactory || pty.spawn;
    this.defaultTimeoutMs = options.defaultTimeoutMs || 120000;
  }

  listAgents() {
    return publicAgents(this.profiles);
  }

  async runTurn(agentName, input) {
    const profile = this.profiles[agentName];
    if (!profile) {
      throw new Error(`Unknown agent: ${agentName}`);
    }
    if (!input || typeof input.prompt !== 'string') {
      throw new Error('prompt must be a string');
    }

    if (profile.mode === 'echo') {
      return {
        agent: agentName,
        reply: input.prompt,
        status: 'completed',
        raw: { mode: 'echo' },
        agentState: input.conversation?.agentState || {}
      };
    }

    if (profile.mode === 'command') {
      if (profile.usePty) {
        return this.runPtyCommand(agentName, profile, input);
      }
      return this.runCommand(agentName, profile, input);
    }

    throw new Error(`Unsupported agent mode: ${profile.mode}`);
  }

  runCommand(agentName, profile, input) {
    const args = this.commandArgs(agentName, profile, input);
    const command = profile.command;
    const timeoutMs = profile.timeoutMs || this.defaultTimeoutMs;
    const signal = input.signal;
    const options = {
      cwd: profile.cwd || process.cwd(),
      env: { ...process.env, ...(profile.env || {}) },
      shell: false,
      windowsHide: true
    };

    if (signal?.aborted) {
      return Promise.resolve({
        agent: agentName,
        reply: '',
        status: 'cancelled',
        error: abortReason(signal),
        raw: { command, args, stdout: '', stderr: '', cancelled: true },
        agentState: input.conversation?.agentState || {}
      });
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let child;
      let abortHandler;

      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (abortHandler) {
          signal?.removeEventListener?.('abort', abortHandler);
        }
        resolve(result);
      };

      const timer = setTimeout(() => {
        killProcessTree(child, this.spawnFactory);
        finish({
          agent: agentName,
          reply: '',
          status: 'failed',
          error: `Command timed out after ${timeoutMs}ms`,
          raw: { command, args, stdout, stderr, timedOut: true },
          agentState: input.conversation?.agentState || {}
        });
      }, timeoutMs);

      try {
        child = this.spawnFactory(command, args, options);
      } catch (error) {
        finish({
          agent: agentName,
          reply: '',
          status: 'failed',
          error: error.message,
          raw: { command, args, stdout, stderr },
          agentState: input.conversation?.agentState || {}
        });
        return;
      }

      abortHandler = () => {
        killProcessTree(child, this.spawnFactory);
        finish({
          agent: agentName,
          reply: '',
          status: 'cancelled',
          error: abortReason(signal),
          raw: { command, args, stdout, stderr, cancelled: true },
          agentState: input.conversation?.agentState || {}
        });
      };
      signal?.addEventListener?.('abort', abortHandler, { once: true });
      if (signal?.aborted) {
        abortHandler();
        return;
      }

      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => {
        finish({
          agent: agentName,
          reply: '',
          status: 'failed',
          error: error.message,
          raw: { command, args, stdout, stderr },
          agentState: input.conversation?.agentState || {}
        });
      });
      child.on('close', (exitCode) => {
        finish(this.resultFromOutput(agentName, profile, input, {
          command,
          args,
          stdout,
          stderr,
          exitCode
        }));
      });

      if ((profile.promptMode || 'arg') === 'stdin' && child.stdin) {
        child.stdin.end(input.prompt);
      }
    });
  }

  runPtyCommand(agentName, profile, input) {
    const args = this.commandArgs(agentName, profile, input);
    const command = profile.command;
    const timeoutMs = profile.timeoutMs || this.defaultTimeoutMs;
    const signal = input.signal;
    const options = {
      cwd: profile.cwd || process.cwd(),
      env: { ...process.env, ...(profile.env || {}) },
      cols: profile.cols || 160,
      rows: profile.rows || 40,
      name: profile.term || 'xterm-color'
    };

    if (signal?.aborted) {
      return Promise.resolve({
        agent: agentName,
        reply: '',
        status: 'cancelled',
        error: abortReason(signal),
        raw: { command, args, stdout: '', stderr: '', cancelled: true, pty: true },
        agentState: input.conversation?.agentState || {}
      });
    }

    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      let commandPty;
      let dataSubscription;
      let exitSubscription;
      let abortHandler;

      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (abortHandler) {
          signal?.removeEventListener?.('abort', abortHandler);
        }
        dataSubscription?.dispose?.();
        exitSubscription?.dispose?.();
        resolve(result);
      };

      const timer = setTimeout(() => {
        killProcessTree(commandPty, this.spawnFactory);
        finish({
          agent: agentName,
          reply: '',
          status: 'failed',
          error: `Command timed out after ${timeoutMs}ms`,
          raw: { command, args, stdout: stripAnsi(output), stderr: '', timedOut: true, pty: true },
          agentState: input.conversation?.agentState || {}
        });
      }, timeoutMs);

      try {
        commandPty = this.ptyFactory(command, args, options);
      } catch (error) {
        finish({
          agent: agentName,
          reply: '',
          status: 'failed',
          error: error.message,
          raw: { command, args, stdout: stripAnsi(output), stderr: '', pty: true },
          agentState: input.conversation?.agentState || {}
        });
        return;
      }

      abortHandler = () => {
        killProcessTree(commandPty, this.spawnFactory);
        finish({
          agent: agentName,
          reply: '',
          status: 'cancelled',
          error: abortReason(signal),
          raw: { command, args, stdout: stripAnsi(output), stderr: '', cancelled: true, pty: true },
          agentState: input.conversation?.agentState || {}
        });
      };
      signal?.addEventListener?.('abort', abortHandler, { once: true });
      if (signal?.aborted) {
        abortHandler();
        return;
      }

      dataSubscription = commandPty.onData((data) => {
        output += data;
      });
      exitSubscription = commandPty.onExit((event) => {
        finish(this.resultFromOutput(agentName, profile, input, {
          command,
          args,
          stdout: stripAnsi(output),
          stderr: '',
          exitCode: event.exitCode,
          pty: true
        }));
      });
    });
  }

  commandArgs(agentName, profile, input) {
    const args = [...(profile.args || [])];
    const stateKey = profile.stateKey || `${agentName}SessionId`;
    const sessionId = input.conversation?.agentState?.[stateKey];
    if (profile.sessionArg && sessionId) {
      args.push(profile.sessionArg, sessionId);
    }
    if ((profile.promptMode || 'arg') === 'arg') {
      args.push(input.prompt);
    }
    return args;
  }

  resultFromOutput(agentName, profile, input, raw) {
    if (raw.exitCode !== 0) {
      return {
        agent: agentName,
        reply: '',
        status: 'failed',
        error: `${raw.command} exited with code ${raw.exitCode}`,
        raw,
        agentState: input.conversation?.agentState || {}
      };
    }

    const parsed = profile.responseFormat === 'opencode-json' ? readJsonObjects(raw.stdout) : null;
    const agentState = { ...(input.conversation?.agentState || {}) };
    if (profile.responseFormat === 'opencode-json') {
      const nextSessionId = pickOpencodeSessionId(parsed);
      if (nextSessionId) {
        agentState[profile.stateKey || `${agentName}SessionId`] = nextSessionId;
      }
    }

    return {
      agent: agentName,
      reply: pickReply(parsed, raw.stdout),
      status: 'completed',
      raw,
      agentState
    };
  }
}

module.exports = {
  AgentAdapter,
  publicAgents,
  readJsonObject,
  readJsonObjects,
  stripAnsi,
  pickReply,
  pickOpencodeSessionId,
  killProcessTree
};
