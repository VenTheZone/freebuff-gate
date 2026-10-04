$ErrorActionPreference = 'Stop'
$url = 'http://127.0.0.1:8796'
$healthUrl = "$url/api/health"

function Test-Panel {
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        return ($response.ok -eq $true -and $response.service -eq 'freebuff-panel')
    } catch { return $false }
}

if (-not (Test-Panel)) {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $script = Join-Path $PSScriptRoot 'freebuff-panel.js'
    Start-Process -FilePath $node -ArgumentList ('"' + $script + '"') -WorkingDirectory (Split-Path -Parent $PSScriptRoot) -WindowStyle Hidden
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 300
        if (Test-Panel) { $ready = $true; break }
    }
    if (-not $ready) { throw "Painel nao iniciou em $url. Porta 8796 pode estar ocupada." }
}
Start-Process $url
Write-Output "Painel aberto: $url"
