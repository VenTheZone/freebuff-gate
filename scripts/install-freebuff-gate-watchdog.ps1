$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'watch-freebuff-gate.ps1'
$target = Join-Path $env:LOCALAPPDATA 'Freebuff\watch-freebuff-gate.ps1'
if (-not (Test-Path -LiteralPath $source)) { throw 'Watchdog source missing' }
Copy-Item -LiteralPath $source -Destination $target -Force
$command = '"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $target + '"'
New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'FreebuffGate' -Value $command -PropertyType String -Force | Out-Null
$existing = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'watch-freebuff-gate\.ps1' })
if ($existing.Count -eq 0) {
    Start-Process -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -ArgumentList @(
        '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $target
    ) -WindowStyle Hidden
}
Write-Output 'Watchdog instalado na inicializacao do usuario.'
