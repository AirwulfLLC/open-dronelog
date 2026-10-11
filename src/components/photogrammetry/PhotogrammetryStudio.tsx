/**
 * PhotogrammetryStudio — dashboard space for assembling the Photogrammetry
 * Imagery section of an inspection report: import photos/videos, annotate
 * them, and queue them in the order they should appear in the report.
 *
 * Layout: library (left) · viewer with annotation toolbar (center) · ordered
 * report queue (right).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { useThermalStore } from '@/stores/thermalStore';
import { usePhotogrammetryStore, type PhotoTool } from '@/stores/photogrammetryStore';
import { isThermalSupported } from '@/lib/thermalApi';
import { isWebMode } from '@/lib/api';
import { fmtFrameTime } from '@/lib/photogrammetryExport';
import { ReportBuilder } from '@/components/thermal/ReportBuilder';
import { PhotoViewer } from './PhotoViewer';
import type { PhotogrammetryEntry, ThermalAsset } from '@/types/thermal';

const TOOLS: Array<{ key: PhotoTool; label: string; icon: string; title: string }> = [
  { key: 'select', label: 'Select', icon: '↖', title: 'Select / move annotations (Del to remove)' },
  { key: 'arrow', label: 'Arrow', icon: '→', title: 'Draw arrow' },
  { key: 'circle', label: 'Circle', icon: '◯', title: 'Draw ellipse' },
  { key: 'rect', label: 'Box', icon: '▭', title: 'Draw rectangle' },
  { key: 'freehand', label: 'Draw', icon: '✎', title: 'Freehand drawing' },
  { key: 'text', label: 'Text', icon: 'T', title: 'Add text label' },
];

const ANNOTATION_COLORS = ['#ff3b30', '#ff9f0a', '#ffd60a', '#30d158', '#0a84ff', '#bf5af2', '#ffffff', '#000000'];

const MEDIA_EXTS = new Set(['jpg', 'jpeg', 'png', 'mp4', 'mov', 'avi']);

type LibraryFilter = 'all' | 'image' | 'video';

export function PhotogrammetryStudio() {
  const allAssets = useThermalStore((s) => s.assets);
  const assetsLoaded = useThermalStore((s) => s.assetsLoaded);
  const loadAssets = useThermalStore((s) => s.loadAssets);
  const {
    selectedAssetId,
    assetUrl,
    isLoadingAsset,
    selectAsset,
    importFiles,
    deleteAsset,
    isImporting,
    error,
    clearError,
    annotationTool,
    setAnnotationTool,
    annotationColor,
    setAnnotationStyle,
    annotations,
    setAnnotations,
    queue,
    loadQueue,
    addToReport,
    removeFromReport,
    moveEntry,
    updateEntry,
  } = usePhotogrammetryStore();

  const assets = useMemo(() => allAssets.filter((a) => a.source === 'photogrammetry'), [allAssets]);
  const selectedAsset = assets.find((a) => a.id === selectedAssetId) ?? null;

  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [showReportBuilder, setShowReportBuilder] = useState(false);
  const [reportMenuOpen, setReportMenuOpen] = useState(false);
  const reportMenuRef = useRef<HTMLDivElement>(null);
  const videoTimeRef = useRef(0);
  // Pointer-driven queue reorder. HTML5 drag-and-drop is deliberately not
  // used: Tauri's native drag-drop handler (which file import relies on)
  // swallows DOM drag events on Windows.
  const [dragState, setDragState] = useState<{ id: string; overIndex: number | null } | null>(null);
  const dragStateRef = useRef(dragState);
  dragStateRef.current = dragState;
  // ReportBuilder composes the thermal studio's live view through this ref;
  // from here there is none, so it falls back to stored files.
  const noComposedImage = useRef<(() => Promise<string | null>) | null>(null);

  useEffect(() => {
    if (!isThermalSupported()) return;
    if (!assetsLoaded) loadAssets();
    loadQueue();
  }, [assetsLoaded, loadAssets, loadQueue]);

  // Drop library selections that no longer exist (deleted assets)
  useEffect(() => {
    setChecked((prev) => {
      const next = new Set([...prev].filter((id) => assets.some((a) => a.id === id)));
      return next.size === prev.size ? prev : next;
    });
  }, [assets]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  // The player position belongs to the selected video only
  useEffect(() => {
    videoTimeRef.current = 0;
  }, [selectedAssetId]);

  // Track the pointer for the duration of a queue drag and drop on release
  const dragging = dragState !== null;
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const row = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>('[data-queue-index]');
      const idx = row ? Number(row.dataset.queueIndex) : null;
      setDragState((s) => (s && s.overIndex !== idx ? { ...s, overIndex: idx } : s));
    };
    const onUp = () => {
      const s = dragStateRef.current;
      if (s && s.overIndex != null) moveEntry(s.id, s.overIndex);
      setDragState(null);
    };
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging, moveEntry]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (reportMenuRef.current && !reportMenuRef.current.contains(e.target as Node)) {
        setReportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Tauri desktop delivers native file drops through the webview event (paths),
  // not the DOM — see ThermalStudio for the rationale.
  const [tauriDragActive, setTauriDragActive] = useState(false);
  useEffect(() => {
    if (isWebMode()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === 'over') {
            setTauriDragActive(true);
          } else if (event.payload.type === 'drop') {
            setTauriDragActive(false);
            const paths = event.payload.paths.filter((p: string) =>
              MEDIA_EXTS.has(p.split('.').pop()?.toLowerCase() ?? ''),
            );
            if (paths.length > 0) {
              void usePhotogrammetryStore.getState().importFiles(paths.map((path) => ({ path })));
            }
          } else if (event.payload.type === 'leave') {
            setTauriDragActive(false);
          }
        });
        // Unmounted while the registration was in flight (StrictMode re-runs
        // effects in dev) — a leaked listener would import drops meant for
        // the other studio into this library.
        if (cancelled) {
          stop();
          return;
        }
        unlisten = stop;
      } catch (e) {
        console.warn('Tauri drag-drop listener not available:', e);
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const onDrop = useCallback(
    async (accepted: File[]) => {
      const files = await Promise.all(
        accepted.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
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
    },
  });

  const handleCaptureFrame = useCallback(
    async (blob: Blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const base = selectedAsset?.fileName.replace(/\.[^.]+$/, '') ?? 'frame';
      const stamp = fmtFrameTime(videoTimeRef.current).replace(/[:.]/g, '-');
      await importFiles([{ name: `${base}_frame_${stamp}.png`, bytes }]);
    },
    [importFiles, selectedAsset],
  );

  const handleAddFrame = useCallback(
    (timeS: number) => {
      if (!selectedAsset) return;
      const added = addToReport([selectedAsset.id], timeS);
      setNotice(
        added
          ? `Frame ${fmtFrameTime(timeS)} queued as figure ${usePhotogrammetryStore.getState().queue.length}.`
          : 'That frame is already in the report.',
      );
    },
    [addToReport, selectedAsset],
  );

  const addIds = checked.size > 0 ? [...checked] : selectedAsset ? [selectedAsset.id] : [];
  const handleAddToReport = () => {
    if (addIds.length === 0) return;
    const added = addToReport(addIds);
    setChecked(new Set());
    setNotice(
      added === 0
        ? 'Already in the report.'
        : `Added ${added} to the report (${usePhotogrammetryStore.getState().queue.length} total).`,
    );
  };

  const toggleChecked = (id: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const visibleAssets = useMemo(
    () => (filter === 'all' ? assets : assets.filter((a) => a.assetType === filter)),
    [assets, filter],
  );

  const queuedCount = useMemo(() => {
    const counts = new Map<number, number>();
    for (const e of queue) counts.set(e.assetId, (counts.get(e.assetId) ?? 0) + 1);
    return counts;
  }, [queue]);

  if (!isThermalSupported()) {
    return (
      <div className="w-full h-full flex items-center justify-center p-8">
        <div className="max-w-md text-center space-y-3">
          <div className="text-4xl">📷</div>
          <h2 className="text-lg font-semibold text-white">Photogrammetry</h2>
          <p className="text-sm text-gray-400">
            The photogrammetry library stores media in the local profile and is
            available in the desktop app only.
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
            <span className="text-base">📷</span> Photogrammetry
          </h1>
          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium border bg-sky-500/10 text-sky-300 border-sky-500/40">
            {queue.length} figure{queue.length === 1 ? '' : 's'} queued for the report
          </span>
          {(isImporting || isLoadingAsset) && (
            <span className="text-[11px] text-sky-300 animate-pulse">
              {isImporting ? 'Importing…' : 'Loading…'}
            </span>
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
          <button
            onClick={handleAddToReport}
            disabled={addIds.length === 0}
            className="px-3 py-1.5 rounded-lg bg-emerald-600/80 hover:bg-emerald-600 text-white text-xs font-medium disabled:opacity-40"
            title={
              checked.size > 0
                ? `Add the ${checked.size} checked item(s) to the report`
                : 'Add the selected item to the report'
            }
          >
            + Add to report{checked.size > 0 ? ` (${checked.size})` : ''}
          </button>

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
                <div className="px-3 py-1.5 text-[10px] text-gray-500 border-t border-gray-700 mt-1">
                  Queued figures export in the Photogrammetry Imagery section of the
                  inspection report (PDF/RTF) with their annotations, in the order shown
                  on the right.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 bg-red-500/15 border-b border-red-500/40 text-xs text-red-300 flex items-center justify-between">
          <span className="whitespace-pre-wrap">{error}</span>
          <button onClick={clearError} className="text-red-300 hover:text-white ml-3">✕</button>
        </div>
      )}
      {notice && (
        <div className="px-4 py-1.5 bg-sky-500/10 border-b border-sky-500/30 text-xs text-sky-300 flex justify-between">
          {notice}
          <button onClick={() => setNotice(null)} className="hover:text-white">✕</button>
        </div>
      )}

      {(isDragActive || tauriDragActive) && (
        <div className="absolute inset-0 z-50 bg-drone-primary/20 border-4 border-dashed border-drone-primary flex items-center justify-center pointer-events-none">
          <p className="text-lg font-semibold text-white">Drop photos or videos to import</p>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        {/* Library */}
        <aside className="w-60 flex-shrink-0 border-r border-gray-700 flex flex-col min-h-0 bg-drone-secondary/40">
          <div className="px-3 py-2 border-b border-gray-700 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-300">Library ({assets.length})</span>
            <div className="flex gap-0.5">
              {(
                [
                  ['all', 'All'],
                  ['image', 'Photos'],
                  ['video', 'Videos'],
                ] as Array<[LibraryFilter, string]>
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={`px-1.5 py-0.5 rounded text-[10px] ${
                    filter === key ? 'bg-drone-primary/30 text-white' : 'text-gray-500 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {assets.length === 0 && (
              <div className="p-3 text-[11px] text-gray-500">
                No photos or videos yet. Import the imagery you want in the report, then
                select, annotate and add it in the order it should appear.
              </div>
            )}
            {visibleAssets.map((a) => (
              <LibraryRow
                key={a.id}
                asset={a}
                selected={a.id === selectedAssetId}
                checked={checked.has(a.id)}
                queued={queuedCount.get(a.id) ?? 0}
                onSelect={() => selectAsset(a.id)}
                onToggleChecked={() => toggleChecked(a.id)}
                onQuickAdd={() => {
                  const added = addToReport([a.id]);
                  setNotice(added ? `"${a.fileName}" added to the report.` : 'Already in the report.');
                }}
                onDelete={() => {
                  if (window.confirm(`Delete "${a.fileName}" from the photogrammetry library?`)) {
                    deleteAsset(a.id);
                  }
                }}
              />
            ))}
          </div>
        </aside>

        {/* Viewer */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {selectedAsset ? (
            <>
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
                    if (annotations.length > 0) setAnnotations(annotations.slice(0, -1));
                  }}
                  disabled={annotations.length === 0}
                  className="px-2 py-1 rounded text-xs text-gray-400 hover:text-white disabled:opacity-40"
                  title="Undo last annotation"
                >
                  ↩ Undo
                </button>
                <button
                  onClick={() => {
                    if (annotations.length > 0 && window.confirm('Remove all annotations on this item?')) {
                      setAnnotations([]);
                    }
                  }}
                  disabled={annotations.length === 0}
                  className="px-2 py-1 rounded text-xs text-gray-400 hover:text-white disabled:opacity-40"
                  title="Clear all annotations"
                >
                  ✕ Clear
                </button>
                <span className="ml-auto text-[10px] text-gray-500">
                  {annotations.length} annotation{annotations.length === 1 ? '' : 's'} · saved with the
                  image and drawn into the report
                </span>
              </div>

              <PhotoViewer
                key={selectedAsset.id}
                asset={selectedAsset}
                assetUrl={assetUrl}
                onCaptureFrame={handleCaptureFrame}
                onAddFrame={handleAddFrame}
                onVideoTime={(t) => {
                  videoTimeRef.current = t;
                }}
              />

              <div className="px-3 py-1.5 border-t border-gray-700 text-[10px] text-gray-500 flex flex-wrap gap-x-4 gap-y-0.5">
                <span className="text-gray-300">{selectedAsset.fileName}</span>
                <span>{selectedAsset.assetType === 'video' ? 'Video' : 'Photo'}</span>
                {selectedAsset.cameraModel && <span>{selectedAsset.cameraModel}</span>}
                {selectedAsset.gpsLat != null && selectedAsset.gpsLon != null && (
                  <span>
                    📍 {selectedAsset.gpsLat.toFixed(6)}, {selectedAsset.gpsLon.toFixed(6)}
                  </span>
                )}
                {selectedAsset.capturedAt && <span>{selectedAsset.capturedAt}</span>}
                {(queuedCount.get(selectedAsset.id) ?? 0) > 0 && (
                  <span className="text-emerald-400">
                    In report ×{queuedCount.get(selectedAsset.id)}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center space-y-2 max-w-sm px-6">
                <div className="text-3xl">📷</div>
                <p className="text-sm text-gray-400">
                  Import photos and videos, select one to annotate it, and add it to the
                  report queue. The queue order is the order of figures in the exported
                  report.
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

        {/* Report queue */}
        <aside className="w-72 flex-shrink-0 border-l border-gray-700 flex flex-col min-h-0 bg-drone-secondary/40">
          <div className="px-3 py-2 border-b border-gray-700">
            <div className="text-xs font-semibold text-gray-300">Report images ({queue.length})</div>
            <div className="text-[10px] text-gray-500 mt-0.5">
              Drag ⋮⋮ or use ▲▼ to reorder — this is the order in the report.
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {queue.length === 0 && (
              <div className="p-3 text-[11px] text-gray-500">
                Nothing queued yet. Select items in the library and press “Add to report”,
                or use “Add frame” on a video.
              </div>
            )}
            {queue.map((entry, i) => (
              <QueueRow
                key={entry.id}
                index={i}
                entry={entry}
                asset={allAssets.find((a) => a.id === entry.assetId) ?? null}
                isFirst={i === 0}
                isLast={i === queue.length - 1}
                selected={entry.assetId === selectedAssetId}
                dragging={dragState?.id === entry.id}
                dropTarget={dragState != null && dragState.overIndex === i && dragState.id !== entry.id}
                onSelect={() => selectAsset(entry.assetId)}
                onCaption={(caption) => updateEntry(entry.id, { caption })}
                onMove={(delta) => moveEntry(entry.id, i + delta)}
                onRemove={() => removeFromReport(entry.id)}
                onSnapFrame={
                  entry.assetId === selectedAssetId && selectedAsset?.assetType === 'video'
                    ? () => updateEntry(entry.id, { frameTimeS: videoTimeRef.current })
                    : undefined
                }
                onHandleMouseDown={() => setDragState({ id: entry.id, overIndex: null })}
              />
            ))}
          </div>
          <div className="p-2 border-t border-gray-700">
            <button
              onClick={() => setShowReportBuilder(true)}
              className="w-full py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium"
            >
              Open report builder
            </button>
          </div>
        </aside>
      </div>

      {showReportBuilder && (
        <ReportBuilder
          onClose={() => setShowReportBuilder(false)}
          exportComposedImage={noComposedImage}
        />
      )}
    </div>
  );
}

function LibraryRow({
  asset,
  selected,
  checked,
  queued,
  onSelect,
  onToggleChecked,
  onQuickAdd,
  onDelete,
}: {
  asset: ThermalAsset;
  selected: boolean;
  checked: boolean;
  queued: number;
  onSelect: () => void;
  onToggleChecked: () => void;
  onQuickAdd: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={`group px-2 py-2 border-b border-gray-800 cursor-pointer text-xs flex items-start gap-2 ${
        selected ? 'bg-drone-primary/15 border-l-2 border-l-drone-primary' : 'hover:bg-gray-800/50'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggleChecked}
        onClick={(e) => e.stopPropagation()}
        className="mt-0.5 accent-sky-500 flex-shrink-0"
        title="Check several items, then “Add to report”"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-1">
          <span className={`truncate ${selected ? 'text-white font-medium' : 'text-gray-300'}`}>
            {asset.assetType === 'video' ? '🎬' : '📷'} {asset.fileName}
          </span>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onQuickAdd();
              }}
              className="opacity-0 group-hover:opacity-100 text-emerald-400 hover:text-emerald-300"
              title="Add to report"
            >
              +
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400"
              title="Delete from library"
            >
              🗑
            </button>
          </div>
        </div>
        <div className="text-[10px] text-gray-500 mt-0.5 flex gap-2">
          <span>{asset.assetType === 'video' ? 'Video' : 'Photo'}</span>
          {asset.capturedAt && <span>{asset.capturedAt.split(' ')[0]}</span>}
          {queued > 0 && <span className="text-emerald-400">In report{queued > 1 ? ` ×${queued}` : ''}</span>}
        </div>
      </div>
    </div>
  );
}

