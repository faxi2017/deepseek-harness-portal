$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if (-not (Test-Path -LiteralPath '.env')) { throw 'Copy .env.example to .env and configure it first.' }
    node --env-file=.env portal/src/index.js
    if ($LASTEXITCODE -ne 0) { throw 'Portal startup failed; see the preceding error.' }
} finally {
    Pop-Location
}
