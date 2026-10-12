/**
 * Inline rename for a library item (Thermal Studio and Photogrammetry tab).
 * Edits the stem of the picture's name — the extension is shown but fixed,
 * since it decides how the file is served — commits on Enter or blur, cancels
 * on Escape, and shows the reason a name was refused in place so it can be
 * corrected. The name is what the libraries list and the reports print; the
 * stored file itself is not renamed.
 */

import { useEffect, useRef, useState } from 'react';

/** Mirrors MAX_DISPLAY_NAME_CHARS in src-tauri/src/thermal/mod.rs (stem + extension). */
export const MAX_NAME_CHARS = 200;

/** "DJI_0001.JPG" → stem "DJI_0001", ext ".JPG". Dot-files and bare names
 *  have no extension (the backend splits the same way). */
export function splitExtension(fileName: string): { stem: string; ext: string } {
  const m = /^(.+?)(\.[^.]+)$/.exec(fileName);
  return m ? { stem: m[1], ext: m[2] } : { stem: fileName, ext: '' };
}

interface Props {
  fileName: string;
  /** Persist the full new name; reject with the reason to keep the editor open. */
  onCommit: (fileName: string) => Promise<void>;
  /** Editing finished — committed or cancelled. */
  onDone: () => void;
  className?: string;
}

export function AssetNameEditor({ fileName, onCommit, onDone, className }: Props) {
  const { stem: original, ext } = splitExtension(fileName);
  const [stem, setStem] = useState(original);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Refs, not state: onDone unmounts the editor and disabling the field
  // drops its focus, and the blur either one triggers can arrive before
  // React re-renders — it must not commit again.
  const finishedRef = useRef(false);
  const busyRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onDone();
  };

  const commit = async (fromBlur: boolean) => {
    if (finishedRef.current || busyRef.current) return;
    const next = stem.trim();
    // Unchanged, or focus left an emptied field: nothing to save
    if (next === original.trim() || (fromBlur && !next)) {
      finish();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await onCommit(next + ext);
      finish();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      busyRef.current = false;
      setBusy(false);
      // Enter: disabling the field while busy dropped its focus — give it
      // back. Blur: the user has moved on; the message waits here without
      // pulling the cursor out of wherever they went (a refused name must
      // never trap the focus).
      if (!fromBlur) requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  return (
    <div
      className={className}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-0.5 min-w-0">
        <input
          ref={inputRef}
          value={stem}
          disabled={busy}
          maxLength={MAX_NAME_CHARS - ext.length}
          aria-label="Picture name"
          placeholder="Picture name"
          onChange={(e) => {
            setStem(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            // An IME uses Enter/Escape to confirm or drop a candidate — not ours yet
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit(false);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              finish();
            }
          }}
          onBlur={() => void commit(true)}
          className="flex-1 min-w-0 px-1 py-0.5 bg-gray-900 border border-drone-primary rounded text-xs text-white focus:outline-none disabled:opacity-60"
        />
        {ext && (
          <span
            className="text-[10px] text-gray-500 flex-shrink-0"
            title="The file type is kept"
            // Clicking the label must not blur (and so commit) the field
            onMouseDown={(e) => e.preventDefault()}
          >
            {ext}
          </span>
        )}
      </div>
      {error && (
        <div
          className="mt-0.5 text-[10px] text-red-400 whitespace-normal"
          onMouseDown={(e) => e.preventDefault()}
        >
          {error}
        </div>
      )}
    </div>
  );
}
