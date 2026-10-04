param(
    [string]$DesktopDir = $(if ($env:FREEBUFF_DESKTOP_DIR) { $env:FREEBUFF_DESKTOP_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\@codebufffreebuff-desktop' }),
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$orchestrator = Join-Path $DesktopDir 'resources\orchestrator\orchestrator.js'
$bun = Join-Path $DesktopDir 'resources\bun\bun.exe'
$exe = Join-Path $DesktopDir 'Freebuff.exe'
$patcher = Join-Path $repoRoot 'src\patch-windows-launch-bridge.js'
$discovery = Join-Path $repoRoot 'src\discover-orchestrator.ps1'
$proxySource = Join-Path $repoRoot 'src\freebuff_tailnet_proxy.js'
$proxyDir = Join-Path $env:LOCALAPPDATA 'Freebuff\tailnet-proxy'
$startup = Join-Path $PSScriptRoot 'start-freebuff-gate.ps1'
$compose = Join-Path $repoRoot 'docker\relay\docker-compose.host-tailnet.yml'
$relayEnv = Join-Path $repoRoot 'docker\relay\.env'
$marker = '/* freebuff-gate-windows-launch-bridge */'

function Get-Sha256([string]$FilePath) {
    $stream = [IO.File]::OpenRead($FilePath)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $sha.Dispose(); $stream.Dispose() }
}

foreach ($file in @($orchestrator, $bun, $exe, $patcher, $discovery, $proxySource, $startup, $compose, $relayEnv)) {
    if (-not (Test-Path -LiteralPath $file)) { throw "Arquivo necessario ausente: $file" }
}

$needsPatch = -not ([IO.File]::ReadAllText($orchestrator).Contains($marker))
if ($needsPatch) {
    $version = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupDir = Join-Path $env:LOCALAPPDATA "FreebuffGateBackups\desktop-$version-$stamp"
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $backup = Join-Path $backupDir 'orchestrator.js'
    Copy-Item -LiteralPath $orchestrator -Destination $backup -ErrorAction Stop
    if ((Get-Sha256 $backup) -ne (Get-Sha256 $orchestrator)) {
        throw 'Backup do orchestrator nao confere; patch cancelado'
    }
    Write-Output "Backup confirmado: $backup"

    & node $patcher $DesktopDir
    if ($LASTEXITCODE -ne 0) { throw 'Patch da ponte falhou; Freebuff nao foi reiniciado' }
    $syntaxDir = Join-Path $env:LOCALAPPDATA 'Freebuff\gate-syntax-check'
    & $bun build $orchestrator --target=bun --outdir $syntaxDir
    if ($LASTEXITCODE -ne 0) {
        Copy-Item -LiteralPath $backup -Destination $orchestrator -Force
        throw 'Sintaxe invalida; original restaurado e Freebuff nao foi reiniciado'
    }
    Write-Output 'Ponte reaplicada e sintaxe validada'
} else {
    Write-Output 'Ponte ja presente; nenhuma alteracao no Freebuff'
}

$proxyChanged = $false
foreach ($item in @(@($discovery, (Join-Path $proxyDir 'discover-orchestrator.ps1')),
                   @($proxySource, (Join-Path $proxyDir 'freebuff_tailnet_proxy.js')))) {
    $source = $item[0]
    $target = $item[1]
    if (-not (Test-Path -LiteralPath $target) -or
        (Get-Sha256 $source) -ne (Get-Sha256 $target)) {
        Copy-Item -LiteralPath $source -Destination $target -Force
        $proxyChanged = $true
    }
}

if ($needsPatch -and -not $NoRestart) {
    $main = Get-Process Freebuff -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($main) {
        if (-not $main.CloseMainWindow()) { throw 'Nao consegui fechar a janela do Freebuff; reinicie manualmente' }
        $main.WaitForExit(15000) | Out-Null
        if (Get-Process Freebuff -ErrorAction SilentlyContinue) {
            throw 'Freebuff ainda esta aberto; conclua o fechamento e execute o comando novamente'
        }
    }
    Start-Process -FilePath $exe
    Write-Output 'Freebuff reiniciado para ativar a ponte'
} elseif ($needsPatch -and $NoRestart) {
    Write-Output 'Ponte no disco; reinicie o Freebuff para ativa-la'
} elseif (-not $NoRestart -and -not (Get-Process Freebuff -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $exe
    Write-Output 'Freebuff Desktop iniciado'
}

if ($proxyChanged) {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'freebuff_tailnet_proxy\.js' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
}
& $startup

$container = docker compose --env-file $relayEnv -f $compose ps -q relay 2>$null
if ($LASTEXITCODE -ne 0 -or -not $container) {
    docker compose --env-file $relayEnv -f $compose up -d --no-build
    if ($LASTEXITCODE -ne 0) { throw 'Relay Docker nao iniciou; verifique Docker Desktop' }
}

$tailscale = (Get-Command tailscale.exe -ErrorAction Stop).Source
$serve = & $tailscale serve status 2>&1 | Out-String
if ($serve -notmatch 'proxy http://127\.0\.0\.1:8795') {
    throw 'Tailscale Serve nao aponta para o relay local na porta 8795'
}

$relayUrlLine = Get-Content -LiteralPath $relayEnv | Where-Object { $_ -like 'RELAY_HTTP_URL=*' } | Select-Object -First 1
if (-not $relayUrlLine) { throw 'RELAY_HTTP_URL ausente no .env' }
$relayUrl = $relayUrlLine.Substring('RELAY_HTTP_URL='.Length).TrimEnd('/')
$gateTokenFile = Join-Path $env:USERPROFILE '.config\freebuff\gate-proxy.token'
if (-not (Test-Path -LiteralPath $gateTokenFile)) { throw 'Token local do proxy ausente' }
$gateToken = [IO.File]::ReadAllText($gateTokenFile).Trim()
$ready = $false
for ($attempt = 0; $attempt -lt 18; $attempt++) {
    try {
        $api = Invoke-WebRequest -Uri 'http://127.0.0.1:58061/api/projects' -UseBasicParsing -TimeoutSec 5 -Headers @{ 'x-fb-gate' = $gateToken }
        $relay = Invoke-RestMethod -Uri "$relayUrl/healthz" -TimeoutSec 5
        if ($api.StatusCode -eq 200 -and $relay.ok -and $relay.connectors -ge 1) {
            $ready = $true
            break
        }
    } catch { }
    Start-Sleep -Seconds 4
}
if (-not $ready) { throw 'Gate ainda nao esta pronto; confira Freebuff, proxy, agente e relay' }
Write-Output 'PRONTO: API 200, relay saudavel, agente conectado e Tailscale privado'
