# Extracts the DJI Thermal SDK into deps/dji_thermal_sdk for the thermal
# analysis feature. Download the SDK zip from
# https://www.dji.com/downloads/softwares/dji-thermal-sdk and place it in the
# repo root (or pass -ZipPath).
#
# Usage:  ./scripts/setup-thermal-sdk.ps1 [-ZipPath path\to\dji_thermal_sdk_*.zip]

param(
    [string]$ZipPath = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $repoRoot "deps\dji_thermal_sdk"

if (-not $ZipPath) {
    $candidate = Get-ChildItem $repoRoot -Filter "dji_thermal_sdk_*.zip" | Select-Object -First 1
    if (-not $candidate) {
        Write-Error "No dji_thermal_sdk_*.zip found in repo root. Download it from https://www.dji.com/downloads/softwares/dji-thermal-sdk"
    }
    $ZipPath = $candidate.FullName
}

Write-Host "Extracting $ZipPath -> $dest"
Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Force $dest | Out-Null

$zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
try {
    # Keep only what the app needs: C API headers, desktop x64 runtime libs,
    # CLI utilities, sample dataset for testing, and license/readme.
    $wanted = $zip.Entries | Where-Object {
        $_.Name -and $_.FullName -match '^(tsdk-core/(api|lib/(windows|linux)/release_x64)|utility/bin/(windows|linux)/release_x64|dataset/(H20T|M3T)/|Readme\.md|License\.txt|History\.txt)'
    }
    foreach ($e in $wanted) {
        $target = Join-Path $dest $e.FullName
        New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)
    }
    Write-Host "Extracted $($wanted.Count) files."
} finally {
    $zip.Dispose()
}

$dll = Join-Path $dest "tsdk-core\lib\windows\release_x64\libdirp.dll"
if (Test-Path $dll) {
    Write-Host "OK: $dll"
    Write-Host "The desktop app will auto-detect the SDK here in dev builds."
    Write-Host "For packaged builds, copy tsdk-core\lib\<platform>\release_x64\* to a 'tsdk' folder next to the app executable, or set DJI_TSDK_DIR."
} else {
    Write-Warning "libdirp.dll not found after extraction — check the zip contents."
}
