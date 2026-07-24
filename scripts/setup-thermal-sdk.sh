#!/usr/bin/env bash
# Extracts the DJI Thermal SDK into deps/dji_thermal_sdk for the thermal
# analysis feature. Download the SDK zip from
# https://www.dji.com/downloads/softwares/dji-thermal-sdk and place it in the
# repo root (or pass the path as $1).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$REPO_ROOT/deps/dji_thermal_sdk"
ZIP_PATH="${1:-}"

if [[ -z "$ZIP_PATH" ]]; then
  ZIP_PATH="$(ls "$REPO_ROOT"/dji_thermal_sdk_*.zip 2>/dev/null | head -n1 || true)"
  if [[ -z "$ZIP_PATH" ]]; then
    echo "No dji_thermal_sdk_*.zip found in repo root." >&2
    echo "Download it from https://www.dji.com/downloads/softwares/dji-thermal-sdk" >&2
    exit 1
  fi
fi

echo "Extracting $ZIP_PATH -> $DEST"
mkdir -p "$DEST"
unzip -o "$ZIP_PATH" \
  'tsdk-core/api/*' \
  'tsdk-core/lib/windows/release_x64/*' \
  'tsdk-core/lib/linux/release_x64/*' \
  'utility/bin/windows/release_x64/*' \
  'utility/bin/linux/release_x64/*' \
  'dataset/H20T/*' \
  'dataset/M3T/*' \
  'Readme.md' 'License.txt' 'History.txt' \
  -d "$DEST" >/dev/null

if [[ -f "$DEST/tsdk-core/lib/linux/release_x64/libdirp.so" ]]; then
  echo "OK: $DEST/tsdk-core/lib/linux/release_x64/libdirp.so"
  echo "The desktop app will auto-detect the SDK here in dev builds."
  echo "For packaged builds, copy tsdk-core/lib/<platform>/release_x64/* to a 'tsdk' folder next to the app executable, or set DJI_TSDK_DIR."
else
  echo "WARNING: libdirp.so not found after extraction — check the zip contents." >&2
fi
