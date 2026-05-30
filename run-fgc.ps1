[CmdletBinding()]
param(
    [switch]$NoPause,
    [switch]$InstallOnly,
    [switch]$ShowAll,
    [switch]$SkipEpic,
    [switch]$SkipPrime,
    [switch]$SkipGog,
    [switch]$NoShowOnLogin,
    [ValidateSet("0", "1")][string]$ShowEpic = "1",
    [ValidateSet("0", "1")][string]$ShowPrime = "1",
    [ValidateSet("0", "1")][string]$ShowGog = "1",
    [switch]$NoMinimizeVisibleBrowsers,
    [int]$TimeoutSeconds = 90,
    [int]$LoginTimeoutSeconds = 240,
    [int]$MinIntervalHours = 0,
    [string]$LogPrefix = "fgc"
)

$ErrorActionPreference = "Stop"

if ($ShowAll) {
    $ShowEpic = "1"
    $ShowPrime = "1"
    $ShowGog = "1"
}

$repo = $PSScriptRoot
if (!(Test-Path (Join-Path $repo "package.json"))) {
    throw "Could not find free-games-claimer project at $repo"
}

Set-Location $repo

$dataDir = Join-Path $repo "data"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$logDir = Join-Path $dataDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$log = Join-Path $logDir "$LogPrefix`_$stamp.log"
$lastRunStamp = Join-Path $dataDir "last-run-fgc.ps1.txt"
$runLockPath = Join-Path $dataDir "run-fgc.lock"

function Write-LogLine {
    param([AllowEmptyString()][string]$Value)

    Write-Host $Value
    Add-Content -Path $log -Value $Value -Encoding utf8
}

