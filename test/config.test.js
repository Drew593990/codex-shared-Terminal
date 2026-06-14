const assert = require('node:assert/strict');
const { mkdir, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const { loadConfig, teamStoreContext } = require('../server/config');

test('loadConfig defines local CLI profiles for PowerShell, opencode, and claude', () => {
  const config = loadConfig({
    SHARETERMINAL_CWD: 'X:\\workspace\\shareterminal',
    SHARETERMINAL_TOKEN: 'secret'
  });

  assert.equal(config.profiles.main.command, 'powershell.exe');
  assert.deepEqual(config.profiles.opencode.args, ['-NoLogo', '-NoExit', '-Command', 'opencode']);
  assert.deepEqual(config.profiles.claude.args, ['-NoLogo', '-NoExit', '-Command', 'claude']);
});

test('loadConfig defines direct agent profiles and conversation storage', () => {
  const config = loadConfig({
    SHARETERMINAL_CWD: 'X:\\workspace\\shareterminal',
    SHARETERMINAL_DATA_DIR: 'X:\\workspace\\shareterminal\\data'
  });

  assert.equal(config.conversationDir, 'X:\\workspace\\shareterminal\\data\\conversations');
  assert.equal(config.teamDir, 'X:\\workspace\\shareterminal\\data\\team');
  assert.equal(config.agentProfiles.echo.mode, 'echo');
  assert.equal(
    config.agentProfiles.opencode.command,
    'opencode'
  );
  assert.deepEqual(config.agentProfiles.opencode.args, [
    'run',
    '--pure',
    '--format',
    'json',
    '--title',
    'shareterminal-direct'
  ]);
  assert.equal(config.agentProfiles.opencode.promptMode, 'arg');
  assert.equal(config.agentProfiles.opencode.sessionArg, '--session');
  assert.equal(config.agentProfiles.opencode.responseFormat, 'opencode-json');
  assert.equal(config.agentProfiles.opencode.usePty, true);
  assert.equal(config.agentProfiles.opencode.cols, 10000);
  assert.equal(
    config.agentProfiles.claude.command,
    'claude'
  );
  assert.deepEqual(config.agentProfiles.claude.args, ['-p']);
  assert.equal(config.agentProfiles.claude.promptMode, 'arg');
});

test('teamStoreContext uses configured cwd as the team workspace root', () => {
  const config = loadConfig({
    SHARETERMINAL_CWD: 'X:\\workspace\\target-project',
    SHARETERMINAL_DATA_DIR: 'X:\\workspace\\target-project\\data'
  });

  assert.deepEqual(teamStoreContext(config), {
    workspace: {
      projectRoot: 'X:\\workspace\\target-project',
      cwd: 'X:\\workspace\\target-project'
    }
  });
});

test('loadConfig can resolve direct CLIs from an explicit npm global directory', () => {
  const config = loadConfig({
    SHARETERMINAL_NPM_GLOBAL_DIR: 'X:\\tools\\npm-global'
  });

  assert.equal(
    config.agentProfiles.opencode.command,
    'X:\\tools\\npm-global\\node_modules\\opencode-ai\\bin\\opencode.exe'
  );
  assert.equal(
    config.agentProfiles.claude.command,
    'X:\\tools\\npm-global\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
  );
});

test('loadConfig merges project-local agent registry overrides', async () => {
  const root = path.join(__dirname, '..', '.tmp', `config-agents-${Date.now()}`);
  const registryDir = path.join(root, '.shareterminal');
  try {
    await mkdir(registryDir, { recursive: true });
    await writeFile(path.join(registryDir, 'agents.json'), JSON.stringify({
      agentProfiles: {
        opencode: {
          enabled: false
        },
        researcher: {
          label: 'Research Agent',
          mode: 'command',
          command: 'research-cli',
          args: ['run'],
          promptMode: 'stdin',
          capabilities: ['research'],
          worktreeMode: 'isolated'
        }
      }
    }), 'utf8');

    const config = loadConfig({
      SHARETERMINAL_CWD: root,
      SHARETERMINAL_TOKEN: 'secret'
    });

    assert.equal(config.agentProfiles.opencode.enabled, false);
    assert.equal(config.agentProfiles.opencode.command, 'opencode');
    assert.equal(config.agentProfiles.researcher.label, 'Research Agent');
    assert.equal(config.agentProfiles.researcher.command, 'research-cli');
    assert.deepEqual(config.agentProfiles.researcher.capabilities, ['research']);
    assert.equal(config.agentProfiles.researcher.worktreeMode, 'isolated');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadConfig accepts a UTF-8 BOM in project-local agent registry', async () => {
  const root = path.join(__dirname, '..', '.tmp', `config-agents-bom-${Date.now()}`);
  const registryDir = path.join(root, '.shareterminal');
  try {
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(registryDir, 'agents.json'),
      `\uFEFF${JSON.stringify({ agentProfiles: { reviewer: { label: 'Reviewer', mode: 'echo' } } })}`,
      'utf8'
    );

    const config = loadConfig({
      SHARETERMINAL_CWD: root,
      SHARETERMINAL_TOKEN: 'secret'
    });

    assert.equal(config.agentProfiles.reviewer.label, 'Reviewer');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
