[CmdletBinding()]
param(
    [switch]$SkipVisibleRun,
    [switch]$SkipLoginSites,
    [switch]$InstallScheduledTask,
    [string]$DailyAt = "09:15",
    [int]$LogonDelayMinutes = 2
)

$ErrorActionPreference = "Stop"

$runner = Join-Path $PSScriptRoot "run-fgc.ps1"
$project = $PSScriptRoot
$scheduler = Join-Path $PSScriptRoot "install-fgc-scheduled-task.ps1"
$loginSites = Join-Path $PSScriptRoot "login-fgc-sites.ps1"

if (!(Test-Path $runner)) {
    throw "Could not find runner script at $runner"
}

if (!(Test-Path (Join-Path $project "package.json"))) {
    throw "Could not find free-games-claimer project at $project"
}

function Invoke-Step {
    param(
        [Parameter(Mandatory=$true)][string]$Name,
        [Parameter(Mandatory=$true)][scriptblock]$ScriptBlock
    )

    Write-Host ""
    Write-Host "=== $Name ==="
    & $ScriptBlock
    if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

Invoke-Step "Install dependencies and browser" {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runner -InstallOnly -NoPause -LogPrefix "fgc_init"
}

Invoke-Step "Smoke-check claimer entrypoints" {
    Push-Location $project
    try {
        & npm run smoke
    } finally {
        Pop-Location
    }
}

Invoke-Step "Warm GamerPower cache" {
    Push-Location $project
    try {
        & npm run warm-cache
    } finally {
        Pop-Location
    }
}

if (!$SkipVisibleRun -and !$SkipLoginSites) {
    Invoke-Step "Open login sites with 1Password" {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $loginSites
    }
}

if (!$SkipVisibleRun) {
    $oldEgCheckGp = $env:EG_CHECK_GP
    $oldGogCheckGp = $env:GOG_CHECK_GP

    try {
        $env:EG_CHECK_GP = "1"
        $env:GOG_CHECK_GP = "1"

        Invoke-Step "First visible claim/login run" {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runner -ShowAll -LogPrefix "fgc_init_first_run"
        }
    } finally {
        $env:EG_CHECK_GP = $oldEgCheckGp
        $env:GOG_CHECK_GP = $oldGogCheckGp
    }
}

if ($InstallScheduledTask) {
    Invoke-Step "Install scheduled tasks" {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scheduler -DailyAt $DailyAt -LogonDelayMinutes $LogonDelayMinutes
    }
}

Write-Host ""
Write-Host "Initialize flow complete."
