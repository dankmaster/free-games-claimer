[CmdletBinding()]
param(
    [bool]$AtLogon = $true,
    [bool]$Daily = $true,
    [string]$DailyAt = "09:15",
    [int]$LogonDelayMinutes = 2,
    [int]$MinIntervalHours = 12,
    [switch]$SkipEpic,
    [switch]$ShowConsole,
    [switch]$AllowLoginPrompts,
    [switch]$RunNow
)

$ErrorActionPreference = "Stop"

$runner = Join-Path $PSScriptRoot "run-fgc.ps1"
if (!(Test-Path $runner)) {
    throw "Could not find runner script at $runner"
}

if (!$AtLogon -and !$Daily) {
    throw "Nothing to install. Set AtLogon or Daily to true."
}

if ($DailyAt -notmatch '^\d{1,2}:\d{2}$') {
    throw "DailyAt must be in HH:mm format, for example 09:15."
}

$parts = $DailyAt.Split(":")
$hour = [int]$parts[0]
$minute = [int]$parts[1]
if ($hour -lt 0 -or $hour -gt 23 -or $minute -lt 0 -or $minute -gt 59) {
    throw "DailyAt must be a valid 24-hour time."
}

if ($LogonDelayMinutes -lt 0 -or $LogonDelayMinutes -gt 120) {
    throw "LogonDelayMinutes must be between 0 and 120."
}

$powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$quotedRunner = '"' + $runner + '"'
$runnerArguments = "-NoPause -MinIntervalHours $MinIntervalHours"
if ($SkipEpic) {
    $runnerArguments += " -SkipEpic"
}
if ($ShowConsole) {
    $runnerArguments += " -NoHideConsole"
}
if (!$AllowLoginPrompts) {
    $runnerArguments += " -NoLoginPrompts"
}
$windowStyleArgument = if ($ShowConsole) { "" } else { "-WindowStyle Hidden " }
$argument = "-NoProfile -ExecutionPolicy Bypass $windowStyleArgument-File $quotedRunner $runnerArguments"
$taskRun = "$powerShell $argument"
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $argument -WorkingDirectory $PSScriptRoot
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

$registered = @()
$startupLauncher = Join-Path ([Environment]::GetFolderPath("Startup")) "Free Games Claimer.vbs"
$legacyStartupLauncher = Join-Path ([Environment]::GetFolderPath("Startup")) "Free Games Claimer.cmd"

function ConvertTo-VbsStringLiteral {
    param([Parameter(Mandatory=$true)][string]$Value)

    return '"' + $Value.Replace('"', '""') + '"'
}

function New-StartupLauncher {
    $content = @(
        'Set shell = CreateObject("WScript.Shell")'
    )
    if ($LogonDelayMinutes -gt 0) {
        $content += "WScript.Sleep $($LogonDelayMinutes * 60 * 1000)"
    }
    $content += @(
        "shell.CurrentDirectory = $(ConvertTo-VbsStringLiteral $PSScriptRoot)",
        "shell.Run $(ConvertTo-VbsStringLiteral $taskRun), 0, False"
    )
    Set-Content -Path $startupLauncher -Value $content -Encoding ASCII
    Write-Host "Created hidden Startup launcher: $startupLauncher"
}

function Remove-StartupLauncher {
    foreach ($launcher in @($startupLauncher, $legacyStartupLauncher)) {
        if (Test-Path $launcher) {
            Remove-Item -LiteralPath $launcher -Force
            Write-Host "Removed fallback Startup launcher: $launcher"
        }
    }
}

function New-LogonTrigger {
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    if ($LogonDelayMinutes -gt 0) {
        $trigger.Delay = "PT$($LogonDelayMinutes)M"
    }
    return $trigger
}

function Register-WithScheduledTasks {
    param(
        [Parameter(Mandatory=$true)][string]$TaskName,
        [Parameter(Mandatory=$true)]$Trigger,
        [Parameter(Mandatory=$true)][string]$Description
    )

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $Trigger `
        -Settings $settings `
        -Principal $principal `
        -Description $Description `
        -Force | Out-Null

    $script:registered += $TaskName
    Write-Host "Registered: $TaskName"
}

function Register-DailyWithSchTasks {
    $result = & schtasks.exe /Create /F /TN "Free Games Claimer - Daily" /SC DAILY /ST $DailyAt /TR $taskRun /RL LIMITED 2>&1
    $result | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        throw "schtasks.exe failed to create daily task with exit code $LASTEXITCODE"
    }
    $script:registered += "Free Games Claimer - Daily"
}

if ($AtLogon) {
    try {
        Register-WithScheduledTasks `
            -TaskName "Free Games Claimer - At Logon" `
            -Trigger (New-LogonTrigger) `
            -Description "Runs Free Games Claimer $LogonDelayMinutes minute(s) after $env:USERDOMAIN\$env:USERNAME logs in."
        Remove-StartupLauncher
    } catch {
        Write-Host "Could not create Task Scheduler logon task: $($_.Exception.Message)"
        New-StartupLauncher
    }
}

if ($Daily) {
    $dailyTime = (Get-Date).Date.AddHours($hour).AddMinutes($minute)
    try {
        Register-WithScheduledTasks `
            -TaskName "Free Games Claimer - Daily" `
            -Trigger (New-ScheduledTaskTrigger -Daily -At $dailyTime) `
            -Description "Runs Free Games Claimer daily at $DailyAt when the user is logged in."
    } catch {
        Write-Host "Could not create daily task with Register-ScheduledTask: $($_.Exception.Message)"
        Register-DailyWithSchTasks
    }
}

Write-Host ""
Write-Host "Task action:"
Write-Host $taskRun
Write-Host ""
Write-Host "Minimum interval guard: $MinIntervalHours hour(s)."
Write-Host "Logon trigger delay: $LogonDelayMinutes minute(s)."
if ($SkipEpic) {
    Write-Host "Epic Games is skipped for scheduled/startup runs so automation can stay headless."
} else {
    Write-Host "Epic Games is included."
}
Write-Host "Visible browser windows are hidden during scheduled/startup runs unless -AllowLoginPrompts or -NoHideVisibleBrowsers is used on the runner."
if ($ShowConsole) {
    Write-Host "Console windows are enabled for scheduled/startup runs."
} else {
    Write-Host "PowerShell/CMD windows are hidden for scheduled/startup runs."
}
if ($AllowLoginPrompts) {
    Write-Host "Login prompts are allowed during scheduled/startup runs."
} else {
    Write-Host "Login prompts are suppressed during scheduled/startup runs; expired sessions are logged instead."
}

if ($RunNow) {
    if ($registered.Count -gt 0) {
        Start-ScheduledTask -TaskName $registered[0]
        Write-Host "Started: $($registered[0])"
    } elseif (Test-Path $startupLauncher) {
        $wscript = (Get-Command wscript.exe -ErrorAction SilentlyContinue).Source
        if ($wscript) {
            Start-Process -FilePath $wscript -ArgumentList @("`"$startupLauncher`"") -WindowStyle Hidden
        } else {
            Start-Process -FilePath $startupLauncher
        }
        Write-Host "Started Startup launcher."
    }
}
