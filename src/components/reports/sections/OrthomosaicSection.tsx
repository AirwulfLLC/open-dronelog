/**
 * Embedded Metashape orthomosaic + external map link (shared by both kinds).
 */

import { useMemo } from 'react';
import { useThermalStore } from '@/stores/thermalStore';
import {
  METASHAPE_KIND_LABELS,
  hasDisplayableImage,
  parseMetashapeMeta,
  type ReportBase,
} from '@/types/thermal';
import { inputCls, labelCls, type SectionProps } from '../types';

export function OrthomosaicSection({ report, update }: SectionProps<ReportBase>) {
  const assets = useThermalStore((s) => s.assets);
  const orthoAssets = useMemo(
    () => assets.filter((a) => a.source === 'metashape' && hasDisplayableImage(a)),
    [assets],
  );
  const orthoAsset = assets.find((a) => a.id === report.orthoAssetId) ?? null;
  const meta = orthoAsset ? parseMetashapeMeta(orthoAsset) : null;

  return (
    <>
      {orthoAssets.length === 0 ? (
        <p className="text-[11px] text-gray-500">
          Import a Metashape orthomosaic (GeoTIFF) into the Thermal Studio asset library
          to embed it here. Processing reports, camera files and point clouds can also be
          imported — they travel with exported inspection bundles.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Embedded orthomosaic image</label>
            <select
              className={inputCls}
              value={report.orthoAssetId ?? ''}
              onChange={(e) => update({ orthoAssetId: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">— none —</option>
              {orthoAssets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.fileName}
                </option>
              ))}
            </select>
          </div>
          {meta && (
            <div className="text-[10px] text-gray-500 self-end pb-1">
              {METASHAPE_KIND_LABELS[meta.kind] ?? meta.kind}
              {meta.width ? ` · ${meta.width}×${meta.height}` : ''}
              {meta.crs ? ` · ${meta.crs}` : ''}
            </div>
          )}
        </div>
      )}
      <div className="mt-2">
        <label className={labelCls}>Orthomosaic map link (e.g. hosted DJI Terra / Metashape output)</label>
        <input
          className={inputCls}
          value={report.orthomosaicLink}
          onChange={(e) => update({ orthomosaicLink: e.target.value })}
          placeholder="https://…/stitched-map"
        />
      </div>
    </>
  );
}
