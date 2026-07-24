/**
 * Zustand store for the Thermal Studio view.
 */

import { create } from 'zustand';
import type {
  Annotation,
  AnnotationTool,
  AnomalyOptions,
  AnomalyResult,
  MeasureOverrides,
  TempMatrix,
  ThermalAnalysis,
  ThermalAsset,
  ThermalSdkStatus,
} from '@/types/thermal';
import * as thermalApi from '@/lib/thermalApi';

interface ThermalState {
  sdkStatus: ThermalSdkStatus | null;
  assets: ThermalAsset[];
  assetsLoaded: boolean;
  selectedAssetId: number | null;
  /** Object URL of the original file for the selected asset (JPEG preview / video). */
  assetUrl: string | null;
  analysis: ThermalAnalysis | null;
  matrix: TempMatrix | null;
  anomalies: AnomalyResult | null;
  annotations: Annotation[];
  annotationTool: AnnotationTool;
  annotationColor: string;
  annotationStrokeWidth: number;
  paletteKey: string;
  /** Manual palette span; null = auto (image min/max). */
  spanLow: number | null;
  spanHigh: number | null;
  isothermEnabled: boolean;
  isothermLow: number;
  isothermHigh: number;
  isothermMode: 'highlight' | 'solo';
  measureOverrides: MeasureOverrides;
  isImporting: boolean;
  isAnalyzing: boolean;
  error: string | null;

  loadSdkStatus: () => Promise<void>;
  loadAssets: () => Promise<void>;
  importFiles: (files: Array<{ name: string; bytes: Uint8Array } | { path: string }>) => Promise<void>;
  selectAsset: (assetId: number | null) => Promise<void>;
  deleteAsset: (assetId: number) => Promise<void>;
  reanalyze: (overrides?: MeasureOverrides) => Promise<void>;
  runAnomalyDetection: (options?: AnomalyOptions) => Promise<void>;
  clearAnomalies: () => void;
  setPalette: (key: string) => void;
  setSpan: (low: number | null, high: number | null) => void;
  setIsotherm: (enabled: boolean, low?: number, high?: number, mode?: 'highlight' | 'solo') => void;
  setAnnotationTool: (tool: AnnotationTool) => void;
  setAnnotationStyle: (color?: string, strokeWidth?: number) => void;
  setAnnotations: (annotations: Annotation[], persist?: boolean) => void;
  clearError: () => void;
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

function mimeFor(asset: ThermalAsset): string {
  const ext = asset.fileName.toLowerCase().split('.').pop() ?? '';
  if (asset.assetType === 'video') {
    if (ext === 'mov') return 'video/quicktime';
    if (ext === 'avi') return 'video/x-msvideo';
    return 'video/mp4';
  }
  if (ext === 'png') return 'image/png';
  return 'image/jpeg';
}

export const useThermalStore = create<ThermalState>((set, get) => ({
  sdkStatus: null,
  assets: [],
  assetsLoaded: false,
  selectedAssetId: null,
  assetUrl: null,
  analysis: null,
  matrix: null,
  anomalies: null,
  annotations: [],
  annotationTool: 'select',
  annotationColor: '#ff3b30',
  annotationStrokeWidth: 3,
  paletteKey: 'iron',
  spanLow: null,
  spanHigh: null,
  isothermEnabled: false,
  isothermLow: 20,
  isothermHigh: 40,
  isothermMode: 'highlight',
  measureOverrides: {},
  isImporting: false,
  isAnalyzing: false,
  error: null,

  loadSdkStatus: async () => {
    try {
      const sdkStatus = await thermalApi.getThermalSdkStatus();
      set({ sdkStatus });
    } catch (e) {
      set({
        sdkStatus: {
          available: false,
          sdkDir: null,
          error: e instanceof Error ? e.message : String(e),
        },
      });
    }
  },

  loadAssets: async () => {
    try {
      const assets = await thermalApi.listThermalAssets();
      set({ assets, assetsLoaded: true });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), assetsLoaded: true });
    }
  },

