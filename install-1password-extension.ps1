[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$EnableHeadless
)

$ErrorActionPreference = "Stop"

$project = $PSScriptRoot
$dataDir = Join-Path $project "data"
$extensionsRoot = Join-Path $dataDir "extensions"
$target = Join-Path $extensionsRoot "1password"
$configPath = Join-Path $dataDir "config.env"
$extensionId = "aeblfdkhhhdcdjpifhhbdiojplfjncoa"
$downloadUrl = "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=136.0.7103.25&acceptformat=crx2,crx3&x=id%3D$extensionId%26uc"

function Read-ProtoVarint {
    param(
        [Parameter(Mandatory=$true)][byte[]]$Bytes,
        [Parameter(Mandatory=$true)][ref]$Offset
    )

    [UInt64]$result = 0
    $shift = 0
    while ($true) {
        $b = $Bytes[$Offset.Value]
        $Offset.Value++
        $result = $result -bor ([UInt64]($b -band 0x7f) -shl $shift)
        if (!(($b -band 0x80) -ne 0)) {
            return $result
        }
        $shift += 7
    }
}

function Read-ProtoFields {
    param([Parameter(Mandatory=$true)][byte[]]$Bytes)

    $fields = @()
    $offset = 0
    while ($offset -lt $Bytes.Length) {
        $offsetRef = [ref]$offset
        $tag = Read-ProtoVarint -Bytes $Bytes -Offset $offsetRef
        $offset = $offsetRef.Value
        $fieldNumber = [int]($tag -shr 3)
        $wireType = [int]($tag -band 7)

        if ($wireType -eq 2) {
            $offsetRef = [ref]$offset
            $length = [int](Read-ProtoVarint -Bytes $Bytes -Offset $offsetRef)
            $offset = $offsetRef.Value
            $value = New-Object byte[] $length
            [Array]::Copy($Bytes, $offset, $value, 0, $length)
            $offset += $length
        } elseif ($wireType -eq 0) {
            $offsetRef = [ref]$offset
            $value = Read-ProtoVarint -Bytes $Bytes -Offset $offsetRef
            $offset = $offsetRef.Value
        } else {
            throw "Unsupported protobuf wire type: $wireType"
        }

        $fields += [PSCustomObject]@{
            Number = $fieldNumber
            WireType = $wireType
            Value = $value
        }
    }

    return $fields
}

function Convert-BytesToExtensionId {
    param([Parameter(Mandatory=$true)][byte[]]$Bytes)

    $chars = New-Object System.Text.StringBuilder
    foreach ($byte in $Bytes) {
        [void]$chars.Append([char]([byte][char]'a' + (($byte -shr 4) -band 0x0f)))
        [void]$chars.Append([char]([byte][char]'a' + ($byte -band 0x0f)))
    }
    return $chars.ToString()
}

function Get-PublicKeyExtensionId {
    param([Parameter(Mandatory=$true)][byte[]]$PublicKey)

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha256.ComputeHash($PublicKey)
    } finally {
        $sha256.Dispose()
    }
    $idBytes = New-Object byte[] 16
    [Array]::Copy($hash, 0, $idBytes, 0, 16)
    return Convert-BytesToExtensionId -Bytes $idBytes
}

function Set-ManifestKeyFromCrx {
    param(
        [Parameter(Mandatory=$true)][string]$CrxPath,
        [Parameter(Mandatory=$true)][string]$ManifestPath,
        [Parameter(Mandatory=$true)][string]$ExpectedExtensionId
    )

    $bytes = [System.IO.File]::ReadAllBytes($CrxPath)
    $magic = [System.Text.Encoding]::ASCII.GetString($bytes, 0, 4)
    if ($magic -ne "Cr24") {
        throw "Downloaded file is not a CRX package."
    }

    $version = [BitConverter]::ToUInt32($bytes, 4)
    if ($version -ne 3) {
        Write-Host "Skipping manifest key preservation for CRX version $version."
        return
    }

    $headerLength = [BitConverter]::ToUInt32($bytes, 8)
    $header = New-Object byte[] $headerLength
    [Array]::Copy($bytes, 12, $header, 0, $headerLength)

    $crxId = $null
    $publicKeys = @()
    foreach ($field in Read-ProtoFields -Bytes $header) {
        if ($field.Number -eq 10000) {
            foreach ($signedField in Read-ProtoFields -Bytes $field.Value) {
                if ($signedField.Number -eq 1) {
                    $crxId = Convert-BytesToExtensionId -Bytes $signedField.Value
                }
            }
        }

        if ($field.Number -eq 2 -or $field.Number -eq 3) {
            foreach ($proofField in Read-ProtoFields -Bytes $field.Value) {
                if ($proofField.Number -eq 1) {
                    $publicKeys += ,$proofField.Value
                }
            }
        }
    }

    $selectedPublicKey = $null
    foreach ($publicKey in $publicKeys) {
        $candidateId = Get-PublicKeyExtensionId -PublicKey $publicKey
        if ($candidateId -eq $ExpectedExtensionId -or $candidateId -eq $crxId) {
            $selectedPublicKey = $publicKey
            break
        }
    }

    if (!$selectedPublicKey) {
        throw "Could not find the public key for extension ID $ExpectedExtensionId."
    }

    $manifest = Get-Content -Raw -Path $ManifestPath | ConvertFrom-Json
    $key = [Convert]::ToBase64String($selectedPublicKey)
    if ($manifest.PSObject.Properties.Name -contains "key") {
        $manifest.key = $key
    } else {
        $manifest | Add-Member -NotePropertyName "key" -NotePropertyValue $key
    }
    $manifest | ConvertTo-Json -Depth 100 | Set-Content -Path $ManifestPath -Encoding utf8
}

