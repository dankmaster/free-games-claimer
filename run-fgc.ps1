[CmdletBinding()]
param(
    [switch]$NoPause,
    [switch]$NoHideConsole,
    [switch]$NoLoginPrompts,
    [switch]$NoAutoInitialize,
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
    [switch]$HideVisibleBrowsers,
    [switch]$NoHideVisibleBrowsers,
    [int]$TimeoutSeconds = 90,
    [int]$LoginTimeoutSeconds = 240,
    [int]$MinIntervalHours = 0,
    [string]$LogPrefix = "fgc"
)

$ErrorActionPreference = "Stop"

function Test-StartedByTaskScheduler {
    try {
        $currentProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop
        for ($i = 0; $i -lt 6 -and $currentProcess.ParentProcessId; $i++) {
            $parentProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($currentProcess.ParentProcessId)" -ErrorAction Stop
            $parentName = "$($parentProcess.Name)".ToLowerInvariant()
            $parentCommandLine = "$($parentProcess.CommandLine)".ToLowerInvariant()
            if ($parentName -in @("taskeng.exe", "taskhostw.exe")) {
                return $true
            }
            if ($parentName -eq "svchost.exe" -and $parentCommandLine.Contains("-s schedule")) {
                return $true
            }
            $currentProcess = $parentProcess
        }
    } catch { }

    return $false
}

function Hide-ConsoleWindow {
    try {
        if (-not ([System.Management.Automation.PSTypeName]'FgcNative.ConsoleWindow').Type) {
            Add-Type -Namespace FgcNative -Name ConsoleWindow -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern System.IntPtr GetConsoleWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@
        }
        $handle = [FgcNative.ConsoleWindow]::GetConsoleWindow()
        if ($handle -ne [IntPtr]::Zero) {
            [FgcNative.ConsoleWindow]::ShowWindow($handle, 0) | Out-Null
        }
    } catch { }
}

$startedByTaskScheduler = Test-StartedByTaskScheduler
$suppressLoginPrompts = $NoLoginPrompts -or $startedByTaskScheduler
$hideVisibleBrowserWindows = $HideVisibleBrowsers -or ($suppressLoginPrompts -and !$NoHideVisibleBrowsers)

if (!$NoHideConsole -and $startedByTaskScheduler) {
    Hide-ConsoleWindow
}

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
$loginRequiredMarkerPath = Join-Path $dataDir "login-required.flag"
$autoInitializeMarkerPath = Join-Path $dataDir "initialize-autostart.flag"

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

function Start-BrowserWindowSilencer {
    if (!$script:hideVisibleBrowserWindows) {
        return $null
    }

    $silencer = Join-Path $PSScriptRoot "hide-fgc-browser-windows.ps1"
    if (!(Test-Path -LiteralPath $silencer)) {
        Write-LogLine "Browser window silencer is missing: $silencer"
        return $null
    }

    try {
        $powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
        $arguments = @(
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            "`"$silencer`"",
            "-BrowserDir",
            "`"$env:BROWSER_DIR`"",
            "-ParentPid",
            "$PID",
            "-Mode",
            "Hide"
        )
        return Start-Process -FilePath $powerShell -ArgumentList $arguments -WindowStyle Hidden -PassThru
    } catch {
        Write-LogLine "Could not start browser window silencer: $($_.Exception.Message)"
        return $null
    }
}

function Stop-BrowserWindowSilencer {
    param($Process)

    if ($null -eq $Process) {
        return
    }

    try {
        if (!$Process.HasExited) {
            Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        }
    } catch { }
}

function Test-LoginNeededOutput {
    param([string[]]$Lines)

    $text = ($Lines -join "`n").ToLowerInvariant()
    return $text.Contains("show=1 node") `
        -or $text.Contains("login required in shown browser") `
        -or $text.Contains("login required and nowait") `
        -or $text.Contains("sign-in is required") `
        -or $text.Contains("sign in is required") `
        -or $text.Contains("not signed in anymore") `
        -or $text.Contains("not signed!") `
        -or $text.Contains("no longer signed in") `
        -or $text.Contains("login failed") `
        -or $text.Contains("not logged in")
}

function Test-InitializeRunning {
    $escapedRepo = [regex]::Escape($repo)
    $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -match '^(powershell|pwsh)\.exe$' -and
            $_.CommandLine -match 'initialize-fgc\.ps1' -and
            $_.CommandLine -match $escapedRepo
        }

    return !!$processes
}

function Start-InitializeRefresh {
    param([Parameter(Mandatory=$true)][string]$Reason)

    if ($NoAutoInitialize) {
        Write-LogLine "Automatic initialize start is disabled for this run."
        return
    }

    if (Test-InitializeRunning) {
        Write-LogLine "Initialize flow is already running; not starting another copy."
        return
    }

    if (Test-Path $autoInitializeMarkerPath) {
        $lastStart = (Get-Item -LiteralPath $autoInitializeMarkerPath).LastWriteTime
        if (((Get-Date) - $lastStart).TotalMinutes -lt 15) {
            Write-LogLine "Initialize flow was already auto-started recently; not starting another copy."
            Write-LogLine "Autostart marker: $autoInitializeMarkerPath"
            return
        }
    }

    $initializeScript = Join-Path $repo "initialize-fgc.ps1"
    if (!(Test-Path -LiteralPath $initializeScript)) {
        Write-LogLine "Could not auto-start initialize; missing script: $initializeScript"
        return
    }

    $content = @(
        "Initialize auto-started because: $Reason",
        "StartedAt=$([DateTimeOffset]::Now.ToString("o"))",
        "Log=$log",
        "Script=$initializeScript"
    )
    Set-Content -Path $autoInitializeMarkerPath -Value $content -Encoding utf8

    $powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "`"$initializeScript`""
    )
    Start-Process -FilePath $powerShell -ArgumentList $arguments -WorkingDirectory $repo -WindowStyle Normal | Out-Null
    Write-LogLine "Started initialize flow for login/setup refresh: $initializeScript"
}

