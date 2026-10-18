#!/usr/bin/env node
// Parity audit for Open DroneLog's dual backend (Tauri IPC + axum REST).
// Usage (from the repo root): node .claude/skills/backend-command/scripts/parity-check.mjs [--json]
// Exit code 1 when any non-allowlisted gap exists, else 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const here = path.dirname(fileURLToPath(import.meta.url));
const asJson = process.argv.includes('--json');
const read = (p) => fs.readFileSync(p, 'utf8');
const relOf = (p) => path.relative(root, p).replace(/\\/g, '/');

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'target', 'gen'].includes(e.name)) walk(p, exts, out); }
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

// 1. Commands defined with #[tauri::command].
const defined = new Map();
const cmdRe = /#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
for (const f of walk(path.join(root, 'src-tauri/src'), ['.rs'])) {
  for (const m of read(f).matchAll(cmdRe)) defined.set(m[1], relOf(f));
}

// 2. Commands registered in generate_handler![ ... ] (last path segment of each entry).
const tauriApp = read(path.join(root, 'src-tauri/src/tauri_app.rs'));
const registered = new Set();
const block = tauriApp.match(/generate_handler!\s*\[([\s\S]*?)\]/);
if (block) {
  const body = block[1].replace(/\/\/.*$/gm, '');
  for (const entry of body.split(',')) {
    const name = entry.trim().split('::').pop();
    if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) registered.add(name);
  }
}

// 3. Whole-word mentions in server.rs (handler, route or shared api:: call).
const server = read(path.join(root, 'src-tauri/src/server.rs'));
const hasWeb = (name) => new RegExp(`\\b${name}\\b`).test(server);

// 4. String-literal references anywhere in the frontend.
const tsText = walk(path.join(root, 'src'), ['.ts', '.tsx']).map(read).join('\n');
const inTs = (name) => new RegExp(`['"\`]${name}['"\`]`).test(tsText);

// 5. Context artifact derived from api.ts invoke names.
let ctxCmds = new Set();
try { ctxCmds = new Set(JSON.parse(read(path.join(root, 'context/generated/tauri-commands.json'))).commands); } catch { /* absent */ }
const apiInvokes = new Set(
  [...read(path.join(root, 'src/lib/api.ts')).matchAll(/invoke(?:<[^>]*>)?\(\s*['"]([a-z0-9_]+)['"]/g)].map((m) => m[1]),
);

// Allowlist of desktop-only commands (names or globs).
const allowFile = path.join(here, '..', 'desktop-only.txt');
const globs = fs.existsSync(allowFile)
  ? read(allowFile).split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean)
  : [];
const globRe = (g) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
const allowed = (name) => globs.some((g) => globRe(g).test(name));

const names = [...defined.keys()].sort();
const report = {
  defined: defined.size,
  registered: registered.size,
  allowlistPatterns: globs.length,
  unregistered: names.filter((n) => !registered.has(n)),
  registeredNotDefined: [...registered].filter((n) => !defined.has(n)).sort(),
  noWebRoute: names.filter((n) => !hasWeb(n) && !allowed(n)),
  desktopOnlyByAllowlist: names.filter((n) => !hasWeb(n) && allowed(n)),
  noTypeScriptCaller: names.filter((n) => !inTs(n)),
  staleContext: [...apiInvokes].filter((n) => !ctxCmds.has(n)).sort(),
};
const gaps = report.unregistered.length + report.registeredNotDefined.length + report.noWebRoute.length
  + report.noTypeScriptCaller.length + report.staleContext.length;

if (asJson) {
  console.log(JSON.stringify({ ...report, gaps }, null, 2));
} else {
  const section = (title, arr, hint) => {
    console.log(`\n${title}: ${arr.length}${hint ? `  (${hint})` : ''}`);
    for (const n of arr) console.log(`  - ${n}${defined.has(n) ? `   [${defined.get(n)}]` : ''}`);
  };
  console.log(`Tauri commands defined: ${report.defined}; registered in generate_handler!: ${report.registered}; desktop-only patterns: ${report.allowlistPatterns}`);
  section('Defined but NOT registered in generate_handler!', report.unregistered, 'the frontend cannot call these');
  section('Registered but no #[tauri::command] found', report.registeredNotDefined, 'check the module path');
  section('No web counterpart in server.rs and not allowlisted', report.noWebRoute, 'add a route, or list it in desktop-only.txt');
  section('Never referenced from TypeScript', report.noTypeScriptCaller, 'dead command or missing wrapper');
  section('api.ts invoke names missing from context/generated/tauri-commands.json', report.staleContext, 'run node scripts/context/build.mjs');
  console.log(`\nDesktop-only by allowlist (no web route, expected): ${report.desktopOnlyByAllowlist.length}`);
  console.log(gaps ? `\n${gaps} gap(s) to triage.` : '\nNo gaps.');
}
process.exit(gaps ? 1 : 0);
