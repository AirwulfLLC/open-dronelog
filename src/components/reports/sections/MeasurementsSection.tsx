/**
 * Advanced analysis & measurements taken from the photogrammetry products:
 * stockpile volumes, roof areas, property-line lengths, building heights —
 * each with its value, unit, method and the figure that shows it.
 */

import { usePhotogrammetryStore } from '@/stores/photogrammetryStore';
import { useThermalStore } from '@/stores/thermalStore';
import {
  MEASUREMENT_DEFAULT_UNITS,
  MEASUREMENT_KIND_LABELS,
  type MeasurementEntry,
  type MeasurementKind,
  type PhotogrammetryReport,
} from '@/types/thermal';
import { NumField, inputCls, labelCls, nextEntryId, smallBtnCls, type SectionProps } from '../types';

export function MeasurementsActions({ report, update }: SectionProps<PhotogrammetryReport>) {
  const add = () =>
    update({
      measurements: [
        ...report.measurements,
        { id: nextEntryId('ms'), kind: 'area', feature: '', value: null, unit: 'm²', method: '', figureId: null },
      ],
    });
  return (
    <button onClick={add} className={smallBtnCls}>
      + Add measurement
    </button>
  );
}

export function MeasurementsSection({ report, update }: SectionProps<PhotogrammetryReport>) {
  // Figures come from the live queue (the report's own list is only filled
  // in on save/export), so the dropdown matches the export order
  const queue = usePhotogrammetryStore((s) => s.queue);
  const assets = useThermalStore((s) => s.assets);
  const figureLabel = (entry: (typeof queue)[number], i: number) => {
    const name = entry.caption.trim() || assets.find((a) => a.id === entry.assetId)?.fileName || 'missing asset';
    return `Figure ${i + 1} — ${name}`;
  };
  const updateRow = (id: string, patch: Partial<MeasurementEntry>) =>
    update({ measurements: report.measurements.map((m) => (m.id === id ? { ...m, ...patch } : m)) });

  const changeKind = (m: MeasurementEntry, kind: MeasurementKind) => {
    // Swap in the new kind's default unit unless the user typed their own
    const wasDefault = !m.unit.trim() || m.unit === MEASUREMENT_DEFAULT_UNITS[m.kind];
    updateRow(m.id, { kind, unit: wasDefault ? MEASUREMENT_DEFAULT_UNITS[kind] : m.unit });
  };

  return (
    <div className="space-y-2">
      {report.measurements.length === 0 && (
        <p className="text-[11px] text-gray-500">
          Volumes of stockpiles or earthworks, roof and site areas, boundary lengths, building
          heights and setbacks measured on the orthomosaic, point cloud or model.
        </p>
      )}
      {report.measurements.map((m) => (
        <div key={m.id} className="p-2.5 rounded-lg bg-gray-800/50 border border-gray-700">
          <div className="grid grid-cols-[9rem_1fr_7rem_5rem_1.5rem] gap-2 items-end">
            <div>
              <label className={labelCls}>Type</label>
              <select
                className={inputCls}
                value={m.kind}
                onChange={(e) => changeKind(m, e.target.value as MeasurementKind)}
              >
                {(Object.keys(MEASUREMENT_KIND_LABELS) as MeasurementKind[]).map((k) => (
                  <option key={k} value={k}>
                    {MEASUREMENT_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Feature</label>
              <input
                className={inputCls}
                value={m.feature}
                onChange={(e) => updateRow(m.id, { feature: e.target.value })}
                placeholder="Stockpile A · Main roof · Front setback"
              />
            </div>
            <NumField label="Value" value={m.value} step={0.01} onChange={(v) => updateRow(m.id, { value: v })} />
            <div>
              <label className={labelCls}>Unit</label>
              <input className={inputCls} value={m.unit} onChange={(e) => updateRow(m.id, { unit: e.target.value })} />
            </div>
            <button
              onClick={() => update({ measurements: report.measurements.filter((x) => x.id !== m.id) })}
              className="text-gray-500 hover:text-red-400 text-xs pb-2"
              title="Remove"
            >
              ✕
            </button>
          </div>
          <div className="grid grid-cols-[1fr_14rem] gap-2 mt-2">
            <div>
              <label className={labelCls}>Method / tolerance / remarks</label>
              <input
                className={inputCls}
                value={m.method}
                onChange={(e) => updateRow(m.id, { method: e.target.value })}
                placeholder="Cut/fill against the 2025-03 base surface; ±2 %"
              />
            </div>
            <div>
              <label className={labelCls}>Shown in figure</label>
              <select
                className={inputCls}
                value={m.figureId ?? ''}
                onChange={(e) => updateRow(m.id, { figureId: e.target.value || null })}
              >
                <option value="">—</option>
                {queue.map((f, i) => (
                  <option key={f.id} value={f.id}>
                    {figureLabel(f, i)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
