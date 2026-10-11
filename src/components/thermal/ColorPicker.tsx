/**
 * Annotation color selector shared by the Thermal Studio and Photogrammetry
 * toolbars: preset swatches plus a rainbow swatch that opens the native color
 * dialog. Custom picks are remembered (most recent first) in localStorage so
 * a project's accent colors stay one click away.
 */

import { useEffect, useRef, useState } from 'react';

export const PRESET_COLORS = [
  '#ff3b30',
  '#ff9f0a',
  '#ffd60a',
  '#30d158',
  '#0a84ff',
  '#bf5af2',
  '#ffffff',
  '#000000',
];

const STORAGE_KEY = 'annotationCustomColors';
const MAX_CUSTOM = 6;
const HEX = /^#[0-9a-f]{6}$/;

function loadCustomColors(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c): c is string => typeof c === 'string' && HEX.test(c))
      .slice(0, MAX_CUSTOM);
  } catch {
    return [];
  }
}

function saveCustomColors(colors: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
  } catch {
    // remembering colors is a convenience only
  }
}

interface Props {
  color: string;
  onChange: (color: string) => void;
}

export function ColorPicker({ color, onChange }: Props) {
  const [custom, setCustom] = useState<string[]>(loadCustomColors);
  const inputRef = useRef<HTMLInputElement>(null);
  const current = color.toLowerCase();
  const isPreset = PRESET_COLORS.includes(current);

  // The native dialog fires `input` while the user drags (live preview via
  // onChange) and `change` once it closes — that final pick is what we keep.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onCommit = () => {
      const c = el.value.toLowerCase();
      if (!HEX.test(c) || PRESET_COLORS.includes(c)) return;
      setCustom((prev) => {
        const next = [c, ...prev.filter((x) => x !== c)].slice(0, MAX_CUSTOM);
        saveCustomColors(next);
        return next;
      });
    };
    el.addEventListener('change', onCommit);
    return () => el.removeEventListener('change', onCommit);
  }, []);

  // A color still being picked is not yet remembered but must show as selected
  const swatches =
    isPreset || custom.includes(current) ? custom : [current, ...custom].slice(0, MAX_CUSTOM);

  const swatch = (c: string, title: string) => (
    <button
      key={c}
      onClick={() => onChange(c)}
      className={`w-4 h-4 rounded-full border flex-shrink-0 ${
        current === c ? 'ring-2 ring-sky-400 border-white' : 'border-gray-600'
      }`}
      style={{ backgroundColor: c }}
      title={title}
    />
  );

  return (
    <div className="flex items-center gap-1">
      {PRESET_COLORS.map((c) => swatch(c, c))}
      {swatches.length > 0 && <div className="w-px h-4 bg-gray-700 mx-0.5" />}
      {swatches.map((c) => swatch(c, `${c} (custom)`))}
      <label
        className="relative w-4 h-4 rounded-full border border-gray-500 cursor-pointer overflow-hidden flex-shrink-0 ml-0.5"
        style={{ background: 'conic-gradient(#f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
        title="Custom color…"
      >
        <input
          ref={inputRef}
          type="color"
          value={isPreset ? '#ff3b30' : current}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          aria-label="Custom annotation color"
        />
      </label>
    </div>
  );
}