function QueueRow({
  index,
  entry,
  asset,
  isFirst,
  isLast,
  selected,
  dragging,
  dropTarget,
  onSelect,
  onCaption,
  onMove,
  onRemove,
  onSnapFrame,
  onHandleMouseDown,
}: {
  index: number;
  entry: PhotogrammetryEntry;
  asset: ThermalAsset | null;
  isFirst: boolean;
  isLast: boolean;
  selected: boolean;
  dragging: boolean;
  /** Another entry is being dragged over this row (it will take this position). */
  dropTarget: boolean;
  onSelect: () => void;
  onCaption: (caption: string) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onSnapFrame?: () => void;
  onHandleMouseDown: () => void;
}) {
  const isVideo = asset?.assetType === 'video';
  return (
    <div
      data-queue-index={index}
      onClick={onSelect}
      className={`px-2 py-2 border-b border-gray-800 text-xs border-t-2 ${
        dropTarget ? 'border-t-sky-400' : 'border-t-transparent'
      } ${dragging ? 'opacity-50' : ''} ${selected ? 'bg-drone-primary/10' : 'hover:bg-gray-800/40'}`}
    >
      <div className="flex items-start gap-1.5">
        {/* Only the handle starts a drag, so the caption field keeps normal text selection */}
        <span
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onHandleMouseDown();
          }}
          onClick={(e) => e.stopPropagation()}
          className="cursor-grab text-gray-500 hover:text-white select-none leading-none pt-0.5"
          title="Drag to reorder"
        >
          ⋮⋮
        </span>
        <span className="w-5 h-5 rounded-full bg-gray-700 text-[10px] font-mono text-gray-200 flex items-center justify-center flex-shrink-0">
          {index + 1}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 text-gray-300 truncate">
            <span>{asset ? (isVideo ? '🎬' : '📷') : '⚠️'}</span>
            <span className="truncate">{asset?.fileName ?? 'Asset no longer in the library'}</span>
          </div>
          {isVideo && (
            <div className="text-[10px] text-gray-500 flex items-center gap-1.5 mt-0.5">
              <span>⏱ frame {fmtFrameTime(entry.frameTimeS)}</span>
              {onSnapFrame && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSnapFrame();
                  }}
                  className="text-sky-400 hover:text-sky-300"
                  title="Use the player's current position for this figure"
                >
                  set to current
                </button>
              )}
            </div>
          )}
          <input
            value={entry.caption}
            onChange={(e) => onCaption(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            placeholder={`Figure ${index + 1} caption`}
            className="mt-1 w-full px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-[11px] text-white placeholder-gray-600 focus:outline-none focus:border-drone-primary"
          />
        </div>
        <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMove(-1);
            }}
            disabled={isFirst}
            className="text-gray-500 hover:text-white disabled:opacity-20 leading-none"
            title="Move up"
          >
            ▲
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMove(1);
            }}
            disabled={isLast}
            className="text-gray-500 hover:text-white disabled:opacity-20 leading-none"
            title="Move down"
          >
            ▼
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="text-gray-500 hover:text-red-400 leading-none mt-0.5"
            title="Remove from report"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
