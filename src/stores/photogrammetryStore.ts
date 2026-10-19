/**
 * Zustand store for the Photogrammetry tab: the visual photo/video library
 * selection, annotation editing, and the ordered "report images" queue. The
 * queue order is the order of the Photogrammetry Imagery section in exported
 * reports; it persists per profile so a report can be assembled over time.
 *
 * Assets themselves live in the shared thermal asset list (useThermalStore)
 * filtered by `source === 'photogrammetry'`, so both studios see one library.
 */

import { create } from 'zustand';
import type { Annotation, AnnotationTool, PhotogrammetryEntry } from '@/types/thermal';
import { hasDisplayableImage, previewMimeType } from '@/types/thermal';
import * as thermalApi from '@/lib/thermalApi';
import { getSettingValue, setSettingValue } from '@/lib/api';
import { makeDebouncedPersister } from '@/lib/debouncedPersister';
import { useThermalStore } from '@/stores/thermalStore';

/** Tools available on photogrammetry media: drawing tools and zoom, no heat-flow network. */
export type PhotoTool = Exclude<AnnotationTool, 'node' | 'conductor'>;

/** Profile-scoped setting holding the report queue between sessions. */
export const QUEUE_SETTING_KEY = 'photogrammetry_report_queue';

type ImportFile = { name: string; bytes: Uint8Array } | { path: string };

const MEDIA_EXTS = new Set(['jpg', 'jpeg', 'png', 'mp4', 'mov', 'avi']);

/** Photos/videos are filed in the photogrammetry library; everything else
 *  (Metashape exports) is auto-classified by the backend and shared. */
function sourceFor(fileName: string): 'photogrammetry' | undefined {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return MEDIA_EXTS.has(ext) ? 'photogrammetry' : undefined;
}

interface PhotogrammetryState {
  selectedAssetId: number | null;
  /** Object URL of the selected photo/video. */
  assetUrl: string | null;
  isLoadingAsset: boolean;
  annotations: Annotation[];
  annotationTool: PhotoTool;
  annotationColor: string;
  annotationStrokeWidth: number;
  /** Ordered report figures. */
  queue: PhotogrammetryEntry[];
  queueLoaded: boolean;
  isImporting: boolean;
  error: string | null;

  loadQueue: () => Promise<void>;
  importFiles: (files: ImportFile[]) => Promise<void>;
  selectAsset: (assetId: number | null) => Promise<void>;
  deleteAsset: (assetId: number) => Promise<void>;
  setAnnotationTool: (tool: PhotoTool) => void;
  setAnnotationStyle: (color?: string, strokeWidth?: number) => void;
  setAnnotations: (annotations: Annotation[], persist?: boolean) => void;
  /** Write pending annotation edits; await before composing report figures. */
  flushAnnotations: () => Promise<void>;
  /** Re-read the selected asset's annotations — Metashape assets are shared
   *  with the Thermal Studio, which may have edited them meanwhile. */
  refreshAnnotations: () => Promise<void>;
  /** Append assets to the report queue; returns how many entries were added.
   *  Photos are queued once; videos once per distinct frame time. */
  addToReport: (assetIds: number[], frameTimeS?: number) => number;
  removeFromReport: (entryId: string) => void;
  moveEntry: (entryId: string, toIndex: number) => void;
  updateEntry: (
    entryId: string,
    patch: Partial<Pick<PhotogrammetryEntry, 'caption' | 'frameTimeS'>>,
  ) => void;
  /** Replace the whole queue (e.g. when loading a saved report). */
  setQueue: (entries: PhotogrammetryEntry[]) => void;
  clearError: () => void;
}

type AssetJson = { assetId: number; json: string };

const annotationsPersister = makeDebouncedPersister<AssetJson>(
  ({ assetId, json }) => thermalApi.setThermalAnnotations(assetId, json),
  'photogrammetry annotations',
);
const queuePersister = makeDebouncedPersister<string>(
  async (json) => {
    await setSettingValue(QUEUE_SETTING_KEY, json);
  },
  'photogrammetry report queue',
);

let entryCounter = 0;
function nextEntryId(): string {
  entryCounter += 1;
  return `pg_${Date.now().toString(36)}_${entryCounter}`;
}

let currentObjectUrl: string | null = null;

