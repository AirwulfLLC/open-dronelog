/**
 * Embedded Metashape orthomosaic + external map link (shared by both kinds).
 * The import hint names the workflow's own library; extra kind-specific
 * controls (e.g. the deliverables list) render below via `children`.
 */

import { useMemo, type ReactNode } from 'react';
import { useThermalStore } from '@/stores/thermalStore';
import {
  METASHAPE_KIND_LABELS,
  hasDisplayableImage,
  parseMetashapeMeta,
  type ReportBase,
} from '@/types/thermal';
import { inputCls, labelCls, type SectionProps } from '../types';

interface Props extends SectionProps<ReportBase> {
  /** Shown when no orthomosaic is in the library yet. */
  importHint: string;
  children?: ReactNode;
}

export function OrthomosaicSection({ report, update, importHint, children }: Props) {
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
        <p className="text-[11px] text-gray-500">{importHint}</p>
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
        <label className={labelCls}>Orthomosaic map link (hosted Metashape / web map output)</label>
        <input
          className={inputCls}
          value={report.orthomosaicLink}
          onChange={(e) => update({ orthomosaicLink: e.target.value })}
          placeholder="https://…/stitched-map"
        />
      </div>
      {children}
    </>
  );
}
