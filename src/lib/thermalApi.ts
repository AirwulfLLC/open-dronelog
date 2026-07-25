/**
 * API wrapper for the thermal inspection module.
 *
 * Thermal analysis relies on the native DJI Thermal SDK (libdirp), so it is
 * only available in the Tauri desktop build. In web mode every call rejects
 * with a friendly error.
 */

import type {
  AnomalyOptions,
  AnomalyResult,
  MeasureOverrides,
  NetworkSolveOptions,
  NetworkSolveResult,
  TempMatrix,
  ThermalAnalysis,
  ThermalAsset,
  ThermalNetworkModel,
  ThermalReportMeta,
  ThermalSdkStatus,
} from '@/types/thermal';

const isWeb = import.meta.env.VITE_BACKEND === 'web';

const WEB_UNSUPPORTED =
  'Thermal analysis requires the desktop app (DJI Thermal SDK is a native library).';

type InvokeFn = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let _invoke: InvokeFn | null = null;

async function inv<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isWeb) throw new Error(WEB_UNSUPPORTED);
  if (!_invoke) {
    const { invoke } = await import('@tauri-apps/api/core');
    _invoke = invoke as InvokeFn;
  }
  return _invoke<T>(cmd, args);
}

export function isThermalSupported(): boolean {
  return !isWeb;
}

export async function getThermalSdkStatus(): Promise<ThermalSdkStatus> {
  return inv<ThermalSdkStatus>('thermal_sdk_status');
}

export async function importThermalAsset(filePath: string): Promise<ThermalAsset> {
  return inv<ThermalAsset>('thermal_import_asset', { filePath });
}

export async function importThermalAssetBytes(
  fileName: string,
  fileBytes: Uint8Array,
): Promise<ThermalAsset> {
  if (isWeb) throw new Error(WEB_UNSUPPORTED);
  // Raw binary IPC body — a JSON number array would freeze the app for
  // large files (GeoTIFF orthomosaics are routinely hundreds of MB).
  const { invoke } = await import('@tauri-apps/api/core');
  const nameB64 = btoa(String.fromCharCode(...new TextEncoder().encode(fileName)));
  return invoke<ThermalAsset>('thermal_import_asset_raw', fileBytes, {
    headers: { 'file-name-b64': nameB64 },
  });
}

export async function listThermalAssets(): Promise<ThermalAsset[]> {
  return inv<ThermalAsset[]>('thermal_list_assets');
}

export async function deleteThermalAsset(assetId: number): Promise<void> {
  await inv('thermal_delete_asset', { assetId });
}

export async function updateThermalAssetNotes(
  assetId: number,
  notes: string | null,
): Promise<void> {
  await inv('thermal_update_asset_notes', { assetId, notes });
}

function toArrayBuffer(res: ArrayBuffer | Uint8Array | number[]): ArrayBuffer {
  if (res instanceof ArrayBuffer) return res;
  if (res instanceof Uint8Array) {
    return res.buffer.slice(res.byteOffset, res.byteOffset + res.byteLength) as ArrayBuffer;
  }
  return new Uint8Array(res).buffer;
}

/** Read the stored asset file as raw bytes (ArrayBuffer). */
export async function readThermalAssetFile(assetId: number): Promise<ArrayBuffer> {
  const res = await inv<ArrayBuffer | Uint8Array | number[]>('thermal_read_asset_file', {
    assetId,
  });
  return toArrayBuffer(res);
}

/** Read displayable bytes: the PNG preview when one exists (GeoTIFFs),
 *  otherwise the original file. */
export async function readThermalAssetPreview(assetId: number): Promise<ArrayBuffer> {
  const res = await inv<ArrayBuffer | Uint8Array | number[]>('thermal_read_asset_preview', {
    assetId,
  });
  return toArrayBuffer(res);
}

// ---------------- Inspection bundles ----------------

export interface BundleImportResult {
  reportId: number | null;
  reportName: string | null;
  importedAssets: number;
  skippedAssets: number;
  archivedFlights: number;
}

export async function exportThermalBundle(args: {
  destPath: string;
  name: string;
  reportId?: number | null;
  reportJson?: string | null;
  assetIds: number[];
  flightIds: number[];
}): Promise<string> {
  return inv<string>('thermal_export_bundle', {
    destPath: args.destPath,
    name: args.name,
    reportId: args.reportId ?? null,
    reportJson: args.reportJson ?? null,
    assetIds: args.assetIds,
    flightIds: args.flightIds,
  });
}

export async function importThermalBundle(srcPath: string): Promise<BundleImportResult> {
  return inv<BundleImportResult>('thermal_import_bundle', { srcPath });
}

