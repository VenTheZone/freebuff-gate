# Find the running Freebuff orchestrator and its current launch identity.
# The identity file is written by patch-windows-launch-bridge.js at startup.
# stdout is consumed by the local proxy; do not log or display it.
$identityPath = Join-Path $env:LOCALAPPDATA 'Freebuff\gate-launch-id.json'
if (-not (Test-Path -LiteralPath $identityPath)) { exit 0 }
try { $identity = Get-Content -LiteralPath $identityPath -Raw | ConvertFrom-Json } catch { exit 0 }
if (-not $identity.pid -or -not $identity.launchId -or $identity.launchId -match '[|\r\n]') { exit 0 }

$buns = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue
foreach ($b in $buns) {
    if ($b.ProcessId -ne [int]$identity.pid) { continue }
    if ($b.CommandLine -notmatch '(?i)freebuff.*orchestrator|orchestrator.*freebuff') { continue }
    $conn = Get-NetTCPConnection -OwningProcess $b.ProcessId -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -First 1
    if ($conn) {
        Write-Output "$($conn.LocalPort)|$($identity.launchId)"
        exit 0
    }
}
exit 0
