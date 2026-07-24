/**
 * Types for the thermal inspection module (mirrors Rust structs in src-tauri/src/thermal).
 */

export interface ThermalAsset {
  id: number;
  fileName: string;
  storedPath: string;
  fileHash: string | null;
  assetType: 'image' | 'video';
  isRadiometric: boolean;
  width: number;
  height: number;
  gpsLat: number | null;
  gpsLon: number | null;
  capturedAt: string | null;
  cameraModel: string | null;
  importedAt: string | null;
  notes: string | null;
}

export interface ThermalSdkStatus {
  available: boolean;
  sdkDir: string | null;
  error: string | null;
}

export interface HistogramBin {
  temp: number;
  count: number;
}

export interface TempStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  stdDev: number;
  minPos: [number, number];
  maxPos: [number, number];
  histogram: HistogramBin[];
}

export interface MeasurementParams {
  distance: number;
  humidity: number;
  emissivity: number;
  reflection: number;
  ambientTemp: number;
}

export interface MeasureOverrides {
  distance?: number;
  humidity?: number;
  emissivity?: number;
  reflection?: number;
  ambientTemp?: number;
}

export interface ThermalAnalysis {
  assetId: number;
  width: number;
  height: number;
  stats: TempStats;
  params: MeasurementParams;
}

export interface AnomalyOptions {
  zThreshold?: number;
  minRegionPx?: number;
  maxRegions?: number;
  rangeLow?: number;
  rangeHigh?: number;
}

export type Severity = 'low' | 'medium' | 'high';

export interface AnomalyRegion {
  id: number;
  kind: 'hot' | 'cold';
  areaPx: number;
  bbox: [number, number, number, number]; // x, y, w, h
  centroid: [number, number];
  tMin: number;
  tMax: number;
  tMean: number;
  deltaT: number;
  severity: Severity;
  classification: string;
}

export interface AnomalyResult {
  baseline: number;
  stdDev: number;
  zThreshold: number;
  regions: AnomalyRegion[];
}

/** Decoded temperature matrix (from the binary IPC payload). */
export interface TempMatrix {
  width: number;
  height: number;
  /** Row-major temperatures in °C. */
  temps: Float32Array;
}

// ---------------- Annotations ----------------

export type AnnotationTool = 'select' | 'arrow' | 'text' | 'freehand' | 'circle' | 'rect';

export interface AnnotationBase {
  id: string;
  type: Exclude<AnnotationTool, 'select'>;
  color: string;
  strokeWidth: number;
}

export interface ArrowAnnotation extends AnnotationBase {
  type: 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface TextAnnotation extends AnnotationBase {
  type: 'text';
  x: number;
  y: number;
  text: string;
  fontSize: number;
}

export interface FreehandAnnotation extends AnnotationBase {
  type: 'freehand';
  points: number[]; // [x1, y1, x2, y2, ...]
}

export interface CircleAnnotation extends AnnotationBase {
  type: 'circle';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface RectAnnotation extends AnnotationBase {
  type: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Annotation =
  | ArrowAnnotation
  | TextAnnotation
  | FreehandAnnotation
  | CircleAnnotation
  | RectAnnotation;

// ---------------- Reports ----------------

export interface ThermalReportMeta {
  id: number;
  name: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** One row of the thermal imaging log / comparative matrix. */
export interface ReportImageEntry {
  id: string;
  /** Asset shown in the thermal (IR) column. */
  thermalAssetId: number | null;
  /** Asset shown in the visual (RGB) column. */
  visualAssetId: number | null;
  /** Laser Rangefinder data / notes column (free text). */
  lrfData: string;
  caption: string;
}

export interface ReportAnomalyEntry {
  id: string;
  refId: string; // e.g. "A-01"
  assetId: number | null;
  location: string; // free-text location description
  gpsLat: number | null;
  gpsLon: number | null;
  tMax: number | null;
  tMin: number | null;
  baseline: number | null;
  deltaT: number | null;
  severity: Severity;
  classification: string;
  finding: string; // description of the anomaly
  recommendation: string;
}

export interface ThermalReport {
  version: 1;
  // Header data
  propertyAddress: string;
  inspectionDate: string;
  weatherConditions: string;
  inspectorName: string;
  // Sections
  summary: string;
  imagingLog: ReportImageEntry[];
  anomalies: ReportAnomalyEntry[];
  actionPlan: string;
  orthomosaicLink: string;
}

export const EMPTY_REPORT: ThermalReport = {
  version: 1,
  propertyAddress: '',
  inspectionDate: '',
  weatherConditions: '',
  inspectorName: '',
  summary: '',
  imagingLog: [],
  anomalies: [],
  actionPlan: '',
  orthomosaicLink: '',
};

/** Defect classification keys → human-readable labels. */
export const CLASSIFICATION_LABELS: Record<string, string> = {
  electrical_fault: 'Electrical Fault',
  thermal_bridging: 'Thermal Bridging',
  hvac_leakage: 'HVAC Leakage',
  insulation_void: 'Insulation Void',
  air_infiltration: 'Air Infiltration',
  moisture_intrusion: 'Moisture Intrusion',
  missing_insulation: 'Missing Insulation',
  other: 'Other',
};
