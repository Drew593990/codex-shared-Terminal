const path = require('node:path');
const crypto = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');

const ROOT_DIR = path.resolve(__dirname, '..');

function readInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function createToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function readProjectAgentProfiles(cwd) {
  const registryPath = path.join(cwd, '.shareterminal', 'agents.json');
  if (!existsSync(registryPath)) {
    return {};
  }
  let parsed;
  try {
    const text = readFileSync(registryPath, 'utf8').replace(/^\uFEFF/, '');
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid agent registry: ${registryPath}: ${error.message}`);
  }
  const profiles = parsed.agentProfiles || parsed.agents || {};
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new Error(`Invalid agent registry: ${registryPath}: agentProfiles must be an object`);
  }
  return profiles;
}

function loadConfig(env = process.env) {
  const dataDir = env.SHARETERMINAL_DATA_DIR || path.join(ROOT_DIR, 'data');
  const cwd = env.SHARETERMINAL_CWD || ROOT_DIR;
  const npmGlobalDir = env.SHARETERMINAL_NPM_GLOBAL_DIR || '';
  const opencodeCommand = env.SHARETERMINAL_OPENCODE_COMMAND ||
    (npmGlobalDir ? path.join(npmGlobalDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe') : 'opencode');
  const claudeCommand = env.SHARETERMINAL_CLAUDE_COMMAND ||
    (npmGlobalDir ? path.join(npmGlobalDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : 'claude');

  const builtInAgentProfiles = {
    echo: {
      label: 'Echo Test',
      mode: 'echo'
    },
    opencode: {
      label: 'opencode',
      mode: 'command',
      command: opencodeCommand,
      args: ['run', '--pure', '--format', 'json', '--title', 'shareterminal-direct'],
      cwd,
      promptMode: 'arg',
      sessionArg: '--session',
      stateKey: 'opencodeSessionId',
      responseFormat: 'opencode-json',
      usePty: true,
      cols: 10000
    },
    claude: {
      label: 'Claude Code',
      mode: 'command',
      command: claudeCommand,
      args: ['-p'],
      cwd,
      promptMode: 'arg',
      responseFormat: 'text'
    }
  };
  const projectAgentProfiles = readProjectAgentProfiles(cwd);
  const agentProfiles = { ...builtInAgentProfiles };
  for (const [profileId, profile] of Object.entries(projectAgentProfiles)) {
    agentProfiles[profileId] = {
      ...(agentProfiles[profileId] || {}),
      ...profile
    };
  }

  return {
    rootDir: ROOT_DIR,
    host: env.SHARETERMINAL_HOST || '127.0.0.1',
    port: readInteger(env.SHARETERMINAL_PORT, 7842),
    token: env.SHARETERMINAL_TOKEN || createToken(),
    shell: env.SHARETERMINAL_SHELL || 'powershell.exe',
    cwd,
    publicDir: env.SHARETERMINAL_PUBLIC_DIR || path.join(ROOT_DIR, 'public'),
    dataDir,
    transcriptDir: env.SHARETERMINAL_TRANSCRIPT_DIR || path.join(dataDir, 'transcripts'),
    conversationDir: env.SHARETERMINAL_CONVERSATION_DIR || path.join(dataDir, 'conversations'),
    teamDir: env.SHARETERMINAL_TEAM_DIR || path.join(dataDir, 'team'),
    profiles: {
      main: {
        label: 'PowerShell',
        command: 'powershell.exe',
        args: ['-NoLogo'],
        cwd
      },
      opencode: {
        label: 'opencode',
        command: 'powershell.exe',
        args: ['-NoLogo', '-NoExit', '-Command', 'opencode'],
        cwd
      },
      claude: {
        label: 'Claude Code',
        command: 'powershell.exe',
        args: ['-NoLogo', '-NoExit', '-Command', 'claude'],
        cwd
      }
    },
    agentProfiles
  };
}

module.exports = {
  ROOT_DIR,
  createToken,
  readProjectAgentProfiles,
  loadConfig
};
