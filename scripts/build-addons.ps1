# Builds the add-on installers (NSIS) into src-tauri/target/release/bundle/addons/.
#
#   npm run build:addons            # version from package.json
#   .\scripts\build-addons.ps1 -Version 3.4.0
#
# Needs makensis.exe: the copy Tauri downloads when the main installer is
# built (%LOCALAPPDATA%\tauri\NSIS) or an NSIS install on PATH. The thermal
# add-on also needs the DJI Thermal SDK in deps/ (scripts/setup-thermal-sdk.ps1).
param([string]$Version)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Version) {
    $Version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
}

$makensis = (Get-Command makensis -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $makensis) {
    $cached = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
    if (Test-Path $cached) { $makensis = $cached }
}
if (-not $makensis) {
    throw 'makensis.exe not found. Build the main installer once (npx tauri build --bundles nsis) so Tauri downloads NSIS, or install NSIS and put makensis on PATH.'
}

$src = Join-Path $root 'installers\addons'
$out = Join-Path $root 'src-tauri\target\release\bundle\addons'
$build = Join-Path $src '.build'
New-Item -ItemType Directory -Force $out | Out-Null
New-Item -ItemType Directory -Force $build | Out-Null
$sdkDll = Join-Path $root 'deps\dji_thermal_sdk\tsdk-core\lib\windows\release_x64\libdirp.dll'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

Push-Location $src
try {
    foreach ($id in @('thermal', 'photogrammetry')) {
        if ($id -eq 'thermal' -and -not (Test-Path $sdkDll)) {
            Write-Warning "Skipping the thermal add-on: DJI Thermal SDK not found at $sdkDll (run scripts/setup-thermal-sdk.ps1)."
            continue
        }
        # Stamp the manifest with the build version (the committed file says 0.0.0)
        $manifest = Get-Content (Join-Path $src "$id\addon.json") -Raw | ConvertFrom-Json
        $manifest.version = $Version
        $manifestPath = Join-Path $build "$id.addon.json"
        [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), $utf8NoBom)

        Write-Host "Building $id add-on installer v$Version ..."
        & $makensis /V2 "/DVERSION=$Version" "/DMANIFEST=$manifestPath" "/DOUTDIR=$out" "$id-addon.nsi"
        if ($LASTEXITCODE -ne 0) { throw "makensis failed for the $id add-on (exit $LASTEXITCODE)" }
    }
}
finally {
    Pop-Location
}

Get-ChildItem $out -Filter '*.exe' | ForEach-Object {
    Write-Host ("Built: {0} ({1} MB)" -f $_.FullName, [math]::Round($_.Length / 1MB, 1))
}
