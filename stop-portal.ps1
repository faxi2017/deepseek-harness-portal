[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$pidFile = Join-Path $root '.portal.pid'
$portalProcess = $null
$portalPort = 7000

$portSetting = Get-Content -LiteralPath (Join-Path $root '.env') -ErrorAction SilentlyContinue |
    Where-Object { $_ -match '^PORT=(\d+)$' } |
    Select-Object -Last 1
if ($portSetting -match '^PORT=(\d+)$') { $portalPort = [int]$Matches[1] }

if (Test-Path -LiteralPath $pidFile) {
    $savedPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if ($savedPid -match '^\d+$') {
        $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction SilentlyContinue
        if ($candidate -and $candidate.Name -match '^node(?:\.exe)?$' -and $candidate.CommandLine -match 'portal[/\\]src[/\\]index\.js') {
            $portalProcess = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
        }
    }
}

if (-not $portalProcess) {
    $listeners = Get-NetTCPConnection -LocalPort $portalPort -State Listen -ErrorAction SilentlyContinue
    $matches = @($listeners | ForEach-Object {
        $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.OwningProcess)" -ErrorAction SilentlyContinue
        if ($candidate -and $candidate.Name -match '^node(?:\.exe)?$' -and $candidate.CommandLine -match 'portal[/\\]src[/\\]index\.js') {
            Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
        }
    })
    if ($matches.Count -gt 1) { throw "Found multiple Portal processes listening on port $portalPort; stop them manually to avoid closing the wrong service." }
    if ($matches.Count -eq 1) { $portalProcess = $matches[0] }
}

if (-not $portalProcess) {
    $matches = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'portal[/\\]src[/\\]index\.js' }
    if ($matches.Count -gt 1) { throw 'Found multiple Portal processes; stop them manually to avoid closing the wrong service.' }
    if ($matches.Count -eq 1) { $portalProcess = Get-Process -Id $matches.ProcessId -ErrorAction SilentlyContinue }
}

if (-not $portalProcess) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Write-Output 'Portal is not running.'
    exit 0
}

if ($PSCmdlet.ShouldProcess("Portal process $($portalProcess.Id)", 'Stop')) {
    Stop-Process -Id $portalProcess.Id -Force
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Write-Output "Portal stopped (PID $($portalProcess.Id))."
}
