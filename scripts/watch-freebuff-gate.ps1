$ErrorActionPreference = 'Stop'
$base = Join-Path $env:LOCALAPPDATA 'Freebuff'
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
$proxy = Join-Path $base 'tailnet-proxy\freebuff_tailnet_proxy.js'
$agent = Join-Path $base 'mobile-connect\freebuff-mobile-connect.js'
$statusFile = Join-Path $base 'gate-watchdog-status.json'
$mutex = [Threading.Mutex]::new($false, 'Local\FreebuffGateWatchdog')
if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); exit 0 }

$recoveryCount = 0
$lastRecoveryAt = $null
$offlineSince = $null
if (Test-Path -LiteralPath $statusFile) {
    try {
        $previous = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
        $recoveryCount = [int]$previous.recoveryCount
        $lastRecoveryAt = $previous.lastRecoveryAt
    } catch { }
}

function Write-Status([string]$State, [string]$Detail, [int]$Connectors) {
    $value = [ordered]@{
        checkedAt = (Get-Date).ToUniversalTime().ToString('o')
        state = $State
        detail = $Detail
        connectors = $Connectors
        recoveryCount = $recoveryCount
        lastRecoveryAt = $lastRecoveryAt
    }
    $temp = "$statusFile.tmp-$PID"
    [IO.File]::WriteAllText($temp, ($value | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $statusFile -Force
}

try {
    while ($true) {
        try {
            $manual = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -match '(reconnect|repair)-freebuff-gate\.ps1' } |
                Select-Object -First 1
            if ($manual) {
                Write-Status 'manual' 'Reconexao ou reparo manual em andamento.' 0
                Start-Sleep -Seconds 30
                continue
            }
            if (-not (Get-Process Freebuff -ErrorAction SilentlyContinue)) {
                $offlineSince = $null
                Write-Status 'desktop_closed' 'Abra o Freebuff Desktop para restabelecer acesso.' 0
                Start-Sleep -Seconds 30
                continue
            }
            if (-not $node -or -not (Test-Path -LiteralPath $node) -or
                -not (Test-Path -LiteralPath $proxy) -or
                -not (Test-Path -LiteralPath $agent)) {
                Write-Status 'installation_missing' 'Arquivo do Gate ausente. Use Reparar instalacao.' 0
                Start-Sleep -Seconds 30
                continue
            }

            $proxyListening = Get-NetTCPConnection -State Listen -LocalPort 58061 -ErrorAction SilentlyContinue
            if (-not $proxyListening) {
                Start-Process -FilePath $node -ArgumentList ('"' + $proxy + '"') -WindowStyle Hidden
                $recoveryCount++
                $lastRecoveryAt = (Get-Date).ToUniversalTime().ToString('o')
            }

            $agentProcesses = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -match 'Freebuff[\\/]mobile-connect[\\/]freebuff-mobile-connect\.js.*serve' })
            if ($agentProcesses.Count -eq 0) {
                Start-Process -FilePath $node -ArgumentList @('"' + $agent + '"', 'serve') -WindowStyle Hidden
                $recoveryCount++
                $lastRecoveryAt = (Get-Date).ToUniversalTime().ToString('o')
                $offlineSince = $null
            }

            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8795/healthz' -TimeoutSec 4
            $connectors = [int]$health.connectors
            if ($connectors -gt 0) {
                $offlineSince = $null
                Write-Status 'connected' 'Conector registrado no relay.' $connectors
            } else {
                if (-not $offlineSince) { $offlineSince = Get-Date }
                if ($agentProcesses.Count -gt 0 -and ((Get-Date) - $offlineSince).TotalSeconds -ge 90) {
                    foreach ($process in $agentProcesses) { Stop-Process -Id $process.ProcessId -ErrorAction SilentlyContinue }
                    Start-Process -FilePath $node -ArgumentList @('"' + $agent + '"', 'serve') -WindowStyle Hidden
                    $recoveryCount++
                    $lastRecoveryAt = (Get-Date).ToUniversalTime().ToString('o')
                    $offlineSince = Get-Date
                    Write-Status 'recovering' 'Agente reiniciado apos conector offline por 90 s.' 0
                } else {
                    Write-Status 'waiting' 'Aguardando agente registrar conector no relay.' 0
                }
            }
        } catch {
            Write-Status 'error' $_.Exception.Message 0
        }
        Start-Sleep -Seconds 30
    }
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
