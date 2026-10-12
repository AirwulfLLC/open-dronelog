/**
 * Inline rename for a library item (Thermal Studio and Photogrammetry tab).
 * Edits the stem of the picture's name — the extension is shown but fixed,
 * since it decides how the file is served — commits on Enter or blur, cancels
 * on Escape, and shows the reason a name was refused in place so it can be
 * corrected. The name is what the libraries list and the reports print; the
 * stored file itself is not renamed.
 */

import { useEffect, useRef, useState } from 'react';

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
  // onDone unmounts the editor; the blur that follows must not commit again
  const finishedRef = useRef(false);

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
    if (finishedRef.current || busy) return;
    const next = stem.trim();
    // Unchanged, or focus left an emptied field: nothing to save
    if (next === original.trim() || (fromBlur && !next)) {
      finish();
      return;
    }
    setBusy(true);
    try {
      await onCommit(next + ext);
      finish();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      // Keep the refused name in front of the user (Escape still cancels)
      requestAnimationFrame(() => inputRef.current?.focus());
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
          maxLength={200}
          aria-label="Picture name"
          placeholder="Picture name"
          onChange={(e) => {
            setStem(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
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
          <span className="text-[10px] text-gray-500 flex-shrink-0" title="The file type is kept">
            {ext}
          </span>
        )}
      </div>
      {error && <div className="mt-0.5 text-[10px] text-red-400 whitespace-normal">{error}</div>}
    </div>
  );
}
