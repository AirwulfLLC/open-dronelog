<#
.SYNOPSIS
  Verify, then build the Open DroneLog NSIS installer and the add-on installers.
.DESCRIPTION
  Steps: PATH + MSVC check -> npx tsc --noEmit -> cargo test -> context/ freshness
  -> npx tauri build --bundles nsis -> npm run build:addons.
  Output is UTF-8 on the console and in src-tauri/target/ship-installer.log.
  The last line is "SHIP-INSTALLER END exit=<code>"; non-zero means a step failed.
.PARAMETER SkipTests
  Skip cargo test.
.PARAMETER NoAddons
  Skip the add-on installers.
.PARAMETER DryRun
  Check prerequisites and print the plan without building.
#>
param(
  [switch]$SkipTests,
  [switch]$NoAddons,
  [switch]$DryRun
)

# Native commands report failure through exit codes; their stderr is ordinary text here.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
Set-Location $root
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"

$logDir = Join-Path $root 'src-tauri\target'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'ship-installer.log'
Set-Content -Path $log -Value "ship-installer started $(Get-Date -Format s)" -Encoding utf8

function Log([string]$msg) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $msg
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding utf8
}

function Finish([int]$code) {
  Log "SHIP-INSTALLER END exit=$code"
  exit $code
}

# Run a native command, stream and log its output, stop the script on a non-zero exit.
function Step([string]$name, [scriptblock]$cmd) {
  Log "==> $name"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $global:LASTEXITCODE = 0
  & $cmd 2>&1 | ForEach-Object {
    $text = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { "$_" }
    Write-Host $text
    Add-Content -Path $log -Value $text -Encoding utf8
  }
  $code = $LASTEXITCODE
  $sw.Stop()
  if ($code -ne 0) {
    Log ('FAILED: {0} (exit {1}, {2}s)' -f $name, $code, [int]$sw.Elapsed.TotalSeconds)
    Finish $code
  }
  Log ('ok: {0} ({1}s)' -f $name, [int]$sw.Elapsed.TotalSeconds)
}

Log "root: $root"

# --- prerequisites -----------------------------------------------------------
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$msvc = $null
if (Test-Path $vswhere) {
  $msvc = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null | Select-Object -First 1
}
if (-not $msvc) {
  Log 'FAILED: MSVC Build Tools (Microsoft.VisualStudio.Component.VC.Tools.x86.x64) not found by vswhere; cargo cannot link. Ask the user before reinstalling.'
  Finish 2
}
Log "MSVC: $msvc"

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Log "FAILED: cargo not found (expected in $env:USERPROFILE\.cargo\bin)"
  Finish 2
}
Log ('cargo: {0}' -f (& cargo --version))

$makensis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
$sdkDll = Join-Path $root 'deps\dji_thermal_sdk\tsdk-core\lib\windows\release_x64\libdirp.dll'
Log ('makensis cached: {0}; DJI Thermal SDK present: {1}' -f (Test-Path $makensis), (Test-Path $sdkDll))
if (-not $NoAddons -and -not (Test-Path $sdkDll)) {
  Log 'note: DJI Thermal SDK missing, so build:addons will skip the thermal add-on (run scripts/setup-thermal-sdk.ps1).'
}

$plan = @('npx tsc --noEmit')
if (-not $SkipTests) { $plan += 'cargo test (src-tauri)' }
$plan += 'node scripts/context/build.mjs'
$plan += 'npx tauri build --bundles nsis'
if (-not $NoAddons) { $plan += 'npm run build:addons' }
Log ('plan: ' + ($plan -join ' -> '))
if ($DryRun) {
  Log 'dry run: nothing built.'
  Finish 0
}

# --- verify ------------------------------------------------------------------
Step 'tsc --noEmit' { npx tsc --noEmit -p tsconfig.json }
if (-not $SkipTests) {
  Step 'cargo test' { cargo test --manifest-path src-tauri/Cargo.toml }
}

# context/ freshness: regenerate and report; stale context does not block the build.
Step 'context build' { node scripts/context/build.mjs }
$ctx = @(git status --porcelain -- context 2>$null | ForEach-Object { $_.Substring(3).Trim() })
if ($ctx.Count -gt 0) {
  Log ('WARNING: context/ artifacts changed; commit them with this work: ' + ($ctx -join ', '))
} else {
  Log 'context/ artifacts are fresh'
}

# --- build -------------------------------------------------------------------
Step 'tauri build (nsis)' { npx tauri build --bundles nsis }
if (-not $NoAddons) {
  Step 'build add-ons' { npm run build:addons }
}

Log 'artifacts:'
foreach ($dir in @('src-tauri\target\release\bundle\nsis', 'src-tauri\target\release\bundle\addons')) {
  $full = Join-Path $root $dir
  if (Test-Path $full) {
    Get-ChildItem $full -Filter '*.exe' | Sort-Object LastWriteTime -Descending | ForEach-Object {
      Log ('  {0}  {1} MB  {2}' -f $_.FullName, [math]::Round($_.Length / 1MB, 1), $_.LastWriteTime.ToString('s'))
    }
  }
}
Finish 0
