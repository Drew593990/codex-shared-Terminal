param(
  [string]$BaseUrl = "http://127.0.0.1:7842",
  [string]$Token = $env:SHARETERMINAL_TOKEN
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not $Token) {
  $tokenFile = Join-Path $repoRoot ".tmp\shareterminal-token.txt"
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

function Invoke-JsonPost {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][hashtable]$Body
  )
  Invoke-RestMethod -Method Post -Uri $Uri -Headers $jsonHeaders -Body ($Body | ConvertTo-Json -Depth 8)
}

function Ensure-Agent {
  param(
    [Parameter(Mandatory = $true)][string]$ProfileId,
    [Parameter(Mandatory = $true)][string]$AgentId,
    [Parameter(Mandatory = $true)][string]$Role
  )
  $existingRoster = Invoke-RestMethod -Uri "$BaseUrl/api/team/roster"
  $existingAgent = $existingRoster.roster | Where-Object {
    $_.agentId -eq $AgentId -and $_.status -ne "removed"
  } | Select-Object -First 1
  if ($existingAgent) {
    return
  }
  Invoke-JsonPost "$BaseUrl/api/team/roster/agents" @{
    profileId = $ProfileId
    agentId = $AgentId
    role = $Role
  } | Out-Null
}

Ensure-Agent -ProfileId "echo" -AgentId "echo1" -Role "leader"
Ensure-Agent -ProfileId "echo" -AgentId "echo2" -Role "worker"
Ensure-Agent -ProfileId "echo" -AgentId "echo3" -Role "worker"

$roster = Invoke-RestMethod -Uri "$BaseUrl/api/team/roster"
$activeRoster = @($roster.roster | Where-Object { $_.status -ne "removed" })
if ($activeRoster.Count -lt 3) {
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
  rosterCount = $activeRoster.Count
  traceEvents = $trace.trace.events.Count
  inboxItems = $inbox.items.Count
} | ConvertTo-Json -Depth 5
