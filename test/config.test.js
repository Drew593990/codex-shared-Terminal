const assert = require('node:assert/strict');
const test = require('node:test');

const { loadConfig } = require('../server/config');

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
