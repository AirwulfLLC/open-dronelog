# Gotchas — lessons specific to this repository

Repo-level lessons learned the hard way (cross-project lessons live in the user's
`learning.md`). Read before starting work; add an entry after any mistake.

## Build & test harness

- **Tests that build a Tauri mock app belong in `src-tauri/tests/*.rs`, never in a lib
  `#[cfg(test)]` module.** `tauri::test::mock_app()` links the Tauri runtime, whose
  `TaskDialogIndirect` import needs the Common-Controls v6 manifest. `build.rs` adds that
  manifest through `cargo:rustc-link-arg-tests`, and cargo applies that directive only to
  `tests/` targets — the lib's unit-test exe never gets it and dies at load with
  `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139), which looks like a missing DLL but is not.
  Drive commands through `AppState::new_unlocked(db, data_dir)`. (2026-10-14)
- **The drift-gate hook type-checks after every single Edit/Write.** A multi-file change
  reports transient `tsc` errors (unused imports, missing names) until the last edit lands.
  Finish the batch, then run `npx tsc --noEmit` once; do not "fix" the transient errors.
  (2026-10-18)
- `cargo test` from the build scripts runs the FLIR dataset smoke test too; it is skipped
  unless `ODL_FLIR_ADAS_DIR` is set, so never export that variable in the build shell
  unless you want the extra 20 s and sample files written. (2026-10-14)

## Tooling quirks that corrupted files

- **Bash-tool heredocs un-escape `\\` to `\`.** A Python script with `"C:\\path\\to"` in a
  quoted heredoc reached Python as `"C:\path\to"` and wrote a tab (`\t`) into
  `docs/thermal-analysis.md`. Write scripts that contain backslashes with the Write tool
  and run them by path, or build paths with forward slashes. (2026-10-14)
- Several source files are CRLF while the build rewrites `src-tauri/Cargo.toml` to LF;
  `git diff` normalises this, but Python edits must detect the file's own newline
  (`'\r\n' in text`) and reuse it, or the diff shows every line changed. (2026-10-14)
- The `context/` fingerprints (`scripts/context/extract.mjs`) used to hash raw file text,
  so a CRLF checkout produced different hashes than the LF index and every build reported
  "context/ artifacts changed" with nothing changed. `hashText` now normalises line endings;
  if the warning returns with an empty `src-tauri` diff, suspect line endings first.
  (2026-10-19)

## Report rendering

- **PDF key/value rows use a fixed label column (48 mm, 30 mm compact).** A label longer
  than the column must wrap inside it (`pdfWriter.kv` now does), otherwise the value is
  printed over the label — "Reflected (Background) Temperature" was the first casualty.
  Check new labels in the generated PDF, not only in the HTML preview. (2026-10-14)

## JSX

- A `{/* comment */}` cannot sit beside an element inside a ternary branch
  (`cond ? (…) : ({/* c */}<div/>)`): the parenthesised branch must be one expression.
  Use a `//` line comment before the element inside the parentheses, or put the JSX
  comment where siblings are allowed. The drift-gate hook catches it as `')' expected`.
  (2026-10-19)

## Tests that lied

- A smoke test compared the asset re-imported from a bundle against the asset *as first
  imported*, not as it stood at export (renamed, annotated), and failed on correct
  behaviour. Compare against live state fetched right before the operation. (2026-10-14)
- Expectation written from intuition, not from the formula: zooming ×1.2 at the corner of a
  surface narrower than its box centres it (offset 20), it does not pin the edge. Derive the
  expected value from the documented rule before asserting. (2026-10-18)
