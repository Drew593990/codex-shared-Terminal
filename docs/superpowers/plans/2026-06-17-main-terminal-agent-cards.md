# Main Terminal Agent Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the equal terminal-pane grid with one main terminal command surface and a child agent card workspace that can add/remove local CLI agents, show structured dialogue/results, expand raw CLI evidence, and react to main-terminal `@agent` commands.

**Architecture:** Keep the existing Node/Express/team-store backend. Refactor the browser UI so `main` is the only default xterm surface, roster agents render as structured cards below it, and cards remain linked to existing task/message/inbox/trace APIs. Add a small backend endpoint that turns a main-terminal mention command into "ensure matching agent, create task, dispatch, return updated task/agent state" so the terminal can be the command hub.

**Tech Stack:** Node.js, Express, WebSocket, xterm.js, vanilla browser JavaScript, PowerShell smoke tests, `node:test`.

---

## File Structure

- Modify `test/ui-contract.test.js`: assert the corrected UI contract: main terminal region, agent card workspace, add/remove/profile controls, structured prompt/reply/result sections, expandable raw output.
- Modify `public/index.html`: restructure the page into `main-terminal-region`, `agent-workspace`, `agent-cards`, and supporting team surfaces.
- Modify `public/app.js`: keep only the main xterm mounted by default, render roster agents as cards, add remove/profile/action handlers, load raw transcript snippets into expandable sections, and intercept complete main-terminal lines that start with `@`.
- Modify `public/style.css`: replace grid-pane visual layout with a command-workspace layout and card styles.
- Modify `test/web-server.test.js`: add route coverage for a terminal mention command that auto-creates/reuses a roster agent and dispatches a task.
- Modify `server/web-server.js`: add `POST /api/team/commands/mention` for parsed terminal mention commands.
- Create `scripts/smoke-main-terminal-agent-cards.ps1`: local smoke check for the corrected workflow.
- Modify `package.json`: add `smoke:main-terminal-agent-cards`.
- Update `docs/phase2/main-terminal-agent-workspace.md`: add implementation status notes after the feature is complete.

## Task 1: UI Contract For Main Terminal Plus Agent Cards

**Files:**
- Modify: `test/ui-contract.test.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`

- [ ] **Step 1: Write the failing UI contract test**

Add assertions that require:

```js
assert.match(html, /class="workspace[^"]*command-workspace|class="command-workspace[^"]*workspace/);
assert.match(html, /id="main-terminal-region"/);
assert.match(html, /aria-label="Main command terminal"/);
assert.match(html, /id="agent-workspace"/);
assert.match(html, /aria-label="Agent card workspace"/);
assert.match(html, /id="agent-cards"/);
assert.match(html, /id="add-team-agent"/);
assert.match(app, /renderAgentCard/);
assert.match(app, /renderAgentCards/);
assert.match(app, /agent-card-reply/);
assert.match(app, /agent-card-raw/);
assert.match(app, /removeTeamAgent/);
assert.match(css, /\.main-terminal-region/);
assert.match(css, /\.agent-workspace/);
assert.match(css, /\.agent-card/);
assert.match(css, /\.agent-card-reply/);
assert.match(css, /\.agent-card-raw/);
```

- [ ] **Step 2: Run RED**

Run:

```powershell
npm test -- test/ui-contract.test.js
```

Expected: FAIL because the current page exposes an equal terminal grid and no agent card workspace.

- [ ] **Step 3: Implement minimal UI contract**

Change `public/index.html` to introduce:

```html
<section class="workspace command-workspace" aria-label="Main terminal and agent workspace">
  <section id="main-terminal-region" class="main-terminal-region" aria-label="Main command terminal">
    <section id="terminal" class="terminal main-terminal" aria-label="Shared terminal"></section>
  </section>
  <section id="agent-workspace" class="agent-workspace" aria-label="Agent card workspace">
    ...
    <section id="agent-cards" class="agent-cards" aria-label="Agent child interfaces"></section>
  </section>
</section>
```

Change `public/app.js` so roster rendering calls `renderAgentCards(roster)` instead of creating visible peer xterm panes for every agent.

Change `public/style.css` so `.terminal` contains one full-width main terminal and `.agent-workspace` holds cards.

- [ ] **Step 4: Run GREEN**

Run:

```powershell
npm test -- test/ui-contract.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add public/index.html public/app.js public/style.css test/ui-contract.test.js
git commit -m "feat: introduce main terminal agent card workspace"
```

## Task 2: Agent Card Controls And State Projection

**Files:**
- Modify: `public/app.js`
- Modify: `public/style.css`
- Modify: `test/ui-contract.test.js`

- [ ] **Step 1: Write failing contract assertions**

Assert that the UI exposes remove controls, profile selection, card status, prompt/result, and raw transcript expansion:

```js
assert.match(app, /data-agent-id/);
assert.match(app, /agent-card-status/);
assert.match(app, /agent-card-prompt/);
assert.match(app, /agent-card-result/);
assert.match(app, /loadAgentRawOutput/);
assert.match(app, /\/api\/sessions\/\$\{encodeURIComponent\(sessionName\)\}\/transcript/);
assert.match(app, /\/api\/team\/roster\/agents\/\$\{encodeURIComponent\(agent\.agentId\)\}\/remove/);
```

- [ ] **Step 2: Run RED**

Run:

```powershell
npm test -- test/ui-contract.test.js
```

Expected: FAIL until card controls and raw transcript code exist.

