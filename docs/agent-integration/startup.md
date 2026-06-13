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
    "conversationTurns": "http://127.0.0.1:7842/api/conversations/{conversationId}/turns"
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
