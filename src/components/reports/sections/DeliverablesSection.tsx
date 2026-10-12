/**
 * Which imported Metashape deliverables the photogrammetry report lists in
 * its Outputs section. The library is shared with the Thermal Studio, so the
 * selection is explicit: only ticked files appear in the report and travel in
 * its bundle.
 */

import { useMemo } from 'react';
import { useThermalStore } from '@/stores/thermalStore';
import {
  METASHAPE_KIND_LABELS,
  parseMetashapeMeta,
  type PhotogrammetryReport,
} from '@/types/thermal';
import { labelCls, type SectionProps } from '../types';

export function DeliverablesSection({ report, update }: SectionProps<PhotogrammetryReport>) {
  const assets = useThermalStore((s) => s.assets);
  const deliverables = useMemo(() => assets.filter((a) => a.source === 'metashape'), [assets]);
  const selected = new Set(report.outputAssetIds);
  // Ids of deliverables deleted since the report was saved are pruned on save;
  // until then they must not inflate the count
  const selectedCount = deliverables.filter((a) => selected.has(a.id)).length;

  const setAll = (ids: number[]) => update({ outputAssetIds: ids });
  const toggle = (id: number) =>
    setAll(selected.has(id) ? report.outputAssetIds.filter((x) => x !== id) : [...report.outputAssetIds, id]);

  if (deliverables.length === 0) return null;

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-1">
        <label className={labelCls}>Deliverables listed in the report</label>
        <div className="flex gap-2 text-[10px]">
          <button onClick={() => setAll(deliverables.map((a) => a.id))} className="text-sky-400 hover:text-sky-300">
            Select all
          </button>
          <button onClick={() => setAll([])} className="text-gray-500 hover:text-white">
            None
          </button>
        </div>
      </div>
      <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-700 divide-y divide-gray-800">
        {deliverables.map((a) => {
          const meta = parseMetashapeMeta(a);
          const on = selected.has(a.id);
          return (
            <label
              key={a.id}
              className={`flex items-center gap-2 px-2.5 py-1.5 text-[11px] cursor-pointer ${
                on ? 'bg-drone-primary/10 text-white' : 'text-gray-400 hover:bg-gray-800/60'
              }`}
            >
              <input type="checkbox" checked={on} onChange={() => toggle(a.id)} className="accent-sky-500" />
              <span className="flex-1 truncate">{a.fileName}</span>
              <span className="text-gray-500 whitespace-nowrap">
                {meta ? METASHAPE_KIND_LABELS[meta.kind] ?? meta.kind : 'Metashape export'}
              </span>
            </label>
          );
        })}
      </div>
      <p className="mt-1 text-[10px] text-gray-500">
        {selectedCount} of {deliverables.length} selected · only ticked files are listed in the
        report and included in its bundle.
      </p>
    </div>
  );
}
