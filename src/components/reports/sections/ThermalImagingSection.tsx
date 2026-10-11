/**
 * Thermal Imaging Log / Comparative Matrix — side-by-side Visual + IR pairs
 * with caption and LRF data.
 */

import { useMemo } from 'react';
import { useThermalStore } from '@/stores/thermalStore';
import { hasDisplayableImage, type ReportImageEntry, type ThermalReport } from '@/types/thermal';
import { inputCls, labelCls, nextEntryId, smallBtnCls, type SectionProps } from '../types';

export function ThermalImagingActions({ report, update }: SectionProps<ThermalReport>) {
  const { assets, selectedAssetId } = useThermalStore();
  const selectedAsset = assets.find((a) => a.id === selectedAssetId) ?? null;
  const addImagingEntry = () => {
    const entry: ReportImageEntry = {
      id: nextEntryId(),
      thermalAssetId: selectedAsset?.isRadiometric ? selectedAsset.id : null,
      visualAssetId: null,
      lrfData: '',
      caption: '',
    };
    update({ imagingLog: [...report.imagingLog, entry] });
  };
  return (
    <button onClick={addImagingEntry} className={smallBtnCls}>
      + Add imaging pair
    </button>
  );
}

export function ThermalImagingSection({ report, update }: SectionProps<ThermalReport>) {
  const assets = useThermalStore((s) => s.assets);
  // Only displayable images can be embedded (GeoTIFFs need a working preview)
  const imageAssets = useMemo(() => assets.filter(hasDisplayableImage), [assets]);

  const updateEntry = (id: string, patch: Partial<ReportImageEntry>) =>
    update({ imagingLog: report.imagingLog.map((e) => (e.id === id ? { ...e, ...patch } : e)) });

  const options = imageAssets.map((a) => (
    <option key={a.id} value={a.id}>
      {a.fileName}
    </option>
  ));

  return (
    <>
      {report.imagingLog.length === 0 && (
        <p className="text-[11px] text-gray-500">
          Add side-by-side visual + infrared pairs (walls, windows, doors, roof). The
          currently selected asset's annotated view is used automatically on export.
        </p>
      )}
      <div className="space-y-2">
        {report.imagingLog.map((entry, i) => (
          <div key={entry.id} className="p-2.5 rounded-lg bg-gray-800/50 border border-gray-700">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold text-gray-300">Pair {i + 1}</span>
              <button
                onClick={() => update({ imagingLog: report.imagingLog.filter((e) => e.id !== entry.id) })}
                className="text-gray-500 hover:text-red-400 text-xs"
              >
                Remove
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>Visual (RGB) image</label>
                <select
                  className={inputCls}
                  value={entry.visualAssetId ?? ''}
                  onChange={(e) =>
                    updateEntry(entry.id, { visualAssetId: e.target.value ? Number(e.target.value) : null })
                  }
                >
                  <option value="">— none —</option>
                  {options}
                </select>
              </div>
              <div>
                <label className={labelCls}>Thermal (IR) image</label>
                <select
                  className={inputCls}
                  value={entry.thermalAssetId ?? ''}
                  onChange={(e) =>
                    updateEntry(entry.id, { thermalAssetId: e.target.value ? Number(e.target.value) : null })
                  }
                >
                  <option value="">— none —</option>
                  {options}
                </select>
              </div>
              <div>
                <label className={labelCls}>Caption / location</label>
                <input
                  className={inputCls}
                  value={entry.caption}
                  onChange={(e) => updateEntry(entry.id, { caption: e.target.value })}
                  placeholder="North wall, master bedroom window"
                />
              </div>
              <div>
                <label className={labelCls}>LRF / range data</label>
                <input
                  className={inputCls}
                  value={entry.lrfData}
                  onChange={(e) => updateEntry(entry.id, { lrfData: e.target.value })}
                  placeholder="Distance 24.3 m · target 41.1103, -85.2110"
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
