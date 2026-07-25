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
  NetConductor,
  NetNode,
  NetworkSolveOptions,
  NetworkSolveResult,
  TempMatrix,
  ThermalAnalysis,
  ThermalAsset,
  ThermalNetworkModel,
  ThermalSdkStatus,
} from '@/types/thermal';
import { EMPTY_NETWORK, hasDisplayableImage, valueSuffixFor } from '@/types/thermal';
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
  /** Heat-flow network model for the selected asset. */
  network: ThermalNetworkModel;
  networkResult: NetworkSolveResult | null;
  isSolving: boolean;
  /** Element selected for editing in the network panel. */
  selectedNetElement: { type: 'node' | 'conductor'; id: string } | null;
  /** Unit suffix for measured values ('°C', or '' for vegetation indices). */
  valueSuffix: string;

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
  setNetwork: (network: ThermalNetworkModel, persist?: boolean) => void;
  addNetNode: (node: NetNode) => void;
  addNetConductor: (conductor: NetConductor) => void;
  updateNetNode: (id: string, patch: Partial<NetNode>) => void;
  updateNetConductor: (id: string, patch: Partial<NetConductor>) => void;
  removeNetElement: (type: 'node' | 'conductor', id: string) => void;
  selectNetElement: (sel: { type: 'node' | 'conductor'; id: string } | null) => void;
  solveNetwork: (options: NetworkSolveOptions) => Promise<void>;
  clearNetworkResult: () => void;
}

/**
 * Debounced, strictly-ordered persister: coalesces rapid edits (per-keystroke)
 * into one write and chains writes so a slow earlier request can never land
 * after (and clobber) a newer one.
 */
function makeDebouncedPersister(
  write: (assetId: number, json: string) => Promise<void>,
  label: string,
  delayMs = 400,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let pending: { assetId: number; json: string } | null = null;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending) return;
    const p = pending;
    pending = null;
    chain = chain
      .then(() => write(p.assetId, p.json))
      .catch((e) => console.error(`Failed to persist ${label}:`, e));
  };
  return {
    schedule(assetId: number, json: string) {
      pending = { assetId, json };
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    flush,
  };
}

const annotationsPersister = makeDebouncedPersister(
  (assetId, json) => thermalApi.setThermalAnnotations(assetId, json),
  'annotations',
);
const networkPersister = makeDebouncedPersister(
  (assetId, json) => thermalApi.setThermalNetwork(assetId, json),
  'thermal network',
);

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
  network: EMPTY_NETWORK,
  networkResult: null,
  isSolving: false,
  selectedNetElement: null,
  valueSuffix: '°C',

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
    // Write out any debounced edits for the outgoing asset (the persisters
    // carry their own assetId, so this is safe after the state switches too).
    annotationsPersister.flush();
    networkPersister.flush();
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
      network: EMPTY_NETWORK,
      networkResult: null,
      selectedNetElement: null,
      // Clear any spinner from a previous in-flight load — its stale-selection
      // guards will (correctly) refuse to touch state after this switch.
      isAnalyzing: false,
    });
    if (assetId == null) {
      replaceObjectUrl(null, '');
      return;
    }
    const asset = get().assets.find((a) => a.id === assetId);
    if (!asset) return;

    // Vegetation indices are unitless and read best on the red→green ramp
    const suffix = valueSuffixFor(asset);
    const isIndex = suffix === '';
    set({
      isAnalyzing: true,
      valueSuffix: suffix,
      paletteKey: isIndex
        ? 'vegetation'
        : get().paletteKey === 'vegetation'
          ? 'iron'
          : get().paletteKey,
    });
    try {
      // Load the displayable file. Images go through the preview endpoint so
      // GeoTIFF orthomosaics render via their generated PNG preview;
      // documents (PDF/XML/point clouds…) and GeoTIFFs whose preview failed
      // have no inline preview.
      const displayable = asset.assetType === 'video' || hasDisplayableImage(asset);
      if (displayable) {
        const fileBytes =
          asset.assetType === 'image'
            ? await thermalApi.readThermalAssetPreview(assetId)
            : await thermalApi.readThermalAssetFile(assetId);
        // Bail if the user already switched to another asset — a stale loser
        // must never revoke the winner's live object URL or overwrite its state.
        if (get().selectedAssetId !== assetId) return;
        const mime =
          asset.source === 'metashape' && asset.assetType === 'image'
            ? 'image/png'
            : mimeFor(asset);
        const assetUrl = replaceObjectUrl(fileBytes, mime);
        set({ assetUrl });
      }

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

      // Load persisted heat-flow network
      try {
        const netJson = await thermalApi.getThermalNetwork(assetId);
        if (get().selectedAssetId !== assetId) return;
        if (netJson) {
          const parsed = JSON.parse(netJson) as ThermalNetworkModel;
          if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.conductors)) {
            set({ network: parsed });
          }
        }
      } catch {
        // network model is non-critical
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
      annotationsPersister.schedule(assetId, JSON.stringify(annotations));
    }
  },

  clearError: () => set({ error: null }),

  setNetwork: (network, persist = true) => {
    // Any edit invalidates the previous solution
    set({ network, networkResult: null });
    const assetId = get().selectedAssetId;
    if (persist && assetId != null) {
      networkPersister.schedule(assetId, JSON.stringify(network));
    }
  },

  addNetNode: (node) => {
    const { network, setNetwork } = get();
    setNetwork({ ...network, nodes: [...network.nodes, node] });
    set({ selectedNetElement: { type: 'node', id: node.id } });
  },

  addNetConductor: (conductor) => {
    const { network, setNetwork } = get();
    setNetwork({ ...network, conductors: [...network.conductors, conductor] });
    set({ selectedNetElement: { type: 'conductor', id: conductor.id } });
  },

  updateNetNode: (id, patch) => {
    const { network, setNetwork } = get();
    setNetwork({
      ...network,
      nodes: network.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    });
  },

  updateNetConductor: (id, patch) => {
    const { network, setNetwork } = get();
    setNetwork({
      ...network,
      conductors: network.conductors.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    });
  },

  removeNetElement: (type, id) => {
    const { network, setNetwork, selectedNetElement } = get();
    if (type === 'node') {
      setNetwork({
        nodes: network.nodes.filter((n) => n.id !== id),
        // Conductors attached to a removed node go with it
        conductors: network.conductors.filter((c) => c.from !== id && c.to !== id),
      });
    } else {
      setNetwork({ ...network, conductors: network.conductors.filter((c) => c.id !== id) });
    }
    if (selectedNetElement?.id === id) set({ selectedNetElement: null });
  },

  selectNetElement: (sel) => set({ selectedNetElement: sel }),

  solveNetwork: async (options) => {
    const { network, selectedAssetId } = get();
    if (network.nodes.length === 0) {
      set({ error: 'Add nodes to the network before solving.' });
      return;
    }
    set({ isSolving: true, error: null });
    // Reference equality works as a staleness token: every edit path installs
    // a freshly constructed network object.
    const current = () =>
      get().selectedAssetId === selectedAssetId && get().network === network;
    try {
      const result = await thermalApi.solveThermalNetwork(network, options);
      if (current()) {
        set({ networkResult: result });
      }
    } catch (e) {
      if (current()) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      if (get().selectedAssetId === selectedAssetId) {
        set({ isSolving: false });
      }
    }
  },

  clearNetworkResult: () => set({ networkResult: null }),
}));
