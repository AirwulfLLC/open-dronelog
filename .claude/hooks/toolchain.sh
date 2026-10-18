#!/usr/bin/env bash
# SessionStart hook: one-line toolchain status for the context of each session.
# - Puts cargo on PATH for every later Bash call (via CLAUDE_ENV_FILE).
# - Checks that MSVC Build Tools (VC.Tools.x86.x64) are installed: they were
#   once silently removed and every cargo build then failed on link.exe.
if [ -n "$CLAUDE_ENV_FILE" ]; then
  echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
fi

VSWHERE="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
msvc=""
if [ -x "$VSWHERE" ]; then
  msvc=$("$VSWHERE" -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>/dev/null | tr -d '\r' | head -1)
fi
cargo_v=$("$HOME/.cargo/bin/cargo" --version 2>/dev/null | tr -d '\r')

if [ -n "$msvc" ]; then
  echo "Toolchain OK: ${cargo_v:-cargo NOT found in ~/.cargo/bin}; MSVC Build Tools at $msvc. cargo is on PATH for Bash; in PowerShell prefix \$env:Path = \"\$env:USERPROFILE\\.cargo\\bin;\$env:Path\"."
else
  echo "WARNING: MSVC Build Tools (Microsoft.VisualStudio.Component.VC.Tools.x86.x64) not found by vswhere. cargo builds will fail with 'linker link.exe not found'. Ask the user before reinstalling (multi-GB, needs UAC)."
fi
exit 0
