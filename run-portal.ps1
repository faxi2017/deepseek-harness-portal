$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
$pidFile = Join-Path $PSScriptRoot '.portal.pid'
try {
    if (-not (Test-Path -LiteralPath '.env')) { throw 'Copy .env.example to .env and configure it first.' }
    $portalProcess = Start-Process -FilePath 'node' -ArgumentList '--env-file=.env', 'portal/src/index.js' -PassThru -NoNewWindow
    Set-Content -LiteralPath $pidFile -Value $portalProcess.Id -NoNewline
    $portalProcess.WaitForExit()
    if ($portalProcess.ExitCode -ne 0) { throw 'Portal startup failed; see the preceding error.' }
} finally {
    if ($portalProcess -and (Test-Path -LiteralPath $pidFile) -and (Get-Content -LiteralPath $pidFile -Raw).Trim() -eq $portalProcess.Id.ToString()) {
        Remove-Item -LiteralPath $pidFile -Force
    }
    Pop-Location
}
