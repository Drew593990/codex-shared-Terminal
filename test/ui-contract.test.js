const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('browser UI exposes team task and trace surfaces', async () => {
  const html = await readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const app = await readFile(path.join(root, 'public', 'app.js'), 'utf8');
  const css = await readFile(path.join(root, 'public', 'style.css'), 'utf8');

  assert.match(html, /class="workspace[^"]*command-workspace|class="command-workspace[^"]*workspace/);
  assert.match(html, /aria-label="Main terminal and agent workspace"/);
  assert.match(html, /id="main-terminal-region"/);
  assert.match(html, /aria-label="Main command terminal"/);
  assert.match(html, /id="agent-workspace"/);
  assert.match(html, /aria-label="Agent card workspace"/);
  assert.match(html, /id="agent-cards"/);
  assert.match(html, /id="team-tasks"/);
  assert.match(html, /id="team-trace"/);
  assert.match(html, /id="team-inbox"/);
  assert.match(app, /data-agent-id/);
  assert.match(app, /renderAgentCard/);
  assert.match(app, /renderAgentCards/);
  assert.match(app, /agent-card-reply/);
  assert.match(app, /agent-card-raw/);
  assert.match(app, /removeTeamAgent/);
  assert.match(app, /handleMainTerminalMention/);
  assert.match(app, /\/api\/team\/commands\/mention/);
  assert.match(app, /mainInputBuffer/);
  assert.match(app, /mainMentionCommand/);
  assert.match(app, /team-task-result/);
  assert.match(app, /\/api\/team\/tasks\/\$\{encodeURIComponent\(task\.taskId\)\}\/dispatch/);
  assert.match(app, /\/api\/team\/tasks\/\$\{encodeURIComponent\(task\.taskId\)\}\/cancel/);
  assert.match(app, /\/api\/team\/tasks\/\$\{encodeURIComponent\(task\.taskId\)\}\/retry/);
  assert.match(app, /\/api\/team\/tasks\/\$\{encodeURIComponent\(task\.taskId\)\}\/resume/);
  assert.match(app, /\/api\/team\/inbox\/\$\{encodeURIComponent\(item\.inboxId\)\}\/ack/);
  assert.match(app, /loadTeamTrace\(item\.inboxId\)/);
  assert.match(app, /\/api\/team\/inbox/);
  assert.match(app, /\/api\/team\/trace\//);
  assert.match(app, /team-agent-workspace/);
  assert.match(app, /agent\.workspace/);
  assert.match(css, /\.main-terminal-region/);
  assert.match(css, /\.agent-workspace/);
  assert.match(css, /\.agent-card/);
  assert.match(css, /\.agent-card-reply/);
  assert.match(css, /\.agent-card-raw/);
});
