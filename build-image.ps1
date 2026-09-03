$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    node scripts/build-image.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Docker image build failed' }
} finally {
    Pop-Location
}
