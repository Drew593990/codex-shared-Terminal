# ShareTerminal Agent Startup Guide

This guide is for local agents such as openclaw, Codex, opencode, Claude Code,
or other CLI automation that need to attach to ShareTerminal.

ShareTerminal runs locally at `http://127.0.0.1:7842`. It exposes two control
planes:

- raw terminal sessions under `/api/sessions`;
- structured direct agent turns under `/api/agents` and `/api/conversations`.

Use the structured direct API when the caller needs clean prompt/reply turns.
Use the raw terminal API when the caller needs to type into the visible TUI
session that the user is watching.

## Quick Start

Run this from PowerShell:

```powershell
Set-Location <repo>
.\scripts\quick-start.ps1
```

The script is idempotent:

- if ShareTerminal is already listening on `127.0.0.1:7842`, it reuses it;
- if it is not running, it starts it in a hidden PowerShell process;
- it waits until `/api/sessions` responds;
- it prints JSON for agents to parse.

Example parsed use:

```powershell
$share = .\scripts\quick-start.ps1 | ConvertFrom-Json
$share.baseUrl
$share.token
$share.endpoints.agentTurns
```

To force a restart:

```powershell
.\scripts\quick-start.ps1 -Restart
```

To start and open the browser:

```powershell
.\scripts\quick-start.ps1 -OpenBrowser
```

## JSON Contract

`quick-start.ps1` returns a JSON object with these stable fields:

```json
{
  "ok": true,
  "started": false,
  "baseUrl": "http://127.0.0.1:7842",
  "browserUrl": "http://127.0.0.1:7842/",
  "token": "<generated-local-token>",
  "root": "<repo>",
  "processId": 11780,
  "logs": {
    "stdout": "<repo>\\.tmp\\shareterminal-server-7842.out.log",
    "stderr": "<repo>\\.tmp\\shareterminal-server-7842.err.log"
  },
  "storage": {
    "transcripts": "<repo>\\data\\transcripts",
    "conversations": "<repo>\\data\\conversations"
  },
  "endpoints": {
    "profiles": "http://127.0.0.1:7842/api/profiles",
    "agents": "http://127.0.0.1:7842/api/agents",
    "sessions": "http://127.0.0.1:7842/api/sessions",
    "sessionInput": "http://127.0.0.1:7842/api/sessions/{session}/input",
    "sessionTranscript": "http://127.0.0.1:7842/api/sessions/{session}/transcript",
    "agentTurns": "http://127.0.0.1:7842/api/agents/{agent}/turns",
    "conversationTurns": "http://127.0.0.1:7842/api/conversations/{conversationId}/turns",
    "teamAgentInbox": "http://127.0.0.1:7842/api/team/agents/{agentId}/inbox",
    "teamTasks": "http://127.0.0.1:7842/api/team/tasks",
    "teamTaskClaim": "http://127.0.0.1:7842/api/team/tasks/{taskId}/claim",
    "teamTaskHeartbeat": "http://127.0.0.1:7842/api/team/tasks/{taskId}/heartbeat",
    "teamTaskNeedsUser": "http://127.0.0.1:7842/api/team/tasks/{taskId}/needs-user",
    "teamTaskResume": "http://127.0.0.1:7842/api/team/tasks/{taskId}/resume",
    "teamTaskComplete": "http://127.0.0.1:7842/api/team/tasks/{taskId}/complete",
    "teamTaskFail": "http://127.0.0.1:7842/api/team/tasks/{taskId}/fail",
    "teamTaskRecoverStale": "http://127.0.0.1:7842/api/team/tasks/recover-stale",
    "teamMessages": "http://127.0.0.1:7842/api/team/messages",
    "teamTrace": "http://127.0.0.1:7842/api/team/trace/{id}"
  }
}
```

Agents should treat `baseUrl`, `token`, and `endpoints` as the primary contract.

## Direct Conversation API

List configured direct agents:

```powershell
$share = .\scripts\quick-start.ps1 | ConvertFrom-Json
Invoke-RestMethod -Uri $share.endpoints.agents
```

Create a structured turn:

```powershell
$share = .\scripts\quick-start.ps1 | ConvertFrom-Json
$body = @{
  conversationId = 'openclaw-smoke'
  prompt = 'Reply exactly: OPENCLAW_OK'
  terminalSession = 'main'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$($share.baseUrl)/api/agents/echo/turns" `
  -Headers @{ Authorization = "Bearer $($share.token)" } `
  -ContentType 'application/json' `
  -Body $body