function Invoke-LoggedCommand {
    param(
        [Parameter(Mandatory=$true)][string]$FilePath,
        [string[]]$Arguments = @()
    )

    $script:lastCommandOutput = [System.Collections.Generic.List[string]]::new()
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $FilePath @Arguments 2>&1 | ForEach-Object {
            $line = if ($_ -is [System.Management.Automation.ErrorRecord]) {
                $_.ToString()
            } else {
                $_
            }
            Add-Content -Path $log -Value $line -Encoding utf8
            $script:lastCommandOutput.Add($line)
            Write-Host $line
        }
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function Test-LoginNeededOutput {
    param([string[]]$Lines)

    $text = ($Lines -join "`n").ToLowerInvariant()
    return $text.Contains("show=1 node") `
        -or $text.Contains("login required in shown browser") `
        -or $text.Contains("sign-in is required") `
        -or $text.Contains("sign in is required") `
        -or $text.Contains("not signed in anymore") `
        -or $text.Contains("not signed!") `
        -or $text.Contains("no longer signed in") `
        -or $text.Contains("login failed") `
        -or $text.Contains("not logged in")
}

try {
    $host.UI.RawUI.WindowTitle = "Free Games Claimer - $stamp"
} catch { }

if (!$NoPause) {
    Clear-Host
}

Write-LogLine "Log: $log"
Write-LogLine ""

$runLock = $null
try {
    $runLock = [System.IO.File]::Open($runLockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $lockBytes = [System.Text.Encoding]::UTF8.GetBytes("pid=$PID started=$([DateTimeOffset]::Now.ToString("o"))")
    $runLock.SetLength(0)
    $runLock.Write($lockBytes, 0, $lockBytes.Length)
    $runLock.Flush()
} catch {
    Write-LogLine "Skipping: another Free Games Claimer run is already active."
    exit 0
}

function Close-RunLock {
    if ($null -ne $script:runLock) {
        $script:runLock.Dispose()
        $script:runLock = $null
    }
}

if ($MinIntervalHours -gt 0 -and (Test-Path $lastRunStamp)) {
    $lastRun = $null
    try {
        $lastRun = [DateTimeOffset]::Parse((Get-Content -Raw $lastRunStamp).Trim())
    } catch {
        Write-LogLine "Ignoring unreadable last-run stamp: $lastRunStamp"
    }

    if ($lastRun) {
        $elapsedHours = ([DateTimeOffset]::Now - $lastRun).TotalHours
        if ($elapsedHours -lt $MinIntervalHours) {
            Write-LogLine ("Skipping: last scheduled run was {0:N1} hour(s) ago, minimum is {1}." -f $elapsedHours, $MinIntervalHours)
            if (!$NoPause) {
                Write-LogLine ""
                Write-LogLine "Done. Closing in 20 seconds..."
                Start-Sleep -Seconds 20
            }
            Close-RunLock
            exit 0
        }
    }
}

if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required. Install it from https://nodejs.org/ and reopen PowerShell."
}

if (!(Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm is required but was not found on PATH."
}

if (!(Get-Command npx -ErrorAction SilentlyContinue)) {
    throw "npx is required but was not found on PATH."
}

if (!(Test-Path ".\node_modules")) {
    Write-LogLine "Installing npm dependencies..."
    $installExit = Invoke-LoggedCommand -FilePath "npm" -Arguments @("install")
    if ($installExit -ne 0) {
        throw "npm install failed with exit code $installExit"
    }
}

Write-LogLine "Ensuring Patchright Chromium is installed..."
$browserExit = Invoke-LoggedCommand -FilePath "npx" -Arguments @("patchright", "install", "chromium")
if ($browserExit -ne 0) {
    throw "Patchright Chromium install failed with exit code $browserExit"
}

$env:BROWSER_DIR = Join-Path $dataDir "browser"
New-Item -ItemType Directory -Force -Path $env:BROWSER_DIR | Out-Null

$autofillCleaner = Join-Path $PSScriptRoot "clear-fgc-browser-autofill.ps1"
if (Test-Path $autofillCleaner) {
    Write-LogLine "Clearing Chromium autofill data and disabling browser autofill prompts..."
    $cleanerExit = Invoke-LoggedCommand -FilePath "powershell.exe" -Arguments @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $autofillCleaner,
        "-BrowserDir",
        $env:BROWSER_DIR,
        "-Quiet"
    )
    if ($cleanerExit -ne 0) {
        throw "Browser autofill cleanup failed with exit code $cleanerExit"
    }
}

$env:TIMEOUT = "$TimeoutSeconds"
$env:LOGIN_TIMEOUT = "$LoginTimeoutSeconds"

if ($InstallOnly) {
    Write-LogLine "Install-only setup complete."
    Close-RunLock
    exit 0
}

$overallExitCode = 0

function Run-Node {
    param(
        [Parameter(Mandatory=$true)][string]$Name,
        [Parameter(Mandatory=$true)][string]$Script,
        [Parameter(Mandatory=$true)][ValidateSet("0", "1")][string]$Show
    )

    $previousNowait = $env:NOWAIT
    $previousBrowserLogin = $env:BROWSER_LOGIN
    $previousStartMinimized = $env:START_MINIMIZED
    $env:SHOW = $Show
    if ($Show -eq "0") {
        $env:NOWAIT = "1"
        Remove-Item Env:\BROWSER_LOGIN -ErrorAction SilentlyContinue
        Remove-Item Env:\START_MINIMIZED -ErrorAction SilentlyContinue
    } else {
        Remove-Item Env:\NOWAIT -ErrorAction SilentlyContinue
        $env:BROWSER_LOGIN = "1"
        if (!$NoMinimizeVisibleBrowsers) {
            $env:START_MINIMIZED = "1"
        } else {
            Remove-Item Env:\START_MINIMIZED -ErrorAction SilentlyContinue
        }
    }

    $header = "===== $Name ($((Get-Date).ToString('s'))) SHOW=$Show ====="
    Write-LogLine $header

    $exitCode = Invoke-LoggedCommand -FilePath "node" -Arguments @($Script)
    if ($exitCode -ne 0 -and $Show -eq "0" -and !$NoShowOnLogin -and (Test-LoginNeededOutput -Lines $script:lastCommandOutput)) {
        Write-LogLine "===== $Name needs browser login; retrying visibly with SHOW=1 ====="
        Write-LogLine ""
        $env:SHOW = "1"
        Remove-Item Env:\NOWAIT -ErrorAction SilentlyContinue
        $env:BROWSER_LOGIN = "1"
        if (!$NoMinimizeVisibleBrowsers) {
            $env:START_MINIMIZED = "1"
        } else {
            Remove-Item Env:\START_MINIMIZED -ErrorAction SilentlyContinue
        }
        $retryHeader = "===== $Name visible login retry ($((Get-Date).ToString('s'))) SHOW=1 ====="
        Write-LogLine $retryHeader
        $exitCode = Invoke-LoggedCommand -FilePath "node" -Arguments @($Script)
    }

    if ($null -eq $previousNowait) {
        Remove-Item Env:\NOWAIT -ErrorAction SilentlyContinue
    } else {
        $env:NOWAIT = $previousNowait
    }
    if ($null -eq $previousBrowserLogin) {
        Remove-Item Env:\BROWSER_LOGIN -ErrorAction SilentlyContinue
    } else {
        $env:BROWSER_LOGIN = $previousBrowserLogin
    }
    if ($null -eq $previousStartMinimized) {
        Remove-Item Env:\START_MINIMIZED -ErrorAction SilentlyContinue
    } else {
        $env:START_MINIMIZED = $previousStartMinimized
    }

    if ($exitCode -ne 0) {
        $script:overallExitCode = $exitCode
        Write-LogLine "===== $Name exited with code $exitCode ====="
    }

    $footer = "===== $Name finished ($((Get-Date).ToString('s'))) ====="
    Write-LogLine $footer
    Write-LogLine ""
}

$start = "=== START $((Get-Date).ToString('s')) ==="
Write-LogLine $start

if (!$SkipEpic) {
    Run-Node -Name "Epic Games" -Script ".\epic-games.js" -Show $ShowEpic
}

if (!$SkipPrime) {
    Run-Node -Name "Prime Gaming" -Script ".\prime-gaming.js" -Show $ShowPrime
}

if (!$SkipGog) {
    Run-Node -Name "GOG" -Script ".\gog.js" -Show $ShowGog
}

if ($MinIntervalHours -gt 0) {
    Set-Content -Path $lastRunStamp -Value ([DateTimeOffset]::Now.ToString("o")) -Encoding utf8
}

$end = "=== END   $((Get-Date).ToString('s')) ==="
Write-LogLine $end

if ($overallExitCode -ne 0) {
    Write-LogLine "One or more claimers exited with errors. Overall exit code: $overallExitCode"
}

if (!$NoPause) {
    Write-LogLine ""
    Write-LogLine "Done. Closing in 20 seconds..."
    Start-Sleep -Seconds 20
}

Close-RunLock
exit $overallExitCode
