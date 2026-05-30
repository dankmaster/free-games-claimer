[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$taskNames = @(
    "Free Games Claimer - At Logon",
    "Free Games Claimer - Daily"
)

$removed = 0
foreach ($taskName in $taskNames) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "Removed: $taskName"
        $removed++
        continue
    }

    $result = & schtasks.exe /Query /TN $taskName 2>$null
    if ($LASTEXITCODE -eq 0) {
        & schtasks.exe /Delete /F /TN $taskName | Out-Host
        Write-Host "Removed: $taskName"
        $removed++
    } else {
        Write-Host "Not installed: $taskName"
    }
}

$startupLaunchers = @(
    (Join-Path ([Environment]::GetFolderPath("Startup")) "Free Games Claimer.vbs"),
    (Join-Path ([Environment]::GetFolderPath("Startup")) "Free Games Claimer.cmd")
)
foreach ($startupLauncher in $startupLaunchers) {
    if (Test-Path $startupLauncher) {
        Remove-Item -LiteralPath $startupLauncher -Force
        Write-Host "Removed Startup launcher: $startupLauncher"
        $removed++
    } else {
        Write-Host "Not installed: $startupLauncher"
    }
}

Write-Host ""
Write-Host "Removed $removed item(s)."