function replaceObjectUrl(bytes: ArrayBuffer | null, mime: string): string | null {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  if (!bytes) return null;
  currentObjectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
  return currentObjectUrl;
}

/** Keep only well-formed entries from persisted JSON. */
export function parseQueue(json: string | null): PhotogrammetryEntry[] {
  if (!json) return [];
  try {
    return sanitizeQueueEntries(JSON.parse(json));
  } catch {
    return [];
  }
}

/** Drop malformed entries (e.g. `assetId: null` left by a bundle import whose
 *  asset was not in the bundle) from an untrusted entries array. */
export function sanitizeQueueEntries(parsed: unknown): PhotogrammetryEntry[] {
  if (!Array.isArray(parsed)) return [];
  const out: PhotogrammetryEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || typeof e.assetId !== 'number') continue;
    const entry: PhotogrammetryEntry = {
      id: e.id,
      assetId: e.assetId,
      caption: typeof e.caption === 'string' ? e.caption : '',
    };
    if (typeof e.frameTimeS === 'number' && Number.isFinite(e.frameTimeS)) {
      entry.frameTimeS = e.frameTimeS;
    }
    out.push(entry);
  }
  return out;
}

const sameFrame = (a: number | undefined, b: number | undefined) =>
  Math.abs((a ?? 0) - (b ?? 0)) < 0.05;

