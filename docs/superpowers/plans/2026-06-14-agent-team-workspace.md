# Agent Team Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved phase 2 visible multi-agent workspace so roster agents appear as separate xterm panes, expose team state in pane headers, and receive lifecycle notices in the relevant agent sessions.

**Architecture:** Keep the existing Node.js/Express/team-store architecture. Extend the browser workspace contract in `public/index.html`, `public/app.js`, and `public/style.css`; tighten backend session routing in `server/web-server.js`; prove behavior with `node:test` tests and local HTTP smoke checks.

**Tech Stack:** Node.js, Express, WebSocket, xterm.js, vanilla browser JavaScript, PowerShell scripts, `node:test`.

---

## File Structure

- Modify `test/ui-contract.test.js`: static browser contract tests for the visible team workspace, pane metadata, and roster-to-pane synchronization hooks.
- Modify `public/index.html`: stable workspace and team-surface labels/classes only when required by tests.
- Modify `public/app.js`: pane metadata rendering, roster-driven pane metadata updates, and stable state hooks.
- Modify `public/style.css`: compact pane header/status styling and workspace control layout.
- Modify `test/web-server.test.js`: route tests proving team lifecycle notices publish to worker and leader sessions.
- Modify `server/web-server.js`: helper functions that resolve the most relevant visible session for parent, child, leader, and external task lifecycle notices.
- Create `scripts/smoke-team-workspace.ps1`: local smoke script for adding multiple echo agents, dispatching a team task, and checking tasks/inbox/trace APIs.
- Modify `package.json`: add a script entry for the team workspace smoke if the existing scripts section permits a small additive script.

## Task 1: Browser Workspace Contract

**Files:**
- Modify: `test/ui-contract.test.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`

- [ ] **Step 1: Write the failing UI contract test**

Add assertions to `test/ui-contract.test.js`:

```js
assert.match(html, /class="workspace[^"]*team-workspace|class="team-workspace[^"]*workspace/);
assert.match(html, /aria-label="Team terminal workspace"/);
assert.match(app, /data-agent-id/);
assert.match(app, /terminal-pane-role/);
assert.match(app, /terminal-pane-task/);
assert.match(app, /terminal-pane-workspace/);
assert.match(app, /updatePaneMetadata/);
assert.match(app, /syncAgentPanes\(rosterBody\.roster\)/);
assert.match(css, /\.terminal-pane-meta/);
assert.match(css, /\.terminal-pane-role/);
assert.match(css, /\.terminal-pane-task/);
assert.match(css, /\.terminal-pane-workspace/);
```

- [ ] **Step 2: Run the UI contract test and verify RED**

Run:

```powershell
npm test -- test/ui-contract.test.js
```

Expected: FAIL because the current markup/app/css do not expose all required workspace and pane metadata contract strings.

- [ ] **Step 3: Implement minimal workspace contract**

Update `public/index.html` so the workspace section is:

```html
<section class="workspace team-workspace" aria-label="Team terminal workspace">
```

Update `public/app.js` so `createPaneElement()` creates header metadata nodes:

```js
const meta = document.createElement('div');
meta.className = 'terminal-pane-meta';

const role = document.createElement('span');
role.className = 'terminal-pane-role';
role.textContent = primary ? 'main' : 'agent';

const task = document.createElement('span');
task.className = 'terminal-pane-task';
task.textContent = 'idle';

const workspace = document.createElement('span');
workspace.className = 'terminal-pane-workspace';
workspace.textContent = '';

meta.append(role, task, workspace);
header.append(name, meta, state);
```

Add an `updatePaneMetadata(entry, agent)` function:

```js
function updatePaneMetadata(entry, agent = {}) {
  if (!entry || !entry.elements) {
    return;
  }
  const agentId = agent.agentId || entry.sessionName;
  entry.elements.pane.dataset.agentId = agentId;
  entry.elements.pane.dataset.role = agent.role || (entry.primary ? 'main' : 'agent');
  entry.elements.pane.dataset.taskStatus = agent.status || 'idle';
  entry.elements.role.textContent = agent.role || (entry.primary ? 'main' : 'agent');
  entry.elements.task.textContent = agent.activeTaskId || agent.status || 'idle';
  entry.elements.workspace.textContent = formatAgentWorkspace(agent);
}
```

Ensure `connectPane()` stores `elements` on the entry and calls `updatePaneMetadata(entry)`.

Update `syncAgentPanes(roster)`:

```js
const entry = connectPane(sessionName, `${agent.agentId} (${agent.role || 'worker'})`);
updatePaneMetadata(entry, agent);
```

