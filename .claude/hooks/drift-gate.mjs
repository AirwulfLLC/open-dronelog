#!/usr/bin/env node
// PostToolUse hook (Edit|Write) for Open DroneLog: the fast drift checks you
// would otherwise run by hand. Findings go to stderr with exit 2 so Claude sees
// them in the same turn; the edit itself is never blocked.
//
//   *.ts / *.tsx                       -> tsc --noEmit (whole project, ~8 s)
//                                         + i18n keys used in the edited file
//   sources of context/generated/*     -> node scripts/context/build.mjs, then
//                                         name the context/ files that changed
//   src/i18n/locales/*.json            -> locale key parity against en.json
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Read stdin asynchronously: fs.readFileSync(0) is unreliable on Windows pipes.
let text = '';
if (!process.stdin.isTTY) {
  try { for await (const chunk of process.stdin) text += chunk; } catch { /* no stdin */ }
}
let input = {};
try { input = JSON.parse(text || '{}'); } catch (e) {
  process.stderr.write(`[drift-gate] could not parse hook input: ${e.message}\n`);
  process.exit(1);
}
const raw = input?.tool_input?.file_path;
if (!raw) process.exit(0);

const file = String(raw).replace(/\\/g, '/');
const root = (process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()).replace(/\\/g, '/').replace(/\/$/, '');
const rel = file.toLowerCase().startsWith((root + '/').toLowerCase()) ? file.slice(root.length + 1) : file;
const win = process.platform === 'win32';
const findings = [];

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: win, timeout: 80_000 });
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
}
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}
function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}
const T_CALL = /\bt\(\s*['"]([A-Za-z0-9_.-]+)['"]/g;
const localesDir = path.join(root, 'src/i18n/locales');
const enPath = path.join(localesDir, 'en.json');
const list = (arr, n = 10) => arr.slice(0, n).join(', ') + (arr.length > n ? ', ...' : '');

// 1. TypeScript: type-check the project, and check the edited file's i18n keys.
if (/\.(ts|tsx)$/i.test(rel) && !/\.d\.ts$/i.test(rel)) {
  const r = run('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json']);
  if (r.status !== 0) {
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n');
    findings.push(`tsc --noEmit failed (${out.length} lines):\n${out.slice(0, 40).join('\n')}`);
  }
  if (rel.startsWith('src/') && fs.existsSync(file) && fs.existsSync(enPath)) {
    try {
      const en = new Set(Object.keys(flatten(readJson(enPath))));
      const used = new Set([...fs.readFileSync(file, 'utf8').matchAll(T_CALL)].map((m) => m[1]));
      const missing = [...used].filter((k) => !en.has(k));
      if (missing.length) {
        findings.push(`${missing.length} i18n key(s) used in ${rel} are missing from src/i18n/locales/en.json: ${list(missing)}`);
      }
    } catch (e) {
      findings.push(`i18n check skipped: ${e.message}`);
    }
  }
}

// 2. Sources of the generated context/ artifacts: regenerate and report.
function contextSources() {
  const set = new Set([
    'src-tauri/src/server.rs', 'src-tauri/src/database.rs', 'src-tauri/src/tauri_app.rs',
    'src-tauri/Cargo.toml', 'package.json', 'src/lib/api.ts',
  ]);
  try {
    const ex = fs.readFileSync(path.join(root, 'scripts/context/extract.mjs'), 'utf8');
    for (const m of ex.matchAll(/read(?:Text|Json)\(\s*['"]([^'"]+)['"]/g)) set.add(m[1]);
  } catch { /* extractor missing: keep the defaults */ }
  return set;
}
if (contextSources().has(rel)) {
  const build = run('node', ['scripts/context/build.mjs']);
  if (build.status !== 0) {
    const tail = `${build.stdout || ''}${build.stderr || ''}`.trim().split('\n').slice(-15).join('\n');
    findings.push(`context build failed after editing ${rel}:\n${tail}`);
  } else {
    const st = run('git', ['status', '--porcelain', '--', 'context']);
    const changed = (st.stdout || '').split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
    if (changed.length) {
      findings.push(`context/ artifacts regenerated after editing ${rel}; include them in the commit:\n- ${changed.join('\n- ')}`);
    }
  }
}

// 3. Locale files: parity against en.json (and, for en.json, keys used in code).
if (/^src\/i18n\/locales\/[a-z-]+\.json$/i.test(rel) && fs.existsSync(enPath)) {
  try {
    const en = flatten(readJson(enPath));
    const enSet = new Set(Object.keys(en));
    const isEn = /\/en\.json$/i.test(rel);
    const files = isEn
      ? fs.readdirSync(localesDir).filter((f) => f.endsWith('.json') && f !== 'en.json').sort()
      : [path.posix.basename(rel)];
    const lines = [];
    for (const f of files) {
      const keys = new Set(Object.keys(flatten(readJson(path.join(localesDir, f)))));
      const missing = [...enSet].filter((k) => !keys.has(k));
      const extra = [...keys].filter((k) => !enSet.has(k));
      if (missing.length || extra.length) {
        lines.push(`- ${f}: ${missing.length} missing (${list(missing, 5)})${extra.length ? `; ${extra.length} extra not in en.json (${list(extra, 3)})` : ''}`);
      }
    }
    if (lines.length) findings.push(`Locale parity vs en.json (${enSet.size} keys):\n${lines.join('\n')}`);
    if (isEn) {
      const used = new Set();
      for (const f of walk(path.join(root, 'src'), ['.ts', '.tsx'])) {
        for (const m of fs.readFileSync(f, 'utf8').matchAll(T_CALL)) used.add(m[1]);
      }
      const missing = [...used].filter((k) => !enSet.has(k)).sort();
      if (missing.length) findings.push(`${missing.length} t() key(s) used in src/ are missing from en.json: ${list(missing, 15)}`);
    }
  } catch (e) {
    findings.push(`locale parity check failed: ${e.message}`);
  }
}

if (findings.length) {
  process.stderr.write(`[drift-gate] ${rel}\n${findings.join('\n\n')}\n`);
  process.exit(2);
}
process.exit(0);
