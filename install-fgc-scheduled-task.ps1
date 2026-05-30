[CmdletBinding()]
param(
    [bool]$AtLogon = $true,
    [bool]$Daily = $true,
    [string]$DailyAt = "09:15",
    [int]$LogonDelayMinutes = 2,
    [int]$MinIntervalHours = 12,
    [switch]$SkipEpic,
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
$argument = "-NoProfile -ExecutionPolicy Bypass -File $quotedRunner $runnerArguments"
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
$startupLauncher = Join-Path ([Environment]::GetFolderPath("Startup")) "Free Games Claimer.cmd"

function New-StartupLauncher {
    $content = @(
        "@echo off"
    )
    if ($LogonDelayMinutes -gt 0) {
        $content += "timeout /t $($LogonDelayMinutes * 60) /nobreak >nul"
    }
    $content += @(
        "cd /d `"$PSScriptRoot`"",
        "`"$powerShell`" $argument"
    )
    Set-Content -Path $startupLauncher -Value $content -Encoding ASCII
    Write-Host "Created Startup launcher: $startupLauncher"
}

function Remove-StartupLauncher {
    if (Test-Path $startupLauncher) {
        Remove-Item -LiteralPath $startupLauncher -Force
        Write-Host "Removed fallback Startup launcher: $startupLauncher"
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
    Write-Host "Epic Games is included. Epic, Prime, and GOG may start minimized visible browser windows during scheduled/startup runs."
}

if ($RunNow) {
    if ($registered.Count -gt 0) {
        Start-ScheduledTask -TaskName $registered[0]
        Write-Host "Started: $($registered[0])"
    } elseif (Test-Path $startupLauncher) {
        Start-Process -FilePath $startupLauncher
        Write-Host "Started Startup launcher."
    }
}
