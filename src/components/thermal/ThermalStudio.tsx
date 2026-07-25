/**
 * ThermalStudio — dedicated dashboard space for DJI thermal analysis.
 *
 * Layout: asset library (left) · viewer with annotation toolbar (center)
 * · analysis panel (right) · report submenu (top-right).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { useThermalStore } from '@/stores/thermalStore';
import { isThermalSupported } from '@/lib/thermalApi';
import * as thermalApi from '@/lib/thermalApi';
import { ThermalViewer } from './ThermalViewer';
import { AnalysisPanel } from './AnalysisPanel';
import { ReportBuilder } from './ReportBuilder';
import { METASHAPE_KIND_LABELS, hasDisplayableImage, parseMetashapeMeta } from '@/types/thermal';
import { isWebMode } from '@/lib/api';
import type { AnnotationTool, ThermalAsset } from '@/types/thermal';

const TOOLS: Array<{ key: AnnotationTool; label: string; icon: string; title: string }> = [
  { key: 'select', label: 'Select', icon: '↖', title: 'Select / move annotations and nodes (Del to remove)' },
  { key: 'arrow', label: 'Arrow', icon: '→', title: 'Draw arrow' },
  { key: 'circle', label: 'Circle', icon: '◯', title: 'Draw ellipse' },
  { key: 'rect', label: 'Box', icon: '▭', title: 'Draw rectangle' },
  { key: 'freehand', label: 'Draw', icon: '✎', title: 'Freehand drawing' },
  { key: 'text', label: 'Text', icon: 'T', title: 'Add text label' },
  { key: 'node', label: 'Node', icon: '⬤', title: 'Place a heat-flow computation node (samples image temperature)' },
  { key: 'conductor', label: 'Link', icon: '⌁', title: 'Connect two nodes with a conductor (drag node → node)' },
];

const ANNOTATION_COLORS = ['#ff3b30', '#ff9f0a', '#ffd60a', '#30d158', '#0a84ff', '#bf5af2', '#ffffff', '#000000'];

export function ThermalStudio() {
  const {
    sdkStatus,
    assets,
    assetsLoaded,
    selectedAssetId,
    loadSdkStatus,
    loadAssets,
    importFiles,
    selectAsset,
    deleteAsset,
    isImporting,
    isAnalyzing,
    error,
    clearError,
    annotationTool,
    setAnnotationTool,
    annotationColor,
    setAnnotationStyle,
    annotations,
    setAnnotations,
  } = useThermalStore();

  const [showReportBuilder, setShowReportBuilder] = useState(false);
  const [reportMenuOpen, setReportMenuOpen] = useState(false);
  const exportComposedRef = useRef<(() => Promise<string | null>) | null>(null);
  const reportMenuRef = useRef<HTMLDivElement>(null);

  const selectedAsset = assets.find((a) => a.id === selectedAssetId) ?? null;

  useEffect(() => {
    if (!isThermalSupported()) return;
    loadSdkStatus();
    if (!assetsLoaded) loadAssets();
  }, [loadSdkStatus, loadAssets, assetsLoaded]);

  // Close report menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (reportMenuRef.current && !reportMenuRef.current.contains(e.target as Node)) {
        setReportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Tauri desktop intercepts native file drops before they reach the DOM, so
  // react-dropzone never fires there — listen to the webview drag-drop event
  // instead (paths, which also avoids shipping big files over IPC). Extensions
  // are filtered so drops meant for the flight importer (.txt/.csv) pass by.
  const [tauriDragActive, setTauriDragActive] = useState(false);
  useEffect(() => {
    if (isWebMode()) return;
    const DROP_EXTS = new Set([
      'jpg', 'jpeg', 'png', 'mp4', 'mov', 'avi',
      'tif', 'tiff', 'pdf', 'xml', 'las', 'laz', 'ply', 'obj', 'kml', 'kmz',
    ]);
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === 'over') {
            setTauriDragActive(true);
          } else if (event.payload.type === 'drop') {
            setTauriDragActive(false);
            const paths = event.payload.paths.filter((p: string) => {
              const ext = p.split('.').pop()?.toLowerCase() ?? '';
              return DROP_EXTS.has(ext);
            });
            if (paths.length > 0) {
              void useThermalStore.getState().importFiles(paths.map((path) => ({ path })));
            }
          } else if (event.payload.type === 'leave') {
            setTauriDragActive(false);
          }
        });
      } catch (e) {
        console.warn('Tauri drag-drop listener not available:', e);
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const onDrop = useCallback(
    async (accepted: File[]) => {
      const files = await Promise.all(
        accepted.map(async (f) => ({
          name: f.name,
          bytes: new Uint8Array(await f.arrayBuffer()),
        })),
      );
      await importFiles(files);
    },
    [importFiles],
  );

  const { getRootProps, getInputProps, isDragActive, open: openFileDialog } = useDropzone({
    onDrop,
    noClick: true,
    disabled: isImporting,
    accept: {
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/png': ['.png'],
      'video/mp4': ['.mp4'],
      'video/quicktime': ['.mov'],
      'video/x-msvideo': ['.avi'],
      // Agisoft Metashape exports
      'image/tiff': ['.tif', '.tiff'],
      'application/pdf': ['.pdf'],
      'text/xml': ['.xml'],
      'text/csv': ['.csv'],
      'application/vnd.google-earth.kml+xml': ['.kml'],
      'application/octet-stream': ['.las', '.laz', '.ply', '.obj', '.kmz'],
    },
  });

  const handleCaptureFrame = useCallback(
    async (blob: Blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const base = selectedAsset?.fileName.replace(/\.[^.]+$/, '') ?? 'frame';
      await importFiles([{ name: `${base}_frame_${Date.now() % 100000}.png`, bytes }]);
    },
    [importFiles, selectedAsset],
  );

  if (!isThermalSupported()) {
    return (
      <div className="w-full h-full flex items-center justify-center p-8">
        <div className="max-w-md text-center space-y-3">
          <div className="text-4xl">🌡️</div>
          <h2 className="text-lg font-semibold text-white">Thermal Analysis</h2>
          <p className="text-sm text-gray-400">
            Thermal analysis uses the native DJI Thermal SDK and is available in the
            desktop app only.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col min-h-0" {...getRootProps()}>
      <input {...getInputProps()} />

      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700 bg-drone-secondary/60">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-white flex items-center gap-2">
            <span className="text-base">🌡️</span> Thermal Studio
          </h1>
          {sdkStatus && (
            <span
              className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                sdkStatus.available
                  ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/40'
                  : 'bg-red-500/10 text-red-300 border-red-500/40'
              }`}
              title={sdkStatus.available ? `SDK: ${sdkStatus.sdkDir}` : sdkStatus.error ?? ''}
            >
              {sdkStatus.available ? 'DJI Thermal SDK ready' : 'SDK unavailable'}
            </span>
          )}
          {isAnalyzing && (
            <span className="text-[11px] text-sky-300 animate-pulse">Processing…</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={openFileDialog}
            disabled={isImporting}
            className="px-3 py-1.5 rounded-lg bg-drone-primary hover:bg-drone-primary/80 text-white text-xs font-medium disabled:opacity-50"
          >
            {isImporting ? 'Importing…' : '+ Import photos / videos'}
          </button>

          {/* Report submenu */}
          <div ref={reportMenuRef} className="relative">
            <button
              onClick={() => setReportMenuOpen((o) => !o)}
              className="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium flex items-center gap-1.5"
            >
              📄 Report
              <span className={`transition-transform text-[9px] ${reportMenuOpen ? 'rotate-180' : ''}`}>▼</span>
            </button>
            {reportMenuOpen && (
              <div className="absolute right-0 mt-1 w-60 rounded-lg border border-gray-600 bg-gray-800 shadow-xl z-50 py-1 text-xs">
                <button
                  onClick={() => {
                    setReportMenuOpen(false);
                    setShowReportBuilder(true);
                  }}
                  className="w-full text-left px-3 py-2 text-gray-200 hover:bg-drone-primary/20"
                >
                  Open report builder…
                </button>
                <button
                  onClick={async () => {
                    setReportMenuOpen(false);
                    try {
                      const { open } = await import('@tauri-apps/plugin-dialog');
                      const selected = await open({
                        multiple: false,
                        title: 'Import inspection bundle',
                        filters: [{ name: 'Inspection Bundle', extensions: ['odlbundle'] }],
                      });
                      const path = typeof selected === 'string' ? selected : null;
                      if (!path) return;
                      const result = await thermalApi.importThermalBundle(path);
                      await loadAssets();
                      window.alert(
                        `Bundle imported: ${result.importedAssets} new asset(s), ` +
                          `${result.skippedAssets} already present` +
                          (result.reportName ? `, report "${result.reportName}"` : '') +
                          (result.archivedFlights
                            ? `, ${result.archivedFlights} archived flight(s) in the bundle file`
                            : ''),
                      );
                    } catch (e) {
                      window.alert(`Bundle import failed: ${e instanceof Error ? e.message : e}`);
                    }
                  }}
                  className="w-full text-left px-3 py-2 text-gray-200 hover:bg-drone-primary/20"
                >
                  Import inspection bundle…
                </button>
                <div className="px-3 py-1.5 text-[10px] text-gray-500 border-t border-gray-700 mt-1">
                  Build inspection reports (PDF/RTF) from thermal findings, Metashape
                  orthomosaics and linked DJI flights — or exchange complete
                  inspections as single .odlbundle files.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 bg-red-500/15 border-b border-red-500/40 text-xs text-red-300 flex items-center justify-between">
          <span className="whitespace-pre-wrap">{error}</span>
          <button onClick={clearError} className="text-red-300 hover:text-white ml-3">✕</button>
        </div>
      )}

      {/* Drag overlay */}
      {(isDragActive || tauriDragActive) && (
        <div className="absolute inset-0 z-50 bg-drone-primary/20 border-4 border-dashed border-drone-primary flex items-center justify-center pointer-events-none">
          <p className="text-lg font-semibold text-white">
            Drop thermal photos/videos or Metashape exports to import
          </p>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 min-h-0 flex">
        {/* Asset library */}
        <aside className="w-56 flex-shrink-0 border-r border-gray-700 flex flex-col min-h-0 bg-drone-secondary/40">
          <div className="px-3 py-2 border-b border-gray-700 text-xs font-semibold text-gray-300">
            Assets ({assets.length})
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {assets.length === 0 && (
              <div className="p-3 text-[11px] text-gray-500">
                No thermal assets yet. Import DJI radiometric JPEGs (R-JPEG) or
                visual photos/videos to get started.
              </div>
            )}
            {assets.map((a) => (
              <AssetRow
                key={a.id}
                asset={a}
                selected={a.id === selectedAssetId}
                onSelect={() => selectAsset(a.id)}
                onDelete={() => {
                  if (window.confirm(`Delete "${a.fileName}" from the thermal library?`)) {
                    deleteAsset(a.id);
                  }
                }}
              />
            ))}
          </div>
        </aside>

        {/* Viewer area */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {selectedAsset &&
          (selectedAsset.assetType === 'document' ||
            (selectedAsset.assetType === 'image' && !hasDisplayableImage(selectedAsset))) ? (
            <MetashapeDocCard asset={selectedAsset} />
          ) : selectedAsset ? (
            <>
              {/* Annotation toolbar */}
              <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-700 bg-drone-secondary/30 flex-wrap">
                {TOOLS.map((tool) => (
                  <button
                    key={tool.key}
                    onClick={() => setAnnotationTool(tool.key)}
                    title={tool.title}
                    className={`px-2 py-1 rounded text-xs border transition-colors flex items-center gap-1 ${
                      annotationTool === tool.key
                        ? 'bg-drone-primary/20 border-drone-primary text-white'
                        : 'border-transparent text-gray-400 hover:text-white'
                    }`}
                  >
                    <span className="font-mono">{tool.icon}</span>
                    {tool.label}
                  </button>
                ))}
                <div className="w-px h-5 bg-gray-700 mx-1" />
                {ANNOTATION_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setAnnotationStyle(c)}
                    className={`w-4 h-4 rounded-full border ${
                      annotationColor === c ? 'ring-2 ring-sky-400 border-white' : 'border-gray-600'
                    }`}
                    style={{ backgroundColor: c }}
                    title={c}
                  />
                ))}
                <div className="w-px h-5 bg-gray-700 mx-1" />
                <button
                  onClick={() => {
                    if (annotations.length > 0) {
                      setAnnotations(annotations.slice(0, -1));
                    }
                  }}
                  disabled={annotations.length === 0}
                  className="px-2 py-1 rounded text-xs text-gray-400 hover:text-white disabled:opacity-40"
                  title="Undo last annotation"
                >
                  ↩ Undo
                </button>
                <button
                  onClick={() => {
                    if (annotations.length > 0 && window.confirm('Remove all annotations on this image?')) {
                      setAnnotations([]);
                    }
                  }}
                  disabled={annotations.length === 0}
                  className="px-2 py-1 rounded text-xs text-gray-400 hover:text-white disabled:opacity-40"
                  title="Clear all annotations"
                >
                  ✕ Clear
                </button>
              </div>

              <ThermalViewer
                key={selectedAsset.id}
                asset={selectedAsset}
                exportRef={exportComposedRef}
                onCaptureFrame={handleCaptureFrame}
              />

              {/* Asset info strip */}
              <div className="px-3 py-1.5 border-t border-gray-700 text-[10px] text-gray-500 flex flex-wrap gap-x-4 gap-y-0.5">
                <span className="text-gray-300">{selectedAsset.fileName}</span>
                {selectedAsset.cameraModel && <span>{selectedAsset.cameraModel}</span>}
                {selectedAsset.isRadiometric ? (
                  <span className="text-emerald-400">Radiometric · {selectedAsset.width}×{selectedAsset.height}</span>
                ) : (
                  <span>Not radiometric</span>
                )}
                {selectedAsset.gpsLat != null && selectedAsset.gpsLon != null && (
                  <span>
                    📍 {selectedAsset.gpsLat.toFixed(6)}, {selectedAsset.gpsLon.toFixed(6)}
                  </span>
                )}
                {selectedAsset.capturedAt && <span>{selectedAsset.capturedAt}</span>}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center space-y-2 max-w-sm px-6">
                <div className="text-3xl">🌡️</div>
                <p className="text-sm text-gray-400">
                  Import or select a thermal asset to analyze temperatures, isolate
                  ranges, detect anomalies and build inspection reports.
                </p>
                <button
                  onClick={openFileDialog}
                  className="mt-2 px-4 py-2 rounded-lg bg-drone-primary hover:bg-drone-primary/80 text-white text-sm font-medium"
                >
                  Import photos / videos
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Analysis panel */}
        <aside className="w-72 flex-shrink-0 border-l border-gray-700 flex flex-col min-h-0 bg-drone-secondary/40">
          <div className="px-3 py-2 border-b border-gray-700 text-xs font-semibold text-gray-300">
            Analysis
          </div>
          <AnalysisPanel />
        </aside>
      </div>

      {/* Report builder modal */}
      {showReportBuilder && (
        <ReportBuilder
          onClose={() => setShowReportBuilder(false)}
          exportComposedImage={exportComposedRef}
        />
      )}
    </div>
  );
}