if (!(Test-Path (Join-Path $project "package.json"))) {
    throw "Could not find free-games-claimer project at $project"
}

New-Item -ItemType Directory -Force -Path $extensionsRoot | Out-Null
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$resolvedRoot = (Resolve-Path $extensionsRoot).Path
if (Test-Path $target) {
    $resolvedTarget = (Resolve-Path $target).Path
    if (!$resolvedTarget.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove extension path outside $resolvedRoot"
    }

    if (!$Force) {
        Write-Host "1Password extension already exists at $target"
        Write-Host "Use -Force to replace it."
    } else {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}

if (!(Test-Path $target)) {
    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("fgc-1password-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

    try {
        $crxPath = Join-Path $tempDir "1password.crx"
        $zipPath = Join-Path $tempDir "1password.zip"

        Write-Host "Downloading official 1Password Chrome extension package..."
        Invoke-WebRequest -Uri $downloadUrl -OutFile $crxPath -MaximumRedirection 5

        $bytes = [System.IO.File]::ReadAllBytes($crxPath)
        $magic = [System.Text.Encoding]::ASCII.GetString($bytes, 0, 4)
        if ($magic -ne "Cr24") {
            throw "Downloaded file is not a CRX package."
        }

        $version = [BitConverter]::ToUInt32($bytes, 4)
        if ($version -eq 2) {
            $publicKeyLength = [BitConverter]::ToUInt32($bytes, 8)
            $signatureLength = [BitConverter]::ToUInt32($bytes, 12)
            $zipOffset = 16 + $publicKeyLength + $signatureLength
        } elseif ($version -eq 3) {
            $headerLength = [BitConverter]::ToUInt32($bytes, 8)
            $zipOffset = 12 + $headerLength
        } else {
            throw "Unsupported CRX version: $version"
        }

        $zipBytes = New-Object byte[] ($bytes.Length - $zipOffset)
        [Array]::Copy($bytes, $zipOffset, $zipBytes, 0, $zipBytes.Length)
        [System.IO.File]::WriteAllBytes($zipPath, $zipBytes)

        New-Item -ItemType Directory -Force -Path $target | Out-Null
        Expand-Archive -LiteralPath $zipPath -DestinationPath $target -Force
        Set-ManifestKeyFromCrx -CrxPath $crxPath -ManifestPath (Join-Path $target "manifest.json") -ExpectedExtensionId $extensionId
    } finally {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$manifest = Join-Path $target "manifest.json"
if (!(Test-Path $manifest)) {
    throw "Installed extension does not contain manifest.json at $manifest"
}

function Set-ConfigValue {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$Key,
        [Parameter(Mandatory=$true)][string]$Value
    )

    $lines = [System.Collections.Generic.List[string]]::new()
    if (Test-Path $Path) {
        foreach ($line in (Get-Content -Path $Path)) {
            $lines.Add($line)
        }
    }

    $updated = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^\s*$([regex]::Escape($Key))\s*=") {
            $lines[$i] = "$Key=$Value"
            $updated = $true
            break
        }
    }

    if (!$updated) {
        $lines.Add("$Key=$Value")
    }

    Set-Content -Path $Path -Value $lines -Encoding utf8
}

$existingExtensionDirs = @()
if (Test-Path $configPath) {
    $currentLine = Get-Content -Path $configPath | Where-Object { $_ -match '^\s*EXTENSION_DIRS\s*=' } | Select-Object -First 1
    if ($currentLine) {
        $existingExtensionDirs = @(($currentLine -replace '^\s*EXTENSION_DIRS\s*=', '').Split(';') |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ })
    }
}

$seenExtensionDirs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$combinedExtensionDirs = @()
foreach ($extensionDir in @($existingExtensionDirs) + @($target)) {
    if ($seenExtensionDirs.Add($extensionDir)) {
        $combinedExtensionDirs += $extensionDir
    }
}
Set-ConfigValue -Path $configPath -Key "EXTENSION_DIRS" -Value ($combinedExtensionDirs -join ';')

if ($EnableHeadless) {
    Set-ConfigValue -Path $configPath -Key "EXTENSIONS_IN_HEADLESS" -Value "1"
}

Write-Host "Installed 1Password extension to:"
Write-Host $target
Write-Host ""
Write-Host "Updated:"
Write-Host $configPath
Write-Host ""
Write-Host "Run a visible claimer session and unlock/sign in to 1Password in the browser extension."
