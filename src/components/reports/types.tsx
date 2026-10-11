/**
 * Contract between the report shell and its sections. A report kind is a
 * list of sections; adding a component to a report means adding a section
 * definition here-style (title + editor component) plus its export renderer.
 */

import type React from 'react';

/** Everything a section may change: any field except the report's kind. Keeping
 *  `kind` out is what lets a section written against ReportBase plug into
 *  every concrete report type. */
export type ReportPatch<R> = Partial<Omit<R, 'kind'>>;

export interface SectionProps<R> {
  report: R;
  /** Merge a partial update into the report document. */
  update: (patch: ReportPatch<R>) => void;
  setNotice: (message: string | null) => void;
}

export interface ReportSectionDef<R> {
  key: string;
  title: string;
  /** Section body. */
  Component: React.ComponentType<SectionProps<R>>;
  /** Optional controls rendered on the right of the section heading. */
  Actions?: React.ComponentType<SectionProps<R>>;
}

export const inputCls =
  'w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-drone-primary';
export const labelCls = 'block text-[11px] font-medium text-gray-400 mb-1';
export const smallBtnCls = 'px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-white text-[11px]';

let entryCounter = 0;
export function nextEntryId(prefix = 're'): string {
  entryCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${entryCounter}`;
}

export function NumField({
  label,
  value,
  onChange,
  step = 0.1,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
}) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <input
        type="number"
        step={step}
        className={inputCls}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    </div>
  );
}
