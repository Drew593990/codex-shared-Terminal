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

$jsonHeaders = @{
  Authorization = "Bearer $Token"
  "Content-Type" = "application/json"
}

function Invoke-JsonPost($Uri, $Body) {
  Invoke-RestMethod -Method Post -Uri $Uri -Headers $jsonHeaders -Body ($Body | ConvertTo-Json -Depth 8)
}

$command = Invoke-JsonPost "$BaseUrl/api/team/commands/mention" @{
  input = "@echo inspect startup docs and report one short result"
  terminalSession = "main"
}

if (-not $command.ok) {
  throw "Mention command did not return ok."
}

if ($command.agent.profileId -ne "echo") {
  throw "Expected echo agent, got $($command.agent.profileId)."
}

if ($command.task.status -ne "completed") {
  throw "Expected completed task, got $($command.task.status)."
}

$roster = Invoke-RestMethod -Uri "$BaseUrl/api/team/roster"
$activeAgent = $roster.roster | Where-Object {
  $_.agentId -eq $command.agent.agentId -and $_.status -ne "removed"
} | Select-Object -First 1
if (-not $activeAgent) {
  throw "Expected active roster agent $($command.agent.agentId)."
}

$trace = Invoke-RestMethod -Uri "$BaseUrl/api/team/trace/$($command.task.taskId)"
if (-not $trace.trace.events -or $trace.trace.events.Count -lt 1) {
  throw "Expected trace events for $($command.task.taskId)."
}

$inbox = Invoke-RestMethod -Uri "$BaseUrl/api/team/inbox"

[pscustomobject]@{
  ok = $true
  agentId = $command.agent.agentId
  profileId = $command.agent.profileId
  taskId = $command.task.taskId
  taskStatus = $command.task.status
  traceEvents = $trace.trace.events.Count
  inboxItems = $inbox.items.Count
} | ConvertTo-Json -Depth 5