  importFiles: async (files) => {
    if (get().isImporting) return; // serialize imports — avoids concurrent backend inserts
    set({ isImporting: true, error: null });
    let firstImported: ThermalAsset | null = null;
    const errors: string[] = [];
    for (const f of files) {
      try {
        const asset =
          'path' in f
            ? await thermalApi.importThermalAsset(f.path)
            : await thermalApi.importThermalAssetBytes(f.name, f.bytes);
        if (!firstImported) firstImported = asset;
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    await get().loadAssets();
    set({
      isImporting: false,
      error: errors.length ? errors.join('\n') : null,
    });
    if (firstImported) {
      await get().selectAsset(firstImported.id);
    }
  },

  selectAsset: async (assetId) => {
    const { selectedAssetId } = get();
    if (assetId === selectedAssetId) return;
    set({
      selectedAssetId: assetId,
      analysis: null,
      matrix: null,
      anomalies: null,
      annotations: [],
      assetUrl: null,
      spanLow: null,
      spanHigh: null,
      isothermEnabled: false,
      error: null,
    });
    if (assetId == null) {
      replaceObjectUrl(null, '');
      return;
    }
    const asset = get().assets.find((a) => a.id === assetId);
    if (!asset) return;

    set({ isAnalyzing: true });
    try {
      // Load the original file for preview
      const fileBytes = await thermalApi.readThermalAssetFile(assetId);
      // Bail if the user already switched to another asset — a stale loser
      // must never revoke the winner's live object URL or overwrite its state.
      if (get().selectedAssetId !== assetId) return;
      const assetUrl = replaceObjectUrl(fileBytes, mimeFor(asset));
      set({ assetUrl });

      // Load persisted annotations
      try {
        const annJson = await thermalApi.getThermalAnnotations(assetId);
        if (get().selectedAssetId !== assetId) return;
        if (annJson) {
          const parsed = JSON.parse(annJson) as Annotation[];
          if (Array.isArray(parsed)) set({ annotations: parsed });
        }
      } catch {
        // annotations are non-critical
      }

      // Radiometric analysis
      if (asset.isRadiometric) {
        const overrides = get().measureOverrides;
        const [analysis, matrix] = await Promise.all([
          thermalApi.analyzeThermalAsset(assetId, overrides),
          thermalApi.getTempMatrix(assetId, overrides),
        ]);
        // Guard against stale selection
        if (get().selectedAssetId === assetId) {
          set({
            analysis,
            matrix,
            isothermLow: Math.round(analysis.stats.mean * 10) / 10,
            isothermHigh: Math.round(analysis.stats.max * 10) / 10,
          });
        }
      }
    } catch (e) {
      if (get().selectedAssetId === assetId) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      if (get().selectedAssetId === assetId) {
        set({ isAnalyzing: false });
      }
    }
  },

  deleteAsset: async (assetId) => {
    try {
      await thermalApi.deleteThermalAsset(assetId);
      if (get().selectedAssetId === assetId) {
        await get().selectAsset(null);
      }
      await get().loadAssets();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  reanalyze: async (overrides) => {
    const { selectedAssetId } = get();
    if (selectedAssetId == null) return;
    const merged = { ...get().measureOverrides, ...(overrides ?? {}) };
    set({ measureOverrides: merged, isAnalyzing: true, error: null });
    try {
      const [analysis, matrix] = await Promise.all([
        thermalApi.analyzeThermalAsset(selectedAssetId, merged),
        thermalApi.getTempMatrix(selectedAssetId, merged),
      ]);
      if (get().selectedAssetId === selectedAssetId) {
        set({ analysis, matrix, anomalies: null });
      }
    } catch (e) {
      if (get().selectedAssetId === selectedAssetId) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      if (get().selectedAssetId === selectedAssetId) {
        set({ isAnalyzing: false });
      }
    }
  },

  runAnomalyDetection: async (options) => {
    const { selectedAssetId, isothermEnabled, isothermLow, isothermHigh } = get();
    if (selectedAssetId == null) return;
    set({ isAnalyzing: true, error: null });
    try {
      const opts: AnomalyOptions = {
        ...(options ?? {}),
      };
      // When the user has isolated a temperature range, restrict detection to it
      if (isothermEnabled && opts.rangeLow == null && opts.rangeHigh == null) {
        opts.rangeLow = isothermLow;
        opts.rangeHigh = isothermHigh;
      }
      const anomalies = await thermalApi.detectAnomalies(
        selectedAssetId,
        opts,
        get().measureOverrides,
      );
      if (get().selectedAssetId === selectedAssetId) {
        set({ anomalies });
      }
    } catch (e) {
      if (get().selectedAssetId === selectedAssetId) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      if (get().selectedAssetId === selectedAssetId) {
        set({ isAnalyzing: false });
      }
    }
  },

  clearAnomalies: () => set({ anomalies: null }),

  setPalette: (key) => set({ paletteKey: key }),

  setSpan: (low, high) => set({ spanLow: low, spanHigh: high }),

  setIsotherm: (enabled, low, high, mode) =>
    set((s) => ({
      isothermEnabled: enabled,
      isothermLow: low ?? s.isothermLow,
      isothermHigh: high ?? s.isothermHigh,
      isothermMode: mode ?? s.isothermMode,
    })),

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
      thermalApi
        .setThermalAnnotations(assetId, JSON.stringify(annotations))
        .catch((e) => console.error('Failed to persist annotations:', e));
    }
  },

  clearError: () => set({ error: null }),
}));