export const usePhotogrammetryStore = create<PhotogrammetryState>((set, get) => {
  const commitQueue = (queue: PhotogrammetryEntry[]) => {
    set({ queue });
    queuePersister.schedule(JSON.stringify(queue));
  };

  return {
    selectedAssetId: null,
    assetUrl: null,
    isLoadingAsset: false,
    annotations: [],
    annotationTool: 'select',
    annotationColor: '#ff3b30',
    annotationStrokeWidth: 3,
    queue: [],
    queueLoaded: false,
    isImporting: false,
    error: null,

    loadQueue: async () => {
      // Once loaded, memory is the source of truth (every edit is persisted
      // through the ordered persister); re-reading would only race with edits.
      if (get().queueLoaded) return;
      const before = get().queue;
      try {
        const json = await getSettingValue(QUEUE_SETTING_KEY);
        // An edit made while the read was in flight wins over the stored copy
        if (get().queue !== before) {
          set({ queueLoaded: true });
          return;
        }
        set({ queue: parseQueue(json), queueLoaded: true });
      } catch (e) {
        set({ queueLoaded: true, error: e instanceof Error ? e.message : String(e) });
      }
    },

    importFiles: async (files) => {
      if (get().isImporting) return; // serialize imports
      set({ isImporting: true, error: null });
      let firstImported: number | null = null;
      const errors: string[] = [];
      for (const f of files) {
        try {
          const asset =
            'path' in f
              ? await thermalApi.importThermalAsset(f.path, sourceFor(f.path))
              : await thermalApi.importThermalAssetBytes(f.name, f.bytes, sourceFor(f.name));
          if (firstImported == null) firstImported = asset.id;
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
      }
      await useThermalStore.getState().loadAssets();
      set({ isImporting: false, error: errors.length ? errors.join('\n') : null });
      if (firstImported != null) {
        await get().selectAsset(firstImported);
      }
    },

    selectAsset: async (assetId) => {
      if (assetId === get().selectedAssetId) return;
      // Persist the outgoing asset's debounced edits (the payload carries its
      // own assetId, so this stays correct after the state switches).
      void annotationsPersister.flush();
      void useThermalStore.getState().flushAssetNotes();
      set({ selectedAssetId: assetId, annotations: [], assetUrl: null, error: null, isLoadingAsset: false });
      if (assetId == null) {
        replaceObjectUrl(null, '');
        return;
      }
      const asset = useThermalStore.getState().assets.find((a) => a.id === assetId);
      if (!asset) return;
      // Documents (PDF, camera XML, point clouds…) and GeoTIFFs without a
      // preview show a metadata card instead of media.
      const displayable = asset.assetType === 'video' || hasDisplayableImage(asset);
      if (!displayable) {
        replaceObjectUrl(null, '');
        return;
      }
      set({ isLoadingAsset: true });
      try {
        // Media and stored annotations arrive together: if the surface became
        // drawable before the stored list landed, a shape drawn in that gap
        // would be persisted alone and the stored annotations lost.
        const [bytes, annJson] = await Promise.all([
          asset.assetType === 'video'
            ? thermalApi.readThermalAssetFile(assetId)
            : thermalApi.readThermalAssetPreview(assetId),
          thermalApi.getThermalAnnotations(assetId).catch(() => null),
        ]);
        // The user may have moved on — a stale loser must not revoke the
        // winner's object URL or overwrite its state.
        if (get().selectedAssetId !== assetId) return;
        let annotations: Annotation[] = [];
        if (annJson) {
          try {
            const parsed: unknown = JSON.parse(annJson);
            if (Array.isArray(parsed)) annotations = parsed as Annotation[];
          } catch {
            // annotations are non-critical
          }
        }
        set({ assetUrl: replaceObjectUrl(bytes, previewMimeType(asset)), annotations });
      } catch (e) {
        if (get().selectedAssetId === assetId) {
          set({ error: e instanceof Error ? e.message : String(e) });
        }
      } finally {
        if (get().selectedAssetId === assetId) set({ isLoadingAsset: false });
      }
    },

    deleteAsset: async (assetId) => {
      try {
        await thermalApi.deleteThermalAsset(assetId);
        if (get().selectedAssetId === assetId) {
          await get().selectAsset(null);
        }
        const remaining = get().queue.filter((e) => e.assetId !== assetId);
        if (remaining.length !== get().queue.length) commitQueue(remaining);
        await useThermalStore.getState().loadAssets();
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    },

    setAnnotationTool: (tool) => set({ annotationTool: tool }),

    setAnnotationStyle: (color, strokeWidth) =>
      set((s) => ({
        annotationColor: color ?? s.annotationColor,
        annotationStrokeWidth: strokeWidth ?? s.annotationStrokeWidth,
      })),

    setAnnotations: (annotations, persist = true) => {
      set({ annotations });
      const assetId = get().selectedAssetId;
      if (persist && assetId != null) {
        annotationsPersister.schedule({ assetId, json: JSON.stringify(annotations) });
      }
    },

    flushAnnotations: () => annotationsPersister.flush(),

    refreshAnnotations: async () => {
      const assetId = get().selectedAssetId;
      if (assetId == null) return;
      const before = get().annotations;
      try {
        const json = await thermalApi.getThermalAnnotations(assetId);
        // Neither a selection change nor an edit made during the read may be
        // overwritten by the stored copy.
        if (get().selectedAssetId !== assetId || get().annotations !== before) return;
        const parsed: unknown = json ? JSON.parse(json) : [];
        set({ annotations: Array.isArray(parsed) ? (parsed as Annotation[]) : [] });
      } catch {
        // keep the in-memory list
      }
    },

    addToReport: (assetIds, frameTimeS) => {
      const assets = useThermalStore.getState().assets;
      const queue = [...get().queue];
      let added = 0;
      for (const assetId of assetIds) {
        const asset = assets.find((a) => a.id === assetId);
        if (!asset) continue;
        const isVideo = asset.assetType === 'video';
        // Only media that can render as a figure (photos, orthomosaic previews, videos)
        if (!isVideo && !hasDisplayableImage(asset)) continue;
        const duplicate = queue.some(
          (e) =>
            e.assetId === assetId && (!isVideo || sameFrame(e.frameTimeS, frameTimeS)),
        );
        if (duplicate) continue;
        const entry: PhotogrammetryEntry = { id: nextEntryId(), assetId, caption: '' };
        if (isVideo) entry.frameTimeS = Math.max(0, frameTimeS ?? 0);
        queue.push(entry);
        added += 1;
      }
      if (added > 0) commitQueue(queue);
      return added;
    },

    removeFromReport: (entryId) => {
      commitQueue(get().queue.filter((e) => e.id !== entryId));
    },

    moveEntry: (entryId, toIndex) => {
      const queue = [...get().queue];
      const from = queue.findIndex((e) => e.id === entryId);
      if (from < 0) return;
      const target = Math.max(0, Math.min(queue.length - 1, toIndex));
      if (target === from) return;
      const [entry] = queue.splice(from, 1);
      queue.splice(target, 0, entry);
      commitQueue(queue);
    },

    updateEntry: (entryId, patch) => {
      commitQueue(get().queue.map((e) => (e.id === entryId ? { ...e, ...patch } : e)));
    },

    setQueue: (entries) => commitQueue(entries),

    clearError: () => set({ error: null }),
  };
});
