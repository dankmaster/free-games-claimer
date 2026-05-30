[CmdletBinding()]
param(
    [string]$BrowserDir,
    [switch]$RemoveStoredCredentials,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

if (!$BrowserDir) {
    $BrowserDir = Join-Path $scriptRoot "data\browser"
}

function Write-Info {
    param([AllowEmptyString()][string]$Message)

    if (!$Quiet) {
        Write-Host $Message
    }
}

function Get-FullPath {
    param([Parameter(Mandatory=$true)][string]$Path)

    if (Test-Path -LiteralPath $Path) {
        return (Resolve-Path -LiteralPath $Path).Path
    }

    return [System.IO.Path]::GetFullPath($Path)
}

function Assert-UnderPath {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$Root
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    if (!$fullPath.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify path outside browser profile: $fullPath"
    }
}

function Test-BrowserProfileInUse {
    param([Parameter(Mandatory=$true)][string]$ResolvedBrowserDir)

    $escapedBrowserDir = [regex]::Escape($ResolvedBrowserDir)
    $profileUsers = Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -match '^(chrome|chromium|msedge)\.exe$' -and
            $_.CommandLine -match $escapedBrowserDir
        }

    if ($profileUsers) {
        $ids = ($profileUsers | Select-Object -ExpandProperty ProcessId) -join ", "
        throw "The automation Chromium profile is already open by process id(s): $ids. Close it first, then rerun this script."
    }
}

function Remove-ProfilePath {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$ResolvedBrowserDir
    )

    if (!(Test-Path -LiteralPath $Path)) {
        return $false
    }

    Assert-UnderPath -Path $Path -Root $ResolvedBrowserDir
    Remove-Item -LiteralPath $Path -Recurse -Force
    Write-Info "Removed $Path"
    return $true
}

function Ensure-JsonObject {
    param(
        [Parameter(Mandatory=$true)]$Object,
        [Parameter(Mandatory=$true)][string]$Name
    )

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value -or $property.Value -isnot [pscustomobject]) {
        $value = [pscustomobject]@{}
        if ($property) {
            $Object.$Name = $value
        } else {
            Add-Member -InputObject $Object -MemberType NoteProperty -Name $Name -Value $value
        }
        return $value
    }

    return $property.Value
}

function Set-JsonProperty {
    param(
        [Parameter(Mandatory=$true)]$Object,
        [Parameter(Mandatory=$true)][string]$Name,
        [Parameter(Mandatory=$true)]$Value
    )

    if ($Object.PSObject.Properties[$Name]) {
        $Object.$Name = $Value
    } else {
        Add-Member -InputObject $Object -MemberType NoteProperty -Name $Name -Value $Value
    }
}

function Set-BrowserAutofillPreferences {
    param([Parameter(Mandatory=$true)][string]$PreferencesPath)

    if (Test-Path -LiteralPath $PreferencesPath) {
        $preferencesItem = Get-Item -LiteralPath $PreferencesPath
        $maxPreferencesBytes = 50MB
        if ($preferencesItem.Length -gt $maxPreferencesBytes) {
            $backupPath = "$PreferencesPath.corrupt-$((Get-Date).ToString('yyyyMMdd-HHmmss')).bak"
            Write-Host "Chromium Preferences is unexpectedly large ($($preferencesItem.Length) bytes); moving it to $backupPath"
            Move-Item -LiteralPath $PreferencesPath -Destination $backupPath -Force
            $preferences = [pscustomobject]@{}
        } else {
            $preferences = Get-Content -Raw -LiteralPath $PreferencesPath | ConvertFrom-Json
        }
    } else {
        $preferences = [pscustomobject]@{}
    }

    $autofill = Ensure-JsonObject -Object $preferences -Name "autofill"
    Set-JsonProperty -Object $autofill -Name "profile_enabled" -Value $false
    Set-JsonProperty -Object $autofill -Name "credit_card_enabled" -Value $false
    Set-JsonProperty -Object $autofill -Name "address_enabled" -Value $false

    $profile = Ensure-JsonObject -Object $preferences -Name "profile"
    Set-JsonProperty -Object $profile -Name "password_manager_enabled" -Value $false
    Set-JsonProperty -Object $profile -Name "password_manager_leak_detection" -Value $false
    Set-JsonProperty -Object $preferences -Name "credentials_enable_service" -Value $false

    $json = $preferences | ConvertTo-Json -Depth 100 -Compress
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($PreferencesPath, $json, $utf8NoBom)
    Write-Info "Updated $PreferencesPath"
}

function Clear-StoredCredentialSettings {
    $configPath = Join-Path $scriptRoot "data\config.env"
    if (!(Test-Path -LiteralPath $configPath)) {
        return
    }

    $credentialKeys = @(
        "PASSWORD",
        "EG_PASSWORD",
        "EG_OTPKEY",
        "EG_PARENTALPIN",
        "PG_PASSWORD",
        "PG_OTPKEY",
        "GOG_PASSWORD",
        "AE_PASSWORD"
    )
    $pattern = '^\s*(' + (($credentialKeys | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')\s*='
    $lines = Get-Content -LiteralPath $configPath
    $kept = @($lines | Where-Object { $_ -notmatch $pattern })

    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllLines($configPath, [string[]]$kept, $utf8NoBom)
    Write-Info "Removed stored password/OTP settings from $configPath"
}

$resolvedBrowserDir = Get-FullPath -Path $BrowserDir
New-Item -ItemType Directory -Force -Path $resolvedBrowserDir | Out-Null
Test-BrowserProfileInUse -ResolvedBrowserDir $resolvedBrowserDir

$profiles = @(Get-ChildItem -LiteralPath $resolvedBrowserDir -Directory -Force |
    Where-Object {
        $_.Name -eq "Default" -or
        $_.Name -like "Profile *" -or
        (Test-Path -LiteralPath (Join-Path $_.FullName "Preferences"))
    })

foreach ($profile in $profiles) {
    Set-BrowserAutofillPreferences -PreferencesPath (Join-Path $profile.FullName "Preferences")

    foreach ($name in @(
        "Web Data",
        "Web Data-journal",
        "Web Data-shm",
        "Web Data-wal",
        "Account Web Data",
        "Account Web Data-journal",
        "Account Web Data-shm",
        "Account Web Data-wal",
        "AutofillStrikeDatabase"
    )) {
        Remove-ProfilePath -Path (Join-Path $profile.FullName $name) -ResolvedBrowserDir $resolvedBrowserDir | Out-Null
    }
}

if ($RemoveStoredCredentials) {
    Clear-StoredCredentialSettings
}

Write-Info "Browser autofill cleanup complete. Cookies, sessions, extensions, and Login Data were left in place."
