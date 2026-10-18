#!/usr/bin/env node
// PreToolUse hook (Edit|Write): deny edits to machine-owned or secret files.
// Prints a deny decision as JSON; prints nothing for everything else.
import fs from 'node:fs';
import path from 'node:path';

// Read stdin asynchronously: fs.readFileSync(0) is unreliable on Windows pipes.
let text = '';
if (!process.stdin.isTTY) {
  try { for await (const chunk of process.stdin) text += chunk; } catch { /* no stdin */ }
}
let input = {};
try { input = JSON.parse(text || '{}'); } catch (e) {
  process.stderr.write(`[protect] could not parse hook input: ${e.message}\n`);
  process.exit(1);
}
const raw = input?.tool_input?.file_path;
if (!raw) process.exit(0);

const p = String(raw).replace(/\\/g, '/');
const base = path.posix.basename(p);
const regen = 'machine-owned; regenerate with `node scripts/context/build.mjs`';

const pathRules = [
  [/\/context\/generated\//, regen],
  [/\/context\/manifest\.json$/, regen],
  [/\/context\/links\/graph\.json$/, regen],
  [/\/deps\/dji_thermal_sdk\//, 'proprietary DJI Thermal SDK; extracted by scripts/setup-thermal-sdk.ps1, never edited'],
];
const secretBase = [/^\.dji-api-key$/, /\.key$/, /^\.env$/, /^\.env\..+/, /\.jks$/, /\.keystore$/];
const lockBase = [/^package-lock\.json$/, /^Cargo\.lock$/];

let reason = null;
for (const [re, why] of pathRules) if (re.test(p)) { reason = why; break; }
if (!reason && secretBase.some((re) => re.test(base))) reason = 'secret material; the user manages it by hand';
if (!reason && lockBase.some((re) => re.test(base))) reason = 'lock file; change it through npm or cargo, not by editing';

if (reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${p} is protected (${reason}).`,
    },
  }));
}
process.exit(0);