function Set-LoginRequiredMarker {
    param(
        [Parameter(Mandatory=$true)][string]$Name,
        [string[]]$Lines = @()
    )

    $content = @(
        "Login refresh required for $Name.",
        "DetectedAt=$([DateTimeOffset]::Now.ToString("o"))",
        "Log=$log",
        "",
        "Background runs are blocked until the shared browser profile is refreshed.",
        "Run .\initialize-fgc.ps1 from $repo, complete the visible login/setup flow, then let it finish.",
        "",
        "Detected output:"
    )
    $content += @($Lines | Select-Object -Last 30)
    Set-Content -Path $loginRequiredMarkerPath -Value $content -Encoding utf8
    Write-LogLine "Login/session refresh required for $Name."
    Write-LogLine "Marker written: $loginRequiredMarkerPath"
    Write-LogLine "Run .\initialize-fgc.ps1 from $repo before background runs continue."
    Start-InitializeRefresh -Reason "login/session refresh required for $Name"
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

if ($suppressLoginPrompts -and !$InstallOnly -and (Test-Path $loginRequiredMarkerPath)) {
    Write-LogLine "Skipping: login/setup refresh is required before background runs can continue."
    Write-LogLine "Marker: $loginRequiredMarkerPath"
    Write-LogLine "Run .\initialize-fgc.ps1 from $repo, complete the visible login/setup flow, then let it finish."
    Start-InitializeRefresh -Reason "existing login-required marker"
    Close-RunLock
    exit 1
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
$abortRemainingStores = $false

function Run-Node {
    param(
        [Parameter(Mandatory=$true)][string]$Name,
        [Parameter(Mandatory=$true)][string]$Script,
        [Parameter(Mandatory=$true)][ValidateSet("0", "1")][string]$Show
    )

    $previousNowait = $env:NOWAIT
    $previousBrowserLogin = $env:BROWSER_LOGIN
    $previousStartMinimized = $env:START_MINIMIZED
    $previousRedeemCaptchaMode = $env:PG_REDEEM_CAPTCHA_MODE
    $env:SHOW = $Show
    if ($Show -eq "0") {
        $env:NOWAIT = "1"
        Remove-Item Env:\BROWSER_LOGIN -ErrorAction SilentlyContinue
        Remove-Item Env:\START_MINIMIZED -ErrorAction SilentlyContinue
    } else {
        if ($script:suppressLoginPrompts) {
            $env:NOWAIT = "1"
            Remove-Item Env:\BROWSER_LOGIN -ErrorAction SilentlyContinue
        } else {
            Remove-Item Env:\NOWAIT -ErrorAction SilentlyContinue
            $env:BROWSER_LOGIN = "1"
        }
        if (!$NoMinimizeVisibleBrowsers) {
            $env:START_MINIMIZED = "1"
        } else {
            Remove-Item Env:\START_MINIMIZED -ErrorAction SilentlyContinue
        }
    }
    if ($script:suppressLoginPrompts) {
        $env:PG_REDEEM_CAPTCHA_MODE = "stop"
    }

    $header = "===== $Name ($((Get-Date).ToString('s'))) SHOW=$Show ====="
    Write-LogLine $header

    $browserWindowSilencer = Start-BrowserWindowSilencer
    try {
        $exitCode = Invoke-LoggedCommand -FilePath "node" -Arguments @($Script)
        $loginNeeded = $exitCode -ne 0 -and (Test-LoginNeededOutput -Lines $script:lastCommandOutput)
        if ($loginNeeded -and $script:suppressLoginPrompts) {
            Set-LoginRequiredMarker -Name $Name -Lines $script:lastCommandOutput
            $script:overallExitCode = $exitCode
            $script:abortRemainingStores = $true
        } elseif ($loginNeeded -and $Show -eq "0" -and !$NoShowOnLogin) {
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
    } finally {
        Stop-BrowserWindowSilencer -Process $browserWindowSilencer
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
    if ($null -eq $previousRedeemCaptchaMode) {
        Remove-Item Env:\PG_REDEEM_CAPTCHA_MODE -ErrorAction SilentlyContinue
    } else {
        $env:PG_REDEEM_CAPTCHA_MODE = $previousRedeemCaptchaMode
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

if (!$script:abortRemainingStores -and !$SkipPrime) {
    Run-Node -Name "Prime Gaming" -Script ".\prime-gaming.js" -Show $ShowPrime
}

if (!$script:abortRemainingStores -and !$SkipGog) {
    Run-Node -Name "GOG" -Script ".\gog.js" -Show $ShowGog
}

if ($script:abortRemainingStores) {
    Write-LogLine "Aborted remaining stores because login/setup refresh is required."
}

if ($MinIntervalHours -gt 0 -and !$script:abortRemainingStores) {
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