export async function analyzeThermalAsset(
  assetId: number,
  overrides?: MeasureOverrides,
): Promise<ThermalAnalysis> {
  return inv<ThermalAnalysis>('thermal_analyze', { assetId, overrides: overrides ?? null });
}

/**
 * Fetch the full per-pixel temperature matrix.
 * Binary layout: u32 LE width, u32 LE height, then w*h f32 LE values (°C).
 */
export async function getTempMatrix(
  assetId: number,
  overrides?: MeasureOverrides,
): Promise<TempMatrix> {
  const raw = await inv<ArrayBuffer | Uint8Array | number[]>('thermal_get_temp_matrix', {
    assetId,
    overrides: overrides ?? null,
  });
  let buf: ArrayBuffer;
  if (raw instanceof ArrayBuffer) {
    buf = raw;
  } else if (raw instanceof Uint8Array) {
    buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  } else {
    buf = new Uint8Array(raw).buffer;
  }
  if (buf.byteLength < 8) throw new Error('Invalid temperature matrix payload');
  const header = new DataView(buf, 0, 8);
  const width = header.getUint32(0, true);
  const height = header.getUint32(4, true);
  const expected = 8 + width * height * 4;
  if (buf.byteLength < expected) {
    throw new Error(`Temperature matrix payload truncated (${buf.byteLength} < ${expected})`);
  }
  return { width, height, temps: new Float32Array(buf, 8, width * height) };
}

export async function detectAnomalies(
  assetId: number,
  options?: AnomalyOptions,
  overrides?: MeasureOverrides,
): Promise<AnomalyResult> {
  return inv<AnomalyResult>('thermal_detect_anomalies', {
    assetId,
    options: options ?? null,
    overrides: overrides ?? null,
  });
}

// ---------------- AI thermal analysis ----------------

export type ThermalAiProvider = 'claude' | 'openai' | 'gemini';

export interface ThermalAiConfig {
  provider: ThermalAiProvider;
  hasClaudeKey: boolean;
  hasOpenaiKey: boolean;
  hasGeminiKey: boolean;
}

export async function thermalAiGetConfig(): Promise<ThermalAiConfig> {
  return inv<ThermalAiConfig>('thermal_ai_get_config');
}

export async function thermalAiSetProvider(provider: ThermalAiProvider): Promise<void> {
  await inv('thermal_ai_set_provider', { provider });
}

/** True when the currently selected provider has a key configured. */
export async function thermalAiHasApiKey(): Promise<boolean> {
  return inv<boolean>('thermal_ai_has_api_key');
}

export async function thermalAiSetApiKey(
  provider: ThermalAiProvider,
  apiKey: string,
): Promise<void> {
  await inv('thermal_ai_set_api_key', { provider, apiKey });
}

export async function thermalAiRemoveApiKey(provider: ThermalAiProvider): Promise<void> {
  await inv('thermal_ai_remove_api_key', { provider });
}

/** Generate an AI narrative for the asset from the measured analysis context. */
export async function thermalAiGenerateFindings(
  assetId: number,
  contextJson: string,
): Promise<string> {
  return inv<string>('thermal_ai_generate_findings', { assetId, contextJson });
}

export async function solveThermalNetwork(
  network: ThermalNetworkModel,
  options: NetworkSolveOptions,
): Promise<NetworkSolveResult> {
  return inv<NetworkSolveResult>('thermal_solve_network', { network, options });
}

export async function getThermalNetwork(assetId: number): Promise<string | null> {
  return inv<string | null>('thermal_get_network', { assetId });
}

export async function setThermalNetwork(assetId: number, network: string): Promise<void> {
  await inv('thermal_set_network', { assetId, network });
}

export async function getThermalAnnotations(assetId: number): Promise<string | null> {
  return inv<string | null>('thermal_get_annotations', { assetId });
}

export async function setThermalAnnotations(
  assetId: number,
  annotations: string,
): Promise<void> {
  await inv('thermal_set_annotations', { assetId, annotations });
}

export async function listThermalReports(): Promise<ThermalReportMeta[]> {
  return inv<ThermalReportMeta[]>('thermal_list_reports');
}

export async function getThermalReport(reportId: number): Promise<string> {
  return inv<string>('thermal_get_report', { reportId });
}

export async function saveThermalReport(
  reportId: number | null,
  name: string,
  reportJson: string,
): Promise<number> {
  return inv<number>('thermal_save_report', { reportId, name, reportJson });
}

export async function deleteThermalReport(reportId: number): Promise<void> {
  await inv('thermal_delete_report', { reportId });
}