```

Read the clean history:

```powershell
Invoke-RestMethod -Uri "$($share.baseUrl)/api/conversations/openclaw-smoke/turns"
```

For real local CLIs, replace `echo` with `opencode` or `claude`.

When a direct turn runs, ShareTerminal writes server-side system records into the
selected terminal session:

```text
[opencode running] turn_...
> prompt...
running...
[opencode completed] turn_...
> prompt...
reply...
```

The browser terminal and the raw transcript both see these records.

## Team Work API

Use this path when an external local agent is participating in the Phase 2 team
layer rather than only running one direct prompt.

Read the agent's assigned tasks, pending messages, and shared context:

```powershell
$share = .\scripts\quick-start.ps1 | ConvertFrom-Json
Invoke-RestMethod -Uri "$($share.baseUrl)/api/team/agents/echo1/inbox"
```

The inbox response includes:

- `agent`: the roster entry for this participant;
- `tasks`: queued work this agent can claim;
- `items`: unread inbox items such as user-input requests or completed results;
- `messages`: pending inter-agent messages;
- `context`: shared roster, leader, active tasks, recent messages, and notes;
- `terminal`: the visible session name, profile id, active session metadata, and
  recent transcript records for that agent's terminal pane.

The roster `agent` record includes a `workspace` plan:

- `workspace.mode = "shared"` means use the shared server cwd;
- `workspace.mode = "isolated"` means the intended per-agent checkout is
  `workspace.path`, with planned branch `workspace.branch`;
- `workspace.mode = "none"` means the agent should not assume a filesystem
  workspace.

In the current slice, isolated workspaces are only planned metadata. Agents
should not assume the directory already exists until a later worktree creation
step marks it ready.

The shared `context` also includes a runtime envelope:

- `workspace.projectRoot` and `workspace.cwd`: the local project boundary and
  working directory known to the ShareTerminal server;
- `runtime.platform`, `runtime.shell`, and `runtime.pid`: local process summary
  for environment-aware agents;
- `git.available`, `git.branch`, `git.commit`, `git.dirty`, and
  `git.changedFiles`: current repository summary when `git` is available from
  the configured workspace;
- `terminalSessions`: currently visible or initialized terminal sessions,
  including session name, command, args, cwd, client count, and created time
  when available.

If the workspace is not a git checkout or `git` cannot be executed,
`context.git.available` is `false` and `context.git.error` contains the local
failure message.

Claim a queued task before working on it:

```powershell
$body = @{
  agentId = 'echo1'
  mode = 'external'
  leaseMs = 120000
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$($share.baseUrl)/api/team/tasks/<taskId>/claim" `
  -Headers @{ Authorization = "Bearer $($share.token)" } `
  -ContentType 'application/json' `
  -Body $body
```

Send heartbeats while the task is running:

```powershell
$body = @{
  agentId = 'echo1'
  leaseMs = 120000
  note = 'still working'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$($share.baseUrl)/api/team/tasks/<taskId>/heartbeat" `
  -Headers @{ Authorization = "Bearer $($share.token)" } `
  -ContentType 'application/json' `
  -Body $body
```

Pause for user input when the agent cannot continue safely:

```powershell
$body = @{
  agentId = 'echo1'
  question = 'Please confirm which file should be edited before I continue.'
  reason = 'missing user decision'
  terminalSession = 'main'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$($share.baseUrl)/api/team/tasks/<taskId>/needs-user" `
  -Headers @{ Authorization = "Bearer $($share.token)" } `
  -ContentType 'application/json' `
  -Body $body
```

This changes the task to `needs_user`, releases the active claim, writes a
`user_request` item to the team inbox, records a trace event, and publishes a
compact notice into the visible terminal transcript.

Resume the task after the user answers:

```powershell
$body = @{
  resumedBy = 'user'
  answer = 'Edit server/team-store.js and keep public/app.js as the only UI change.'
  terminalSession = 'main'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$($share.baseUrl)/api/team/tasks/<taskId>/resume" `
  -Headers @{ Authorization = "Bearer $($share.token)" } `
  -ContentType 'application/json' `
  -Body $body
```

The response is stored as a shared context note and the task returns to
`queued`, so an agent can claim it again with the updated context.

Submit a successful result:

```powershell
$body = @{
  agentId = 'echo1'
  result = 'Completed the assigned check. Evidence: tests passed.'
  turnId = 'optional-local-turn-id'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$($share.baseUrl)/api/team/tasks/<taskId>/complete" `
  -Headers @{ Authorization = "Bearer $($share.token)" } `
  -ContentType 'application/json' `
  -Body $body
```

Submit a failure that should be retryable:

```powershell
$body = @{
  agentId = 'echo1'
  error = 'The command failed before producing a result.'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$($share.baseUrl)/api/team/tasks/<taskId>/fail" `
  -Headers @{ Authorization = "Bearer $($share.token)" } `
  -ContentType 'application/json' `
  -Body $body
```

Completed and failed submissions create inbox items and trace events. If the
task has a separate leader, ShareTerminal also sends a handoff message to the
leader's team inbox.

Trace a task from any visible team record:

```powershell
Invoke-RestMethod -Uri "$($share.baseUrl)/api/team/trace/<taskId-or-messageId-or-inboxId>"
```

The trace response resolves `messageId` and `inboxId` values back to their
owning task when those records carry a `taskId`. It returns the resolved `task`,
related `tasks`, timeline `events`, and the matched `message` or `inboxItem`
when applicable.

If an agent crashes or stops heartbeating, a coordinator can return expired work
to the queue:

```powershell
$body = @{
  staleBefore = (Get-Date).ToUniversalTime().ToString('o')
  reason = 'agent heartbeat expired'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$($share.baseUrl)/api/team/tasks/recover-stale" `
  -Headers @{ Authorization = "Bearer $($share.token)" } `
  -ContentType 'application/json' `
  -Body $body
```

Claiming and heartbeat are for external agents that manage their own execution.
For ShareTerminal-managed direct turns, use `/api/team/tasks/{taskId}/dispatch`
or `/api/agents/{agent}/turns`.

## Raw Visible Terminal API

Use this path when an agent must type into the same visible TUI session the user
is watching.

List sessions:

```powershell
$share = .\scripts\quick-start.ps1 | ConvertFrom-Json
Invoke-RestMethod -Uri $share.endpoints.sessions
```

Send input to the default PowerShell session:

```powershell
$body = @{ input = "Write-Output `"HELLO_FROM_AGENT`"`r" } | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$($share.baseUrl)/api/sessions/main/input" `
  -Headers @{ Authorization = "Bearer $($share.token)" } `
  -ContentType 'application/json' `
  -Body $body
```

Send input to visible Claude Code TUI:

```powershell
$body = @{ input = "Reply exactly: CLAUDE_TUI_OK`r" } | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$($share.baseUrl)/api/sessions/claude/input" `
  -Headers @{ Authorization = "Bearer $($share.token)" } `
  -ContentType 'application/json' `
  -Body $body
```

Read raw terminal transcript:

```powershell
Invoke-RestMethod -Uri "$($share.baseUrl)/api/sessions/claude/transcript?limit=80"
```

Raw transcripts contain ANSI control sequences because they preserve TUI output.
For clean prompt/reply automation, use the Direct Conversation API instead.

## Configuration

`quick-start.ps1` accepts:

```powershell
.\scripts\quick-start.ps1 `
  -HostName 127.0.0.1 `
  -Port 7842 `
  -Token '<your-local-token>'
```

It also honors these environment variables:

- `SHARETERMINAL_HOST`
- `SHARETERMINAL_PORT`
- `SHARETERMINAL_TOKEN`

Project-local agent registry overrides can be stored at
`<repo>\.shareterminal\agents.json`:

```json
{
  "agentProfiles": {
    "opencode": {
      "enabled": false
    },
    "researcher": {
      "label": "Research Agent",
      "mode": "command",
      "command": "research-cli",
      "args": ["run"],
      "promptMode": "stdin",
      "capabilities": ["research"],
      "worktreeMode": "isolated"
    }
  }
}
```

Built-in profiles can be overridden by id. New profiles become available through
`/api/team/agents`. Unknown or disabled profiles cannot be added to the active
team roster.

Runtime files stay under the project root:

- logs: `<repo>\.tmp`;
- transcripts: `<repo>\data\transcripts`;
- structured turns: `<repo>\data\conversations`;
- npm cache: `<repo>\npm-cache`;
- node-gyp cache: `<repo>\.node-gyp`.

## Minimal Agent Algorithm

1. Run `<repo>\scripts\quick-start.ps1`.
2. Parse JSON from stdout.
3. Use `baseUrl` and `token` for authenticated write calls.
4. Prefer `/api/agents/{agent}/turns` for clean agent conversations.
5. Use `/api/sessions/{session}/input` only when controlling a visible terminal.
6. Read `/api/conversations/{conversationId}/turns` or
   `/api/sessions/{session}/transcript` to continue from prior state.
7. For team participation, poll `/api/team/agents/{agentId}/inbox`, claim a
   queued task, heartbeat while working, submit completion or failure, and let
   stale recovery return expired work to the queue.

Team prompts can address either a concrete instance or an existing profile:

- `@echo2`, `@opencode1`, or `@claude-code1` target that exact roster instance;
- `@leader` targets the current leader;
- `@team` sends the request to the leader and lets dispatch split mentioned
  worker tasks;
- `@echo`, `@opencode`, or another profile id is preserved in `mentions` and
  resolved into `mentionRoutes` when an idle matching roster instance exists.

Profile mentions do not create a new agent. Add the agent to the roster first,
then dispatch the task.