Update `public/style.css` with compact metadata classes:

```css
.terminal-pane-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: #aeb7c2;
}

.terminal-pane-role,
.terminal-pane-task,
.terminal-pane-workspace {
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}

.terminal-pane-role {
  color: #8bd49c;
}

.terminal-pane-task {
  color: #f4bf75;
}
```

- [ ] **Step 4: Run the UI contract test and verify GREEN**

Run:

```powershell
npm test -- test/ui-contract.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```powershell
git add public/index.html public/app.js public/style.css test/ui-contract.test.js
git commit -m "feat: expose team workspace pane metadata"
```

## Task 2: Session-Aware Team Lifecycle Notices

**Files:**
- Modify: `test/web-server.test.js`
- Modify: `server/web-server.js`

- [ ] **Step 1: Write the failing route test**

Add a test to `test/web-server.test.js` near the existing split team dispatch tests:

```js
test('team split dispatch publishes worker notices to worker sessions and final notices to leader session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-api-'));
  let taskIndex = 0;
  const teamStore = new TeamStore(root, {
    profiles: {
      echo: { label: 'Echo', mode: 'echo' }
    },
    taskIdFactory: () => `task-session-notice-${++taskIndex}`
  });
  const manager = createFakeManager();
  const agentAdapter = createFakeAgentAdapter();
  const { server } = createWebServer({
    sessionManager: manager,
    teamStore,
    agentAdapter,
    config: { token: 'secret', publicDir: process.cwd() }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    await teamStore.addRosterAgent({ profileId: 'echo', agentId: 'echo1', session: 'echo1' });
    await teamStore.addRosterAgent({ profileId: 'echo', agentId: 'echo2', session: 'echo2' });
    const task = await teamStore.createTask({
      title: 'Session notice routing',
      prompt: '@team ask @echo2 to inspect files, then produce one delivery',
      createdBy: 'codex',
      assignedTo: '@team'
    });

    const dispatchResponse = await fetch(`${base}/api/team/tasks/${task.taskId}/dispatch`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({})
    });

    assert.equal(dispatchResponse.status, 200);
    assert.equal(manager.systemMessages.some((message) => (
      message.name === 'echo2' && /\[team running\] task-session-notice-2/.test(message.data)
    )), true);
    assert.equal(manager.systemMessages.some((message) => (
      message.name === 'echo2' && /\[team completed\] task-session-notice-2/.test(message.data)
    )), true);
    assert.equal(manager.systemMessages.some((message) => (
      message.name === 'echo1' && /\[team completed\] task-session-notice-1/.test(message.data)
    )), true);
    assert.equal(manager.systemMessages.some((message) => (
      message.name === 'main' && /\[team running\] task-session-notice-2/.test(message.data)
    )), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the route test and verify RED**

Run:

```powershell
npm test -- test/web-server.test.js --test-name-pattern "team split dispatch publishes worker notices"
```

Expected: FAIL because current dispatch passes the parent `terminalSession` to child worker execution and worker notices can land in `main`.

- [ ] **Step 3: Implement minimal session routing**

Modify `server/web-server.js`:

```js
function agentSession(agent = {}) {
  return agent.session || agent.agentId || null;
}

function taskNoticeSession(task = {}, agent = {}, fallback = 'main') {
  return task.terminalSession ||
    task.session ||
    agentSession(agent) ||
    task.claimedBy ||
    task.assignedTo ||
    task.leaderAgentId ||
    fallback;
}
```

Update `runDirectTeamTask()` to publish using the task/agent session:

```js
const noticeSession = taskNoticeSession(task, agent, terminalSession || 'main');
await publishTeamTaskNotice(sessionManager, noticeSession, runningTask);
...
await publishTeamTaskNotice(sessionManager, noticeSession, completedTask);
...
await publishTeamTaskNotice(sessionManager, noticeSession, failedTask);
```

Update `dispatchSplitTeamTask()` so child workers do not inherit the parent
session:

```js
const completedChild = await runDirectTeamTask({
  teamStore,
  agentAdapter,
  sessionManager,
  task: childTask,
  agent: worker,
  terminalSession: agentSession(worker) || terminalSession
});
```

For parent running/completed/failed notices, use the leader session first:

```js
const leaderSession = agentSession(leaderAgent) || terminalSession || 'main';
await publishTeamTaskNotice(sessionManager, leaderSession, runningParent);
...
await publishTeamTaskNotice(sessionManager, leaderSession, completedParent);
...
await publishTeamTaskNotice(sessionManager, leaderSession, failedParent);
```

- [ ] **Step 4: Run the route test and verify GREEN**

Run:

```powershell
npm test -- test/web-server.test.js --test-name-pattern "team split dispatch publishes worker notices"
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:

```powershell
git add server/web-server.js test/web-server.test.js
git commit -m "feat: route team notices to agent sessions"
```

## Task 3: Team Workspace Smoke Script

**Files:**
- Create: `scripts/smoke-team-workspace.ps1`
- Modify: `package.json`

- [ ] **Step 1: Write the smoke script**

Create `scripts/smoke-team-workspace.ps1`:

```powershell
param(
  [string]$BaseUrl = "http://127.0.0.1:7842",
  [string]$Token = $env:SHARETERMINAL_TOKEN
)

$ErrorActionPreference = "Stop"
if (-not $Token) {
  $tokenFile = Join-Path (Split-Path -Parent $PSScriptRoot) ".tmp\shareterminal-token.txt"
  if (Test-Path -LiteralPath $tokenFile) {
    $Token = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
  }
}
if (-not $Token) {
  throw "SHARETERMINAL_TOKEN is required or .tmp\shareterminal-token.txt must exist."
}

$headers = @{ Authorization = "Bearer $Token" }
$jsonHeaders = @{ Authorization = "Bearer $Token"; "Content-Type" = "application/json" }

function Invoke-JsonPost($Uri, $Body) {
  Invoke-RestMethod -Method Post -Uri $Uri -Headers $jsonHeaders -Body ($Body | ConvertTo-Json -Depth 8)
}

Invoke-JsonPost "$BaseUrl/api/team/roster/agents" @{ profileId = "echo"; agentId = "echo1"; role = "leader" } | Out-Null
Invoke-JsonPost "$BaseUrl/api/team/roster/agents" @{ profileId = "echo"; agentId = "echo2"; role = "worker" } | Out-Null
Invoke-JsonPost "$BaseUrl/api/team/roster/agents" @{ profileId = "echo"; agentId = "echo3"; role = "worker" } | Out-Null

$roster = Invoke-RestMethod -Uri "$BaseUrl/api/team/roster"
if (($roster.roster | Where-Object { $_.status -ne "removed" }).Count -lt 3) {
  throw "Expected at least three active roster agents."
}

$task = Invoke-JsonPost "$BaseUrl/api/team/tasks" @{
  title = "Smoke team workspace"
  prompt = "@team ask @echo2 and @echo3 to inspect separate files, then produce one checked delivery"
  assignedTo = "@team"
  createdBy = "smoke"
}

$dispatch = Invoke-JsonPost "$BaseUrl/api/team/tasks/$($task.task.taskId)/dispatch" @{}
if ($dispatch.task.status -ne "completed") {
  throw "Expected completed task, got $($dispatch.task.status)."
}

$trace = Invoke-RestMethod -Uri "$BaseUrl/api/team/trace/$($task.task.taskId)"
if (-not $trace.trace.events -or $trace.trace.events.Count -lt 1) {
  throw "Expected trace events."
}

$inbox = Invoke-RestMethod -Uri "$BaseUrl/api/team/inbox"
[pscustomobject]@{
  ok = $true
  taskId = $dispatch.task.taskId
  rosterCount = ($roster.roster | Where-Object { $_.status -ne "removed" }).Count
  traceEvents = $trace.trace.events.Count
  inboxItems = $inbox.items.Count
} | ConvertTo-Json -Depth 5
```

- [ ] **Step 2: Add package script**

Add to `package.json` scripts:

```json
"smoke:team-workspace": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-team-workspace.ps1"
```

- [ ] **Step 3: Run syntax checks**

Run:

```powershell
npm run check
```

Expected: PASS.

- [ ] **Step 4: Commit Task 3**

Run:

```powershell
git add package.json scripts/smoke-team-workspace.ps1
git commit -m "test: add team workspace smoke script"
```

## Task 4: Full Verification

**Files:**
- No planned source edits.

- [ ] **Step 1: Run static checks**

Run:

```powershell
npm run check
```

Expected: PASS.

- [ ] **Step 2: Run full tests**

Run:

```powershell
npm test
```

Expected: PASS with all tests passing.

- [ ] **Step 3: Run focused smoke if server is already running**

Run only if `http://127.0.0.1:7842` is available:

```powershell
npm run smoke:team-workspace
```

Expected: JSON with `"ok": true`.

- [ ] **Step 4: Inspect final git state**

Run:

```powershell
git status --short --branch
git log --oneline -6
```

Expected: branch is ahead by the new local commits and has no unstaged changes.
