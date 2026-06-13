$ErrorActionPreference = 'Stop'

$root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')
$tmp = Join-Path $root '.tmp'
$npmCache = Join-Path $root 'npm-cache'
$nodeGypCache = Join-Path $root '.node-gyp'
$tokenFile = Join-Path $tmp 'shareterminal-token.txt'

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

New-Item -ItemType Directory -Force -Path $tmp, $npmCache, $nodeGypCache | Out-Null

if ([string]::IsNullOrWhiteSpace($env:SHARETERMINAL_TOKEN)) {
  if (Test-Path -LiteralPath $tokenFile) {
    $env:SHARETERMINAL_TOKEN = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
  }
  if ([string]::IsNullOrWhiteSpace($env:SHARETERMINAL_TOKEN)) {
    $env:SHARETERMINAL_TOKEN = New-ShareTerminalToken
    Set-Content -LiteralPath $tokenFile -Value $env:SHARETERMINAL_TOKEN -NoNewline
  }
}

$env:TEMP = $tmp
$env:TMP = $tmp
$env:NPM_CONFIG_CACHE = $npmCache
$env:npm_config_cache = $npmCache
$env:npm_config_devdir = $nodeGypCache

Set-Location -LiteralPath $root
npm start
