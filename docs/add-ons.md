# Add-ons

The analysis studios are **add-ons**: optional feature packs that are
installed separately from the main application and show up as their own tab
in the sidebar. This keeps the core flight-log app small and lets each
studio ship on its own schedule (the Thermal add-on, for example, carries the
proprietary DJI Thermal SDK runtime that cannot be redistributed with the
open-source core).

| Add-on | Installer | Provides |
|---|---|---|
| **Thermal Analysis Studio** | `OpenDroneLog-Thermal-Addon_<version>_x64-setup.exe` | The Thermal tab (see [thermal-analysis.md](thermal-analysis.md)) and the DJI Thermal SDK runtime |
| **Photogrammetry** | `OpenDroneLog-Photogrammetry-Addon_<version>_x64-setup.exe` | The Photogrammetry tab (photo/video library, Metashape deliverables, survey reports) |

## Installing

1. Download the add-on installer from the releases page (the **Add-ons**
   screen links to it).
2. Run it. It installs per user — no administrator rights needed — into the
   app's add-ons folder.
3. In Open DroneLog open **Add-ons** (the puzzle-piece button next to
   Settings) and press **Refresh**. The add-on's tab appears in the sidebar
   view toggle.

The Add-ons screen also lets you **disable** an add-on (hides its tab, keeps
its files) and **remove** it (deletes its folder; imported data stays in the
profile database). Add-ons can also be uninstalled from Windows' *Apps*
settings like any other program.

## How it works

An add-on is a folder in the app data directory:

```
%APPDATA%\com.drone-logbook\addons\<id>\addon.json
%APPDATA%\com.drone-logbook\addons\thermal\tsdk\*.dll   (Thermal: SDK runtime)
```

`addon.json` is the manifest:

```json
{
  "id": "thermal",
  "name": "Thermal Analysis Studio",
  "version": "3.3.1",
  "description": "…",
  "provides": ["thermal"]
}
```

The app scans this folder at startup (and on Refresh). A folder whose
manifest is valid and whose `id` matches the folder name is an installed
add-on; the features it `provides` switch on the matching tabs. Ids the user
disabled are kept in `addons/disabled.json`. The Thermal SDK is looked up in
the add-on's `tsdk/` folder before the other locations described in the
thermal documentation.

## Building the installers

```bash
npm run build:addons
```

`scripts/build-addons.ps1` compiles `installers/addons/*.nsi` with NSIS —
the copy Tauri downloads when the main installer is built
(`%LOCALAPPDATA%\tauri\NSIS\makensis.exe`) or an NSIS install on `PATH` —
stamping each manifest with the version from `package.json`. Installers land
in `src-tauri/target/release/bundle/addons/`. The thermal add-on requires the
DJI Thermal SDK in `deps/` (`scripts/setup-thermal-sdk.ps1`); without it that
add-on is skipped with a warning.

The main installer is built without the SDK (`npx tauri build --bundles
nsis`). `src-tauri/tauri.thermal-sdk.conf.json` still exists for an
all-in-one build that bundles the SDK next to the executable, which the app
also recognises.
