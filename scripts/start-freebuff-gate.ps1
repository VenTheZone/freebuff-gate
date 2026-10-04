# Starts the local Freebuff Gate proxy and connector in the signed-in user's
# session. The Docker relay and Tailscale Serve have their own persistence.
$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$base = Join-Path $env:LOCALAPPDATA 'Freebuff'
$proxy = Join-Path $base 'tailnet-proxy\freebuff_tailnet_proxy.js'
$agent = Join-Path $base 'mobile-connect\freebuff-mobile-connect.js'

if (-not (Test-Path -LiteralPath $node)) { exit 1 }
if (-not (Test-Path -LiteralPath $proxy)) { exit 1 }
if (-not (Test-Path -LiteralPath $agent)) { exit 1 }

$proxyListening = Get-NetTCPConnection -State Listen -LocalPort 58061 -ErrorAction SilentlyContinue
if (-not $proxyListening) {
    Start-Process -FilePath $node -ArgumentList ('"' + $proxy + '"') -WindowStyle Hidden
}

$agentRunning = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'freebuff-mobile-connect\.js.*serve' }
if (-not $agentRunning) {
    Start-Process -FilePath $node -ArgumentList @('"' + $agent + '"', 'serve') -WindowStyle Hidden
}
