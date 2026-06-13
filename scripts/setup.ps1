$ErrorActionPreference = 'Stop'

$root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')
$tmp = Join-Path $root '.tmp'
$npmCache = Join-Path $root 'npm-cache'
$nodeGypCache = Join-Path $root '.node-gyp'

New-Item -ItemType Directory -Force -Path $tmp, $npmCache, $nodeGypCache | Out-Null

$env:TEMP = $tmp
$env:TMP = $tmp
$env:NPM_CONFIG_CACHE = $npmCache
$env:npm_config_cache = $npmCache
$env:npm_config_devdir = $nodeGypCache

Set-Location -LiteralPath $root
npm install

