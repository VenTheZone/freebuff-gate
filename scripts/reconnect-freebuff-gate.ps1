$ErrorActionPreference = 'Stop'
$base = Join-Path $env:LOCALAPPDATA 'Freebuff'
$startup = Join-Path $PSScriptRoot 'start-freebuff-gate.ps1'
if (-not (Test-Path -LiteralPath $startup)) { throw 'Startup script not found' }
$desktopDir = if ($env:FREEBUFF_DESKTOP_DIR) { $env:FREEBUFF_DESKTOP_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\@codebufffreebuff-desktop' }
$exe = Join-Path $desktopDir 'Freebuff.exe'
if (-not (Get-Process Freebuff -ErrorAction SilentlyContinue)) {
    if (-not (Test-Path -LiteralPath $exe)) { throw 'Freebuff Desktop not found' }
    Start-Process -FilePath $exe
    Write-Output 'Freebuff Desktop iniciado'
}

$processes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -match 'Freebuff[\\/]tailnet-proxy[\\/]freebuff_tailnet_proxy\.js' -or
        $_.CommandLine -match 'Freebuff[\\/]mobile-connect[\\/]freebuff-mobile-connect\.js.*serve'
    }
foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId -ErrorAction Stop
}
Start-Sleep -Seconds 1
& $startup

$gateTokenFile = Join-Path $env:USERPROFILE '.config\freebuff\gate-proxy.token'
if (-not (Test-Path -LiteralPath $gateTokenFile)) { throw 'Gate token not found' }
$gateToken = [IO.File]::ReadAllText($gateTokenFile).Trim()
for ($attempt = 0; $attempt -lt 12; $attempt++) {
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:58061/api/projects' -UseBasicParsing -TimeoutSec 3 -Headers @{ 'x-fb-gate' = $gateToken }
        $relay = Invoke-RestMethod -Uri 'http://127.0.0.1:8795/healthz' -TimeoutSec 3
        if ($response.StatusCode -eq 200 -and $relay.ok -and $relay.connectors -ge 1) {
            Write-Output 'READY: proxy API 200; connector online'
            exit 0
        }
    } catch { }
    Start-Sleep -Seconds 2
}
throw 'Connection did not become ready after reconnect'
