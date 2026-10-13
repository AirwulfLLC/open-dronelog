/**
 * Thermal Imaging Log / Comparative Matrix — side-by-side Visual + IR pairs
 * with caption, LRF data and the palette / temperature scale the thermal
 * picture is rendered with in the report.
 */

import { useMemo } from 'react';
import { useThermalStore } from '@/stores/thermalStore';
import { PALETTES } from '@/lib/thermalPalettes';
import {
  hasDisplayableImage,
  valueSuffixFor,
  type ReportImageEntry,
  type ThermalAsset,
  type ThermalReport,
} from '@/types/thermal';
import { NumField, inputCls, labelCls, nextEntryId, smallBtnCls, type SectionProps } from '../types';

/** The names a picture can be matched by: the one it was imported under
 *  (the stored file keeps it through library renames) and its current name. */
function nameStems(asset: ThermalAsset): string[] {
  const stored = asset.storedPath.split(/[\\/]/).pop() ?? '';
  return [stored.replace(/^\d+_/, ''), asset.fileName].map((n) => n.replace(/\.[^.]+$/, '').toLowerCase());
}

/** DJI's "YYYY:MM:DD HH:MM:SS" (or ISO) capture time as epoch ms, or null. */
function captureMs(asset: ThermalAsset): number | null {
  if (!asset.capturedAt) return null;
  const ms = Date.parse(asset.capturedAt.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
  return Number.isFinite(ms) ? ms : null;
}

/** DJI stores a thermal frame and its visual twin under one index with a
 *  suffix: …_T or …_R (thermal) beside …_W, …_V or …_Z (wide, visual, zoom).
 *  Indices repeat across flights, so among several candidates the one taken
 *  closest in time wins. */
export function guessVisualPair(thermal: ThermalAsset, assets: ThermalAsset[]): ThermalAsset | null {
  const wanted = new Set<string>();
  for (const stem of nameStems(thermal)) {
    const m = /^(.*)_(t|r)$/.exec(stem);
    if (m) for (const s of ['w', 'v', 'z']) wanted.add(`${m[1]}_${s}`);
  }
  if (wanted.size === 0) return null;
  const candidates = assets.filter(
    (a) =>
      a.id !== thermal.id &&
      a.assetType === 'image' &&
      !a.isRadiometric &&
      a.source !== 'metashape' &&
      nameStems(a).some((stem) => wanted.has(stem)),
  );
  if (candidates.length <= 1) return candidates[0] ?? null;
  const t0 = captureMs(thermal);
  const distance = (a: ThermalAsset) => {
    const t = captureMs(a);
    return t0 == null || t == null ? Infinity : Math.abs(t - t0);
  };
  return candidates.reduce((best, a) => (distance(a) < distance(best) ? a : best));
}

export function ThermalImagingActions({ report, update, setNotice }: SectionProps<ThermalReport>) {
  const { assets, selectedAssetId, paletteKey, spanLow, spanHigh } = useThermalStore();
  const selectedAsset = assets.find((a) => a.id === selectedAssetId) ?? null;

  const newEntry = (thermal: ThermalAsset | null, caption = ''): ReportImageEntry => {
    // The studio's palette is the natural starting point — except the
    // vegetation ramp on a thermal picture, or a thermal palette on an index.
    // A manual span belongs to the picture it was set for, so it is kept only
    // when that picture is the one being added.
    const isIndex = thermal != null && valueSuffixFor(thermal) === '';
    const palette = isIndex ? 'vegetation' : paletteKey === 'vegetation' ? PALETTES[0].key : paletteKey;
    const ownSpan = thermal != null && thermal.id === selectedAssetId;
    return {
      id: nextEntryId(),
      thermalAssetId: thermal?.id ?? null,
      visualAssetId: thermal ? (guessVisualPair(thermal, assets)?.id ?? null) : null,
      lrfData: '',
      caption,
      paletteKey: palette,
      spanLow: ownSpan ? spanLow : null,
      spanHigh: ownSpan ? spanHigh : null,
    };
  };

  const addImagingEntry = () => {
    const thermal = selectedAsset?.isRadiometric ? selectedAsset : null;
    update({ imagingLog: [...report.imagingLog, newEntry(thermal)] });
  };

  /** One pair per picture that carries anomalies and has no pair yet. */
  const addAnomalyPairs = () => {
    const covered = new Set(report.imagingLog.map((e) => e.thermalAssetId));
    const byAsset = new Map<number, string[]>();
    for (const a of report.anomalies) {
      if (a.assetId == null || covered.has(a.assetId)) continue;
      byAsset.set(a.assetId, [...(byAsset.get(a.assetId) ?? []), a.refId]);
    }
    const entries: ReportImageEntry[] = [];
    for (const [assetId, refIds] of byAsset) {
      const asset = assets.find((x) => x.id === assetId);
      if (!asset || !hasDisplayableImage(asset)) continue;
      entries.push(newEntry(asset, refIds.join(', ')));
    }
    if (entries.length === 0) {
      setNotice('Every picture with anomalies already has an imaging pair.');
      return;
    }
    update({ imagingLog: [...report.imagingLog, ...entries] });
    setNotice(`Added ${entries.length} pair(s) for the pictures with anomalies.`);
  };

  return (
    <div className="flex gap-1.5">
      <button onClick={addImagingEntry} className={smallBtnCls}>
        + Add imaging pair
      </button>
      <button
        onClick={addAnomalyPairs}
        disabled={report.anomalies.length === 0}
        className="px-2 py-1 rounded bg-drone-primary/80 hover:bg-drone-primary text-white text-[11px] disabled:opacity-40"
        title="A visual + thermal pair for every picture that has anomalies in the log"
      >
        ⚡ Pairs for anomalies
      </button>
    </div>
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
          Add side-by-side visual + infrared pairs (walls, windows, doors, roof, panels). Thermal
          pictures render in the report with the palette and temperature scale set here, with
          their annotations; the anomalies logged on a picture are listed under its pair.
        </p>
      )}
      <div className="space-y-2">
        {report.imagingLog.map((entry, i) => {
          const thermal = entry.thermalAssetId == null ? null : assets.find((a) => a.id === entry.thermalAssetId);
          return (
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
                {thermal?.isRadiometric && (
                  <div className="col-span-2 grid grid-cols-3 gap-2">
                    <div>
                      <label className={labelCls}>Palette</label>
                      <select
                        className={inputCls}
                        value={entry.paletteKey ?? PALETTES[0].key}
                        onChange={(e) => updateEntry(entry.id, { paletteKey: e.target.value })}
                      >
                        {PALETTES.map((p) => (
                          <option key={p.key} value={p.key}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <NumField
                      label="Scale low (°C, blank = auto)"
                      value={entry.spanLow ?? null}
                      onChange={(v) => updateEntry(entry.id, { spanLow: v })}
                    />
                    <NumField
                      label="Scale high (°C, blank = auto)"
                      value={entry.spanHigh ?? null}
                      onChange={(v) => updateEntry(entry.id, { spanHigh: v })}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
