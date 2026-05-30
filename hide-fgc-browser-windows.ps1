[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$BrowserDir,
    [int]$ParentPid = 0,
    [ValidateSet("Hide", "Minimize")][string]$Mode = "Hide",
    [int]$PollMilliseconds = 250,
    [int]$MaxSeconds = 0
)

$ErrorActionPreference = "SilentlyContinue"

try {
    $resolvedBrowserDir = (Resolve-Path -LiteralPath $BrowserDir -ErrorAction Stop).ProviderPath
} catch {
    $resolvedBrowserDir = $BrowserDir
}

$browserNeedle = $resolvedBrowserDir.ToLowerInvariant()
$showCommand = if ($Mode -eq "Minimize") { 6 } else { 0 }
$startedAt = Get-Date

if (-not ([System.Management.Automation.PSTypeName]'FgcNative.WindowTools').Type) {
    Add-Type -Namespace FgcNative -Name WindowTools -MemberDefinition @'
public delegate bool EnumWindowsProc(System.IntPtr hWnd, System.IntPtr lParam);

[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, System.IntPtr lParam);

[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindowVisible(System.IntPtr hWnd);

[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);

[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
'@
}

function Get-TargetBrowserProcessIds {
    $ids = [System.Collections.Generic.HashSet[uint32]]::new()
    Get-CimInstance Win32_Process |
        Where-Object {
            $name = "$($_.Name)".ToLowerInvariant()
            $commandLine = "$($_.CommandLine)".ToLowerInvariant()
            $commandLine.Contains($browserNeedle) -and $name -match '^(chrome|chromium|msedge)\.exe$'
        } |
        ForEach-Object {
            [void]$ids.Add([uint32]$_.ProcessId)
        }

    return $ids
}

function Hide-TargetWindows {
    param([Parameter(Mandatory=$true)]$ProcessIds)

    if ($ProcessIds.Count -eq 0) {
        return
    }

    $callback = [FgcNative.WindowTools+EnumWindowsProc]{
        param([IntPtr]$WindowHandle, [IntPtr]$State)

        $windowProcessId = [uint32]0
        [FgcNative.WindowTools]::GetWindowThreadProcessId($WindowHandle, [ref]$windowProcessId) | Out-Null
        if ($script:TargetProcessIds.Contains($windowProcessId) -and [FgcNative.WindowTools]::IsWindowVisible($WindowHandle)) {
            [FgcNative.WindowTools]::ShowWindow($WindowHandle, $script:ShowCommand) | Out-Null
        }

        return $true
    }

    $script:TargetProcessIds = $ProcessIds
    $script:ShowCommand = $showCommand
    [FgcNative.WindowTools]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
}

while ($true) {
    if ($ParentPid -gt 0 -and !(Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
        break
    }

    if ($MaxSeconds -gt 0 -and ((Get-Date) - $startedAt).TotalSeconds -ge $MaxSeconds) {
        break
    }

    Hide-TargetWindows -ProcessIds (Get-TargetBrowserProcessIds)
    Start-Sleep -Milliseconds $PollMilliseconds
}
