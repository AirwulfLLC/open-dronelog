/**
 * Free-text section bound to one string field of the report — the quickest
 * way to add a narrative component (action plan, scope, conclusions…).
 */

import type React from 'react';
import { inputCls, type ReportPatch, type SectionProps } from '../types';

export function makeTextSection<R>(
  field: keyof R & string,
  options: { placeholder?: string; minHeight?: number; hint?: string } = {},
): React.ComponentType<SectionProps<R>> {
  const minHeight = options.minHeight ?? 80;
  function TextSection({ report, update }: SectionProps<R>) {
    const value = (report[field] as unknown as string | undefined) ?? '';
    return (
      <>
        {options.hint && <p className="text-[11px] text-gray-500 mb-2">{options.hint}</p>}
        <textarea
          className={inputCls}
          style={{ minHeight }}
          value={value}
          onChange={(e) => update({ [field]: e.target.value } as unknown as ReportPatch<R>)}
          placeholder={options.placeholder}
        />
      </>
    );
  }
  TextSection.displayName = `TextSection(${field})`;
  return TextSection;
}
