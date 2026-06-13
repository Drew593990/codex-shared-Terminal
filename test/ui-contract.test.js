const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('browser UI exposes team task and trace surfaces', async () => {
  const html = await readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const app = await readFile(path.join(root, 'public', 'app.js'), 'utf8');

  assert.match(html, /id="team-tasks"/);
  assert.match(html, /id="team-trace"/);
  assert.match(html, /id="team-inbox"/);
  assert.match(app, /team-task-result/);
  assert.match(app, /\/api\/team\/tasks\/\$\{encodeURIComponent\(task\.taskId\)\}\/dispatch/);
  assert.match(app, /\/api\/team\/tasks\/\$\{encodeURIComponent\(task\.taskId\)\}\/cancel/);
  assert.match(app, /\/api\/team\/tasks\/\$\{encodeURIComponent\(task\.taskId\)\}\/retry/);
  assert.match(app, /\/api\/team\/tasks\/\$\{encodeURIComponent\(task\.taskId\)\}\/resume/);
  assert.match(app, /\/api\/team\/inbox\/\$\{encodeURIComponent\(item\.inboxId\)\}\/ack/);
  assert.match(app, /\/api\/team\/inbox/);
  assert.match(app, /\/api\/team\/trace\//);
});
