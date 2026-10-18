---
name: ship-installer
description: Verify (tsc, cargo test, context freshness), then build the Open DroneLog NSIS installer and both add-on installers and report artifact paths and sizes. Use when a feature is done and the user wants to test the installed app.
disable-model-invocation: true
argument-hint: "[--skip-tests] [--no-addons] [--dry-run]"
allowed-tools: Bash(pwsh *), Bash(git status *), Bash(ls *)
---

Build the installers the user tests with. Arguments: `$ARGUMENTS`

## Steps

1. Run `git status --short` so the final report can mention uncommitted work. This skill never commits.
2. Map arguments: `--skip-tests` to `-SkipTests`, `--no-addons` to `-NoAddons`, `--dry-run` to `-DryRun`. Launch the build script **in the background** with the Bash tool (`run_in_background: true`). With warm dependencies it takes about 10 minutes (tests ~2.5 min, release build ~6 min):

   ```bash
   pwsh -NoProfile -ExecutionPolicy Bypass -File .claude/skills/ship-installer/scripts/build-installer.ps1 <switches>
   ```

   The script prefixes PATH with `%USERPROFILE%\.cargo\bin`, checks vswhere for MSVC Build Tools, then runs `npx tsc --noEmit`, `cargo test` (unless -SkipTests), `node scripts/context/build.mjs` (warns if `context/` changed), `npx tauri build --bundles nsis`, and `npm run build:addons` (unless -NoAddons). It writes a UTF-8 log to `src-tauri/target/ship-installer.log` and its last line is `SHIP-INSTALLER END exit=<code>`.
3. Wait for the background-task notification. Do not poll with sleep loops; if the user asks meanwhile, say the build is still running.
4. Read the task output. On failure, report the failing step with the relevant error lines and stop. Do not retry blindly, and do not build the installer when verification failed.
5. On success, report:
   - every `*.exe` under `src-tauri/target/release/bundle/nsis/` and `src-tauri/target/release/bundle/addons/` with size in MB (the script prints them);
   - whether `context/` files were regenerated and need committing;
   - the reminder that after upgrading, both add-on installers must be run or the Thermal and Photogrammetry tabs are absent.
6. The user installs and tests the app themselves and commits themselves. Offer, do not commit.
