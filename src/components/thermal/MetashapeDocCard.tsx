/**
 * Metadata card for Metashape documents that have no in-app preview (PDF
 * reports, camera files, point clouds, GeoTIFFs whose preview failed). Shared
 * by the Thermal Studio and the Photogrammetry tab.
 */

import { METASHAPE_KIND_LABELS, parseMetashapeMeta, type ThermalAsset } from '@/types/thermal';

interface Props {
  asset: ThermalAsset;
  /** How this file travels with reports — differs per workflow. */
  bundleNote?: string;
}

const DEFAULT_BUNDLE_NOTE =
  'This file travels with the inspection: it is stored in the project library and included when exporting an inspection bundle.';

export function MetashapeDocCard({ asset, bundleNote = DEFAULT_BUNDLE_NOTE }: Props) {
  const meta = parseMetashapeMeta(asset);
  const fmtSize = (b?: number) => {
    if (b == null) return '—';
    if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
    if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
    return `${b} B`;
  };
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center p-6">
      <div className="max-w-md w-full p-5 rounded-xl border border-gray-700 bg-gray-800/50">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-3xl">📄</span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white truncate">{asset.fileName}</p>
            <p className="text-xs text-gray-400">
              {meta ? METASHAPE_KIND_LABELS[meta.kind] ?? meta.kind : 'Metashape export'}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-400">
          <span>Size</span>
          <span className="text-gray-200">{fmtSize(meta?.sizeBytes)}</span>
          {meta?.cameraCount != null && (
            <>
              <span>Cameras</span>
              <span className="text-gray-200">{meta.cameraCount.toLocaleString()}</span>
            </>
          )}
          {meta?.markerCount != null && (
            <>
              <span>Markers</span>
              <span className="text-gray-200">{meta.markerCount}</span>
            </>
          )}
          {meta?.crs && (
            <>
              <span>Coordinate system</span>
              <span className="text-gray-200 truncate" title={meta.crs}>{meta.crs}</span>
            </>
          )}
          {meta?.rowCount != null && (
            <>
              <span>Reference rows</span>
              <span className="text-gray-200">{meta.rowCount.toLocaleString()}</span>
            </>
          )}
          {meta?.format && (
            <>
              <span>Format</span>
              <span className="text-gray-200 uppercase">{meta.format}</span>
            </>
          )}
        </div>
        {meta?.previewError && (
          <p className="mt-3 text-[10px] text-amber-400/90">
            No in-app preview could be generated for this GeoTIFF ({meta.previewError}).
            The original file is stored and can be opened externally.
          </p>
        )}
        <button
          onClick={async () => {
            try {
              const { openPath } = await import('@tauri-apps/plugin-opener');
              await openPath(asset.storedPath);
            } catch (e) {
              window.alert(`Could not open file: ${e instanceof Error ? e.message : e}`);
            }
          }}
          className="mt-4 w-full py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium"
        >
          Open in default application
        </button>
        <p className="mt-2 text-[10px] text-gray-500">{bundleNote}</p>
      </div>
    </div>
  );
}