- [ ] **Step 3: Implement card controls**

In `public/app.js`:

- render each active roster agent as an `<article class="agent-card">`;
- show profile, role, status, active task, latest task result, latest messages;
- add `Remove` button that calls `/api/team/roster/agents/:agentId/remove`;
- add `Trace` button for the active task when present;
- add `<details class="agent-card-raw">` that loads recent transcript records for `agent.session || agent.agentId`;
- keep raw output collapsed by default.

- [ ] **Step 4: Run GREEN**

Run:

```powershell
npm test -- test/ui-contract.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add public/app.js public/style.css test/ui-contract.test.js
git commit -m "feat: render team agents as structured cards"
```

## Task 3: Main Terminal Mention Command API

**Files:**
- Modify: `test/web-server.test.js`
- Modify: `server/web-server.js`

- [ ] **Step 1: Write failing route test**

Add a test named:

```js
test('terminal mention command creates or reuses an agent card and dispatches a task', async () => { ... });
```

The test should:

- create a `TeamStore` with `echo` profile;
- call `POST /api/team/commands/mention` with `{ input: '@echo inspect docs', terminalSession: 'main' }`;
- assert response status `200`;
- assert a roster agent with `profileId: 'echo'` exists;
- assert a completed task exists with prompt containing `@echo inspect docs`;
- call the endpoint again with another `@echo` prompt and assert it reuses the same idle `echo1` agent rather than creating `echo2`.

- [ ] **Step 2: Run RED**

Run:

```powershell
npm test -- test/web-server.test.js --test-name-pattern "terminal mention command"
```

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement route**

Add `POST /api/team/commands/mention`.

Behavior:

- validate `input` is a non-empty string beginning with `@`;
- parse the first mention;
- for `@team` or `@leader`, create a task assigned to that target;
- for `@profileId`, reuse an idle active roster agent for that profile, or create one;
- for `@agentId`, use the exact active agent;
- create a task with `terminalSession` set to request body or `main`;
- dispatch it through the same direct-team dispatch path;
- publish visible notices to the main terminal and relevant agent session;
- return `{ ok: true, agent, task }`.

- [ ] **Step 4: Run GREEN**

Run:

```powershell
npm test -- test/web-server.test.js --test-name-pattern "terminal mention command"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add server/web-server.js test/web-server.test.js
git commit -m "feat: dispatch main terminal mention commands"
```

## Task 4: Browser Main-Terminal Mention Handling

**Files:**
- Modify: `public/app.js`
- Modify: `test/ui-contract.test.js`

- [ ] **Step 1: Write failing contract assertions**

Add assertions:

```js
assert.match(app, /handleMainTerminalMention/);
assert.match(app, /\/api\/team\/commands\/mention/);
assert.match(app, /mainInputBuffer/);
assert.match(app, /mainMentionCommand/);
```

- [ ] **Step 2: Run RED**

Run:

```powershell
npm test -- test/ui-contract.test.js
```

Expected: FAIL until mention handling is implemented.

- [ ] **Step 3: Implement mention handling**

For the main terminal only:

- maintain `mainInputBuffer` for printable input;
- when Enter is pressed and the current line starts with `@`, do not forward the line to PowerShell;
- call `/api/team/commands/mention` with `{ input, terminalSession: 'main' }`;
- write a compact status notice into the main terminal;
- refresh team state and trace;
- for non-mention input, forward data to the PTY unchanged.

- [ ] **Step 4: Run GREEN**

Run:

```powershell
npm test -- test/ui-contract.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add public/app.js test/ui-contract.test.js
git commit -m "feat: route main terminal mentions to agent cards"
```

## Task 5: Smoke Script And Browser Verification

**Files:**
- Create: `scripts/smoke-main-terminal-agent-cards.ps1`
- Modify: `package.json`

- [ ] **Step 1: Create smoke script**

Create a script that:

- reads `SHARETERMINAL_TOKEN` or `.tmp/shareterminal-token.txt`;
- calls `/api/team/commands/mention` with `@echo inspect startup docs`;
- verifies a roster agent exists;
- verifies task status is completed;
- verifies trace and inbox are readable;
- prints JSON with `ok`, `agentId`, `taskId`, `traceEvents`.

- [ ] **Step 2: Add package script**

Add:

```json
"smoke:main-terminal-agent-cards": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-main-terminal-agent-cards.ps1"
```

- [ ] **Step 3: Run full checks**

Run:

```powershell
npm run check
npm test
```

Expected: PASS.

- [ ] **Step 4: Run local smoke**

Start an isolated local server on a non-default port and run:

```powershell
$env:SHARETERMINAL_TOKEN='main-card-smoke-token'
npm run smoke:main-terminal-agent-cards -- --BaseUrl http://127.0.0.1:<port>
```

Expected: JSON with `"ok": true`.

- [ ] **Step 5: Browser verify**

Use the in-app browser against the local server and verify:

- `.main-terminal-region` exists;
- `.agent-workspace` exists below the main terminal;
- `.agent-card` count is at least 1 after smoke;
- `.agent-card-reply` contains structured result text;
- `.agent-card-raw` exists and is collapsed by default;
- no peer `.terminal-pane` grid is shown for roster agents.

- [ ] **Step 6: Commit and push**

```powershell
git add package.json scripts/smoke-main-terminal-agent-cards.ps1 docs/phase2/main-terminal-agent-workspace.md
git commit -m "test: add main terminal agent card smoke"
git push origin phase2
```

