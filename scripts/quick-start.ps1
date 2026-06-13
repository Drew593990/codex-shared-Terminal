param(
  [string]$HostName = $env:SHARETERMINAL_HOST,
  [int]$Port = 0,
  [string]$Token = $env:SHARETERMINAL_TOKEN,
  [switch]$Restart,
  [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($HostName)) {
  $HostName = '127.0.0.1'
}
if ($Port -le 0) {
  if ($env:SHARETERMINAL_PORT) {
    $Port = [int]$env:SHARETERMINAL_PORT
  } else {
    $Port = 7842
  }
}

$root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')
$tmp = Join-Path $root '.tmp'
$npmCache = Join-Path $root 'npm-cache'
$nodeGypCache = Join-Path $root '.node-gyp'
$tokenFile = Join-Path $tmp 'shareterminal-token.txt'
$baseUrl = "http://$HostName`:$Port"
$outLog = Join-Path $tmp "shareterminal-server-$Port.out.log"
$errLog = Join-Path $tmp "shareterminal-server-$Port.err.log"

function New-ShareTerminalToken {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-ShareTerminalListener {
  Get-NetTCPConnection -LocalAddress $HostName -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

function Get-ProcessCommandLine([int]$ProcessId) {
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if ($processInfo) {
    return $processInfo.CommandLine
  }
  return ''
}

function Test-ShareTerminalApi {
  try {
    Invoke-RestMethod -Uri "$baseUrl/api/sessions" -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Wait-ShareTerminalApi {
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    if (Test-ShareTerminalApi) {
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw "ShareTerminal did not become ready at $baseUrl within 20 seconds. Check $errLog"
}

New-Item -ItemType Directory -Force -Path $tmp, $npmCache, $nodeGypCache | Out-Null

if ([string]::IsNullOrWhiteSpace($Token)) {
  if (Test-Path -LiteralPath $tokenFile) {
    $Token = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
  }
  if ([string]::IsNullOrWhiteSpace($Token)) {
    $Token = New-ShareTerminalToken
    Set-Content -LiteralPath $tokenFile -Value $Token -NoNewline
  }
}

$listener = Get-ShareTerminalListener
if ($listener -and $Restart) {
  $commandLine = Get-ProcessCommandLine -ProcessId $listener.OwningProcess
  if ($commandLine -notmatch 'server[\\/]index\.js') {
    throw "Port $Port is owned by PID $($listener.OwningProcess), but it does not look like ShareTerminal: $commandLine"
  }
  Stop-Process -Id $listener.OwningProcess -Force
  Start-Sleep -Milliseconds 500
  $listener = Get-ShareTerminalListener
}

$started = $false
if (-not $listener) {
  $env:TEMP = $tmp
  $env:TMP = $tmp
  $env:NPM_CONFIG_CACHE = $npmCache
  $env:npm_config_cache = $npmCache
  $env:npm_config_devdir = $nodeGypCache
  $env:SHARETERMINAL_HOST = $HostName
  $env:SHARETERMINAL_PORT = [string]$Port
  $env:SHARETERMINAL_TOKEN = $Token

  $serverScript = Join-Path $root 'server\index.js'
  $startCommand = "node.exe `"$serverScript`" > `"$outLog`" 2> `"$errLog`""
  Start-Process `
    -FilePath 'cmd.exe' `
    -ArgumentList @('/d', '/s', '/c', $startCommand) `
    -WorkingDirectory $root `
    -WindowStyle Hidden | Out-Null
  $started = $true
}

Wait-ShareTerminalApi
$listener = Get-ShareTerminalListener
$sessions = Invoke-RestMethod -Uri "$baseUrl/api/sessions"
$agents = Invoke-RestMethod -Uri "$baseUrl/api/agents"

if ($OpenBrowser) {
  Start-Process $baseUrl | Out-Null
}

[pscustomobject]@{
  ok = $true
  started = $started
  baseUrl = $baseUrl
  browserUrl = "$baseUrl/"
  token = $Token
  root = [string]$root
  processId = $listener.OwningProcess
  logs = @{
    stdout = $outLog
    stderr = $errLog
  }
  storage = @{
    transcripts = (Join-Path $root 'data\transcripts')
    conversations = (Join-Path $root 'data\conversations')
    temp = $tmp
    npmCache = $npmCache
    nodeGypCache = $nodeGypCache
  }
  endpoints = @{
    profiles = "$baseUrl/api/profiles"
    agents = "$baseUrl/api/agents"
    sessions = "$baseUrl/api/sessions"
    sessionInput = "$baseUrl/api/sessions/{session}/input"
    sessionTranscript = "$baseUrl/api/sessions/{session}/transcript"
    agentTurns = "$baseUrl/api/agents/{agent}/turns"
    conversationTurns = "$baseUrl/api/conversations/{conversationId}/turns"
    teamAgentInbox = "$baseUrl/api/team/agents/{agentId}/inbox"
    teamTasks = "$baseUrl/api/team/tasks"
    teamTaskClaim = "$baseUrl/api/team/tasks/{taskId}/claim"
    teamTaskHeartbeat = "$baseUrl/api/team/tasks/{taskId}/heartbeat"
    teamTaskNeedsUser = "$baseUrl/api/team/tasks/{taskId}/needs-user"
    teamTaskResume = "$baseUrl/api/team/tasks/{taskId}/resume"
    teamTaskComplete = "$baseUrl/api/team/tasks/{taskId}/complete"
    teamTaskFail = "$baseUrl/api/team/tasks/{taskId}/fail"
    teamTaskRecoverStale = "$baseUrl/api/team/tasks/recover-stale"
    teamMessages = "$baseUrl/api/team/messages"
    teamTrace = "$baseUrl/api/team/trace/{id}"
  }
  examples = @{
    directEcho = "Invoke-RestMethod -Method Post -Uri '$baseUrl/api/agents/echo/turns' -Headers @{ Authorization = 'Bearer $Token' } -ContentType 'application/json' -Body '{""conversationId"":""agent-smoke"",""prompt"":""Reply exactly: OK"",""terminalSession"":""main""}'"
    rawTerminalInput = "Invoke-RestMethod -Method Post -Uri '$baseUrl/api/sessions/main/input' -Headers @{ Authorization = 'Bearer $Token' } -ContentType 'application/json' -Body '{""input"":""Write-Output \""hello from agent\""\r""}'"
  }
  sessions = $sessions.sessions
  agents = $agents.agents
} | ConvertTo-Json -Depth 8
