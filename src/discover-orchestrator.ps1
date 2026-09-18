# Find the port the Freebuff orchestrator (bun.exe) listens on
$buns = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue
if (-not $buns) { exit 0 }
foreach ($b in $buns) {
    $conns = Get-NetTCPConnection -OwningProcess $b.ProcessId -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
        Write-Output $conns[0].LocalPort
        exit 0
    }
}
exit 0
