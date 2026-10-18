---
name: backend-command
description: Scaffold a backend operation for Open DroneLog across all five layers (Tauri command, generate_handler registration, axum route, api.ts wrapper, context regen), or audit parity between the layers with --check.
disable-model-invocation: true
argument-hint: "<snake_case_name> | --check"
allowed-tools: Bash(node *), Bash(git diff *), Read, Grep, Glob
---

Arguments: `$ARGUMENTS`

## `--check`: audit parity

Run the audit and quote its output, then explain each gap in one line:

```bash
node .claude/skills/backend-command/scripts/parity-check.mjs
```

It lists Tauri commands that are (a) defined but not in `generate_handler!`, (b) registered under a name that no `#[tauri::command]` defines, (c) without a route or handler in `src-tauri/src/server.rs` and not in [desktop-only.txt](desktop-only.txt), (d) never named in a TypeScript string literal, and (e) api.ts invoke names missing from `context/generated/tauri-commands.json` (stale context). Intentionally desktop-only commands belong in `desktop-only.txt`, one name or glob per line.

## `<snake_case_name>`: scaffold an operation

Every backend operation lives in five places; skipping one is the usual bug. Read the neighbouring code for each layer before writing anything, and copy its conventions (argument-key casing in `invoke`, error mapping, naming).

1. **Rust command**: `#[tauri::command] pub async fn <name>(..., state: State<'_, AppState>) -> Result<T, String>` in `src-tauri/src/tauri_app.rs` (thermal: `src-tauri/src/thermal/commands.rs`, add-ons: `src-tauri/src/addons/commands.rs`). Database work goes through `Database` methods in `src-tauri/src/database.rs`; a new column needs a `migrate_*_table` tuple there because user databases are upgraded in place.
2. **Registration**: add the name to `tauri::generate_handler![ ... ]` in `tauri_app.rs` (near line 1693). Thermal and add-on commands are listed with their module path, for example `crate::thermal::commands::<name>`.
3. **Web route**: in `server.rs`, an `async fn <name>(pdb: ProfileDb, ...) -> Result<Json<T>, (StatusCode, Json<ErrorResponse>)>` handler plus `.route("/api/<path>", get|post(<name>))` in the router. If the operation is desktop-only by design (needs the DJI SDK, local files, or add-ons), skip this layer and add the name to `desktop-only.txt` instead.
4. **TypeScript wrapper**: in `src/lib/api.ts` (thermal: `thermalApi.ts`, add-ons: `addonsApi.ts`), an exported async function: `if (isWeb) { return fetchJson<T>('/<path>', ...); }` then `const invoke = await getTauriInvoke(); return invoke('<name>', { ... }) as Promise<T>;`. Match the argument-key casing the neighbouring wrappers use for snake_case Rust parameters.
5. **Context**: run `node scripts/context/build.mjs` and include the changed `context/` files in the commit.

Finish by running the `--check` audit and reporting which layers you touched with file:line references. Do not build the installer here; that is `/ship-installer`.
