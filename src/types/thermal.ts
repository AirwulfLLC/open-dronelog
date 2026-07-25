/**
 * Types for the thermal inspection module (mirrors Rust structs in src-tauri/src/thermal).
 */

export interface ThermalAsset {
  id: number;
  fileName: string;
  storedPath: string;
  fileHash: string | null;
  assetType: 'image' | 'video' | 'document';
  isRadiometric: boolean;
  width: number;
  height: number;
  gpsLat: number | null;
  gpsLon: number | null;
  capturedAt: string | null;
  cameraModel: string | null;
  importedAt: string | null;
  notes: string | null;
  /** 'thermal' (drone media) or 'metashape' (photogrammetry export). */
  source: 'thermal' | 'metashape';
  /** Parsed metadata JSON (Metashape kind, preview file, CRS, camera count…). */
  metaJson: string | null;
}

/** Parsed shape of ThermalAsset.metaJson for Metashape assets. */
export interface MetashapeMeta {
  kind:
    | 'orthomosaic'
    | 'processing_report'
    | 'cameras_xml'
    | 'reference_csv'
    | 'point_cloud'
    | 'map_overlay';
  sizeBytes?: number;
  width?: number;
  height?: number;
  previewFile?: string;
  previewError?: string;
  cameraCount?: number;
  markerCount?: number;
  crs?: string;
  rowCount?: number;
  columns?: number;
  format?: string;
}

export const METASHAPE_KIND_LABELS: Record<string, string> = {
  orthomosaic: 'Orthomosaic / DEM (GeoTIFF)',
  processing_report: 'Processing Report (PDF)',
  cameras_xml: 'Camera Calibration (XML)',
  reference_csv: 'Camera Reference (CSV)',
  point_cloud: 'Point Cloud',
  map_overlay: 'Map Overlay (KML/KMZ)',
};

export function parseMetashapeMeta(asset: ThermalAsset): MetashapeMeta | null {
  if (asset.source !== 'metashape' || !asset.metaJson) return null;
  try {
    return JSON.parse(asset.metaJson) as MetashapeMeta;
  } catch {
    return null;
  }
}

/** True when the asset can be rendered as an image in the viewer/reports.
 *  Metashape GeoTIFFs are only displayable via their generated PNG preview —
 *  when preview generation failed, treat them as documents. */
export function hasDisplayableImage(asset: ThermalAsset): boolean {
  if (asset.assetType !== 'image') return false;
  if (asset.source !== 'metashape') return true;
  return !!parseMetashapeMeta(asset)?.previewFile;
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

export type AnnotationTool =
  | 'select'
  | 'arrow'
  | 'text'
  | 'freehand'
  | 'circle'
  | 'rect'
  | 'node'
  | 'conductor';

export interface AnnotationBase {
  id: string;
  type: Exclude<AnnotationTool, 'select' | 'node' | 'conductor'>;
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

// ---------------- Thermal network (heat flow) ----------------

/** Property value: constant, or piecewise-linear vs time (s) or temperature (°C). */
export interface PropValue {
  mode: 'constant' | 'timeTable' | 'tempTable';
  value?: number;
  points?: Array<[number, number]>;
}

export type NetNodeKind = 'diffusion' | 'arithmetic' | 'boundary';

export interface NetNode {
  id: string;
  label: string;
  /** Position in image-pixel coordinates. */
  x: number;
  y: number;
  kind: NetNodeKind;
  initialTempC: number;
  /** m·cp in J/K (diffusion nodes). */
  mcp?: PropValue | null;
  /** Applied source in W (heater, electrical dissipation, solar backloading…). */
  source?: PropValue | null;
  /** Prescribed temperature (°C) for boundary nodes. */
  boundaryTempC?: PropValue | null;
}

export type NetConductorKind = 'linear' | 'radiative';

export interface NetConductor {
  id: string;
  label: string;
  from: string;
  to: string;
  kind: NetConductorKind;
  /** Linear: G in W/K. Radiative: εFA product in m². */
  value: PropValue;
}

export interface ThermalNetworkModel {
  nodes: NetNode[];
  conductors: NetConductor[];
}

export interface NetworkSolveOptions {
  mode: 'steady' | 'transient';
  durationS?: number;
  timeStepS?: number;
}

export interface ConductorFlow {
  id: string;
  from: string;
  to: string;
  kind: NetConductorKind;
  /** W, positive from `from` → `to`. */
  q: number;
}

export interface NodeBalance {
  id: string;
  linearInW: number;
  radiativeInW: number;
  sourceW: number;
  storageW: number;
  tempC: number;
}

export interface NetworkSolveResult {
  mode: string;
  converged: boolean;
  iterations: number;
  nodeIds: string[];
  times: number[];
  /** temps[nodeIndex][timeIndex] in °C. */
  temps: number[][];
  flows: ConductorFlow[];
  balances: NodeBalance[];
  warning?: string;
}

export const EMPTY_NETWORK: ThermalNetworkModel = { nodes: [], conductors: [] };

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

/** Snapshot of a linked DJI flight, embedded in the report so it renders
 *  even when the report/bundle is opened where the flight DB entry is absent. */
export interface FlightSnapshot {
  id: number;
  displayName: string;
  startTime: string | null;
  droneModel: string | null;
  aircraftName: string | null;
  durationSecs: number | null;
  totalDistance: number | null;
  maxAltitude: number | null;
  maxSpeed: number | null;
  homeLat: number | null;
  homeLon: number | null;
  photoCount: number | null;
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
  /** DJI flights linked to this inspection (snapshots, not live references). */
  linkedFlights: FlightSnapshot[];
  /** Imported Metashape orthomosaic asset embedded in the report. */
  orthoAssetId: number | null;
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
  linkedFlights: [],
  orthoAssetId: null,
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