function assetIcon(asset: ThermalAsset): string {
  if (asset.source === 'metashape') {
    return asset.assetType === 'image' ? '🗺️' : '📄';
  }
  if (asset.assetType === 'video') return '🎬';
  return asset.isRadiometric ? '🌡️' : '🖼️';
}

function assetSubtitle(asset: ThermalAsset): string {
  if (asset.source === 'metashape') {
    const meta = parseMetashapeMeta(asset);
    return meta ? METASHAPE_KIND_LABELS[meta.kind] ?? meta.kind : 'Metashape export';
  }
  if (asset.isRadiometric) return `Radiometric ${asset.width}×${asset.height}`;
  return asset.assetType === 'video' ? 'Video' : 'Image';
}

function AssetRow({
  asset,
  selected,
  onSelect,
  onDelete,
}: {
  asset: ThermalAsset;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={`group px-3 py-2 border-b border-gray-800 cursor-pointer text-xs ${
        selected ? 'bg-drone-primary/15 border-l-2 border-l-drone-primary' : 'hover:bg-gray-800/50'
      }`}
    >
      <div className="flex items-center justify-between gap-1">
        <span className={`truncate ${selected ? 'text-white font-medium' : 'text-gray-300'}`}>
          {assetIcon(asset)} {asset.fileName}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 flex-shrink-0"
          title="Delete asset"
        >
          🗑
        </button>
      </div>
      <div className="text-[10px] text-gray-500 mt-0.5">
        {assetSubtitle(asset)}
        {asset.capturedAt ? ` · ${asset.capturedAt.split(' ')[0]}` : ''}
      </div>
    </div>
  );
}

/** Metadata card for Metashape documents (PDF reports, camera files, point clouds…). */
function MetashapeDocCard({ asset }: { asset: ThermalAsset }) {
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
        <p className="mt-2 text-[10px] text-gray-500">
          This file travels with the inspection: it is stored in the project library and
          included when exporting an inspection bundle.
        </p>
      </div>
    </div>
  );
}
