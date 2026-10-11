/**
 * Header data shared by every report kind — address, date, weather, the
 * responsible person and a summary — with workflow-specific captions.
 */

import type { ReactNode } from 'react';
import type { ReportBase } from '@/types/thermal';
import type { HeaderLabels } from '@/lib/reports/common';
import { inputCls, labelCls, type SectionProps } from '../types';

interface Props extends SectionProps<ReportBase> {
  labels: HeaderLabels;
  summaryPlaceholder?: string;
  /** Extra fields rendered above the address (e.g. project name). */
  children?: ReactNode;
}

export function HeaderSection({ report, update, labels, summaryPlaceholder, children }: Props) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {children}
      <div className="col-span-2">
        <label className={labelCls}>{labels.address}</label>
        <input
          className={inputCls}
          value={report.propertyAddress}
          onChange={(e) => update({ propertyAddress: e.target.value })}
          placeholder="123 Main St, Springfield"
        />
      </div>
      <div>
        <label className={labelCls}>{labels.date}</label>
        <input
          type="date"
          className={inputCls}
          value={report.inspectionDate}
          onChange={(e) => update({ inspectionDate: e.target.value })}
        />
      </div>
      <div>
        <label className={labelCls}>{labels.person}</label>
        <input
          className={inputCls}
          value={report.inspectorName}
          onChange={(e) => update({ inspectorName: e.target.value })}
        />
      </div>
      <div className="col-span-2">
        <label className={labelCls}>{labels.weather}</label>
        <input
          className={inputCls}
          value={report.weatherConditions}
          onChange={(e) => update({ weatherConditions: e.target.value })}
          placeholder="Overcast, 8 °C, wind 3 m/s NW, no precipitation last 24 h"
        />
      </div>
      <div className="col-span-2">
        <label className={labelCls}>Summary</label>
        <textarea
          className={`${inputCls} min-h-[64px]`}
          value={report.summary}
          onChange={(e) => update({ summary: e.target.value })}
          placeholder={summaryPlaceholder ?? 'Scope, methodology and overall condition summary…'}
        />
      </div>
    </div>
  );
}
