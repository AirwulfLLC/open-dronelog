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
  /** 'thermal' (drone media), 'metashape' (Metashape export) or
   *  'photogrammetry' (visual photos/videos for the photogrammetry report). */
  source: 'thermal' | 'metashape' | 'photogrammetry';
  /** Parsed metadata JSON (Metashape kind, preview file, CRS, camera count…). */
  metaJson: string | null;
}

/** Parsed shape of ThermalAsset.metaJson for Metashape assets. */
export interface MetashapeMeta {
  kind:
    | 'orthomosaic'
    | 'multispectral'
    | 'vegetation_index'
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
  /** Multispectral: number of spectral bands. */
  bands?: number;
  bitsPerSample?: number;
  /** Vegetation index assets. */
  indexName?: string;
  formula?: string;
  bandMapping?: Record<string, number>;
  sourceAssetId?: number;
  rasterFile?: string;
  stats?: { min: number; max: number; mean: number };
  displayRange?: { low: number; high: number };
}

export const METASHAPE_KIND_LABELS: Record<string, string> = {
  orthomosaic: 'Orthomosaic / DEM (GeoTIFF)',
  multispectral: 'Multispectral Orthomosaic',
  vegetation_index: 'Vegetation Index',
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
 *  GeoTIFF-backed kinds are only displayable via their generated PNG preview —
 *  when preview generation failed, treat them as documents. Vegetation index
 *  assets are stored as PNGs, so they always display. */
export function hasDisplayableImage(asset: ThermalAsset): boolean {
  if (asset.assetType !== 'image') return false;
  if (asset.source !== 'metashape') return true;
  const meta = parseMetashapeMeta(asset);
  if (!meta) return false;
  if (meta.kind === 'orthomosaic' || meta.kind === 'multispectral') {
    return !!meta.previewFile;
  }
  return true;
}

/** MIME type for serving an asset's original file through a Blob URL. */
export function assetMimeType(asset: ThermalAsset): string {
  const ext = asset.fileName.toLowerCase().split('.').pop() ?? '';
  if (asset.assetType === 'video') {
    if (ext === 'mov') return 'video/quicktime';
    if (ext === 'avi') return 'video/x-msvideo';
    return 'video/mp4';
  }
  if (ext === 'png') return 'image/png';
  return 'image/jpeg';
}

/** True when the importer generated a PNG preview for the file (GeoTIFFs,
 *  radiometric TIFF/CSV imports), which the preview endpoint then serves. */
export function hasPreviewFile(asset: ThermalAsset): boolean {
  if (!asset.metaJson) return false;
  try {
    return typeof (JSON.parse(asset.metaJson) as { previewFile?: unknown }).previewFile === 'string';
  } catch {
    return false;
  }
}

/** MIME type of the bytes the preview endpoint serves: GeoTIFF-backed
 *  Metashape images and radiometric TIFF/CSV imports come back as their PNG
 *  preview, everything else as the original file. */
export function previewMimeType(asset: ThermalAsset): string {
  if (asset.source === 'metashape' && asset.assetType === 'image') return 'image/png';
  if (hasPreviewFile(asset)) return 'image/png';
  return assetMimeType(asset);
}

/** How a radiometric picture's temperatures are read. */
export type RadiometricFormat = 'flir' | 'dji' | 'autel_tiff' | 'float_tiff' | 'temperature_csv';

export const RADIOMETRIC_FORMAT_LABELS: Record<RadiometricFormat, string> = {
  flir: 'FLIR R-JPEG',
  dji: 'DJI R-JPEG',
  autel_tiff: 'Autel radiometric TIFF',
  float_tiff: 'Radiometric TIFF',
  temperature_csv: 'Temperature matrix (CSV)',
};

/** The importer's record of a radiometric picture: format, vendor, camera. */
export interface RadiometricMeta {
  format: RadiometricFormat;
  vendor?: string;
  camera?: string;
  cameraSerial?: string;
  lens?: string;
  note?: string;
}

/** True when the picture's temperatures are computed from raw counts with
 *  measurement parameters (emissivity, distance, reflected temperature…):
 *  DJI and FLIR-format R-JPEGs. TIFF/CSV imports and index rasters hold
 *  values the vendor tool already computed — nothing to re-measure. */
export function hasMeasurementParams(asset: ThermalAsset): boolean {
  if (!asset.isRadiometric || asset.source === 'metashape') return false;
  const rad = parseRadiometricMeta(asset);
  // Pictures imported before the format was recorded are DJI R-JPEGs
  return rad == null || rad.format === 'flir' || rad.format === 'dji';
}

export function parseRadiometricMeta(asset: ThermalAsset): RadiometricMeta | null {
  if (asset.source === 'metashape' || !asset.metaJson) return null;
  try {
    const r = (JSON.parse(asset.metaJson) as { radiometric?: Record<string, unknown> }).radiometric;
    if (!r || typeof r.format !== 'string' || !Object.prototype.hasOwnProperty.call(RADIOMETRIC_FORMAT_LABELS, r.format)) {
      return null;
    }
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    return {
      format: r.format as RadiometricFormat,
      vendor: str(r.vendor),
      camera: str(r.camera),
      cameraSerial: str(r.cameraSerial),
      lens: str(r.lens),
      note: str(r.note),
    };
  } catch {
    return null;
  }
}

/** Unit suffix for measured values on this asset ('' for unitless indices). */
export function valueSuffixFor(asset: ThermalAsset | null): string {
  if (!asset) return '°C';
  return parseMetashapeMeta(asset)?.kind === 'vegetation_index' ? '' : '°C';
}

/** Camera details the importer read from a photo's EXIF (the model has its own field). */
export interface CameraMeta {
  cameraMake?: string;
  cameraSerial?: string;
}

export function parseCameraMeta(asset: ThermalAsset): CameraMeta {
  if (asset.source === 'metashape' || !asset.metaJson) return {};
  try {
    const m = JSON.parse(asset.metaJson) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    return { cameraMake: str(m.cameraMake), cameraSerial: str(m.cameraSerial) };
  } catch {
    return {};
  }
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
  | 'line'
  | 'text'
  | 'freehand'
  | 'circle'
  | 'rect'
  | 'eraser'
  | 'node'
  | 'conductor'
  /** Magnifier: click / wheel to zoom, drag to pan (a view mode, draws nothing). */
  | 'zoom';

export interface AnnotationBase {
  id: string;
  type: Exclude<AnnotationTool, 'select' | 'eraser' | 'node' | 'conductor' | 'zoom'>;
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

/** Straight line without an arrow head. */
export interface LineAnnotation extends AnnotationBase {
  type: 'line';
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
  | LineAnnotation
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

/** Report workflows. Each has its own builder, sections and export layout;
 *  saved reports carry their kind so the workflows list only their own. */
export type ReportKind = 'thermal' | 'photogrammetry';

export const REPORT_KIND_LABELS: Record<ReportKind, string> = {
  thermal: 'Thermal Inspection Report',
  photogrammetry: 'Photogrammetry Survey Report',
};

export interface ThermalReportMeta {
  id: number;
  name: string;
  kind: ReportKind;
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
  /** Palette the thermal picture is rendered with in the report (a PALETTES
   *  key; absent = Iron Red). */
  paletteKey?: string;
  /** Temperature span mapped to the palette; null/absent = the picture's own
   *  min/max. Printed under the pair as the temperature scale. */
  spanLow?: number | null;
  spanHigh?: number | null;
}

export type InventoryStatus = 'normal' | 'exception' | 'not_inspected';

export const INVENTORY_STATUS_LABELS: Record<InventoryStatus, string> = {
  normal: 'Normal',
  exception: 'Exception',
  not_inspected: 'Not inspected / inaccessible',
};

/** One asset or area of the inspected system. The inventory doubles as the
 *  exception list (status "exception") and the list of uninspected or
 *  inaccessible items (status "not_inspected"). */
export interface InventoryEntry {
  id: string;
  /** Asset ID / tag ("MDP-1", "Roof, north slope"). */
  tag: string;
  description: string;
  status: InventoryStatus;
  /** Related anomaly ids, the reason an item was not inspected, remarks. */
  note: string;
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

/** One figure of the Photogrammetry Imagery section. The array order is the
 *  order in the exported report. */
export interface PhotogrammetryEntry {
  id: string;
  assetId: number;
  caption: string;
  /** Videos: timestamp (seconds) of the frame rendered in the report. */
  frameTimeS?: number;
}

/** Snapshot of a linked DJI flight, embedded in the report so it renders
 *  even when the report/bundle is opened where the flight DB entry is absent. */
export interface FlightSnapshot {
  id: number;
  displayName: string;
  startTime: string | null;
  droneModel: string | null;
  droneSerial?: string | null;
  aircraftName: string | null;
  durationSecs: number | null;
  totalDistance: number | null;
  maxAltitude: number | null;
  maxSpeed: number | null;
  homeLat: number | null;
  homeLon: number | null;
  photoCount: number | null;
}

/** Fields every report kind shares: header data, linked flights, orthomosaic. */
export interface ReportBase {
  version: 1;
  kind: ReportKind;
  // Header data
  propertyAddress: string;
  inspectionDate: string;
  /** Time of day / window of the flights ("09:31–10:12"); filled from the linked flight logs. */
  inspectionTime: string;
  /** Site coordinates ("41.110300, -85.211000"); filled from the flights' home point. */
  sitePosition: string;
  weatherConditions: string;
  inspectorName: string;
  summary: string;
  /** Aircraft that flew the survey (model and name) and its serial number;
   *  filled from the linked flight logs. */
  droneModel: string;
  droneSerial: string;
  orthomosaicLink: string;
  /** DJI flights linked to this report (snapshots, not live references). */
  linkedFlights: FlightSnapshot[];
  /** Imported Metashape orthomosaic asset embedded in the report. */
  orthoAssetId: number | null;
}

export interface ThermalReport extends ReportBase {
  kind: 'thermal';
  // ---- Administrative & metadata ----
  /** Thermographer credentials (certification level, licences). */
  inspectorCredentials: string;
  /** Thermographer contact details (company, phone, e-mail). */
  inspectorContact: string;
  cameraMake: string;
  cameraModel: string;
  cameraSerial: string;
  /** Asset ID tags / areas covered by the survey. */
  assetTags: string;
  // ---- Environmental & system conditions ----
  ambientTempC: number | null;
  humidityPct: number | null;
  /** System or electrical load during the survey ("MDP at ~80% load, HVAC running"). */
  loadConditions: string;
  /** Emissivity, reflected (background) temperature and distance the
   *  measurements were calibrated with. */
  emissivity: number | null;
  reflectedTempC: number | null;
  measurementDistanceM: number | null;
  // ---- Evidence & findings ----
  imagingLog: ReportImageEntry[];
  anomalies: ReportAnomalyEntry[];
  /** Asset inventory with status per item (normal / exception / not inspected). */
  inventory: InventoryEntry[];
  // ---- Recommendations & follow-up ----
  actionPlan: string;
  /** Post-repair re-inspection and periodic temperature-trending plan. */
  followUp: string;
  /** Limitations of the method, definitions and disclaimer (prefilled; editable). */
  limitations: string;
}

/** Standard limitations, definitions and disclaimer text new thermal reports
 *  start with. "dT" rather than the Greek delta: the PDF's built-in fonts
 *  cannot print it. */
export const DEFAULT_THERMAL_LIMITATIONS = [
  'Limitations of infrared thermography',
  'Infrared thermography measures apparent surface temperature only. It cannot see inside solid ' +
    'materials, confirm the presence of moisture, mould or concealed defects without physical or ' +
    'instrumented verification, or by itself determine the cause of a thermal pattern. Apparent ' +
    'temperatures depend on the emissivity and reflectivity of the surface, the reflected (background) ' +
    'temperature, atmospheric conditions, distance and viewing angle; readings on low-emissivity ' +
    'surfaces such as bare metal or glass are unreliable. A pattern can only be detected where a ' +
    'sufficient temperature difference existed at the time of the survey, and conditions at other ' +
    'times may differ. Areas that were inaccessible, obstructed or outside the field of view were not ' +
    'assessed; they are listed in the asset inventory.',
  '',
  'Definitions',
  'T max / T min: the highest and lowest apparent temperatures measured within the anomaly region. ' +
    'Baseline: the reference apparent temperature of comparable unaffected surfaces in the same image. ' +
    'dT (delta-T): the difference between the anomaly temperature and the baseline. Emissivity: how ' +
    'efficiently a surface emits infrared energy (0 to 1), set on the camera for the surface measured. ' +
    'Reflected (background) temperature: the apparent temperature of the surroundings reflected by the ' +
    'surface, used to correct the measurement. Severity: High = immediate corrective action ' +
    'recommended; Medium = schedule repair; Low = monitor and re-inspect.',
  '',
  'Disclaimer',
  'This report records the conditions observed with the stated equipment, settings and environmental ' +
    'conditions at the time of the survey. Findings are indicative and should be confirmed by a ' +
    'qualified specialist before repair decisions are made. No warranty is given that defects not ' +
    'detectable by thermal imaging are absent.',
].join('\n');

/** A photogrammetry-survey observation, optionally tied to one of the figures. */
export interface PhotogrammetryFinding {
  id: string;
  refId: string; // e.g. "F-01"
  /** PhotogrammetryEntry.id of the figure that shows it. */
  figureId: string | null;
  location: string;
  category: string;
  severity: Severity;
  observation: string;
  recommendation: string;
}

/** A neutral note on what the survey showed — context or condition recorded
 *  without a defect grade or corrective action (those are findings). */
export interface PhotogrammetryObservation {
  id: string;
  refId: string; // e.g. "O-01"
  /** PhotogrammetryEntry.id of the figure that shows it. */
  figureId: string | null;
  location: string;
  text: string;
}

/** The standard photogrammetry deliverables. Core visual products and
 *  topographical products print in separate report sections. */
export type DeliverableKind = 'orthomosaic' | 'point_cloud' | 'mesh' | 'dsm' | 'dtm' | 'contours' | 'other';

export const DELIVERABLE_KIND_LABELS: Record<DeliverableKind, string> = {
  orthomosaic: 'Orthomosaic Map',
  point_cloud: '3D Point Cloud',
  mesh: '3D Textured Mesh',
  dsm: 'Digital Elevation / Surface Model (DEM/DSM)',
  dtm: 'Digital Terrain Model (DTM)',
  contours: 'Contour Line Map',
  other: 'Other deliverable',
};

export const CORE_DELIVERABLE_KINDS: DeliverableKind[] = ['orthomosaic', 'point_cloud', 'mesh', 'other'];
export const ELEVATION_DELIVERABLE_KINDS: DeliverableKind[] = ['dsm', 'dtm', 'contours'];

export type DeliverableStatus = 'produced' | 'not_produced';

/** One deliverable of the survey, with its specification (resolution, point
 *  count, CRS, interval…) and where it is hosted. */
export interface DeliverableEntry {
  id: string;
  kind: DeliverableKind;
  status: DeliverableStatus;
  /** Title for "other" kinds; blank otherwise (the kind label is used). */
  title: string;
  details: string;
  link: string;
}

export type MeasurementKind = 'volume' | 'area' | 'length' | 'height' | 'other';

export const MEASUREMENT_KIND_LABELS: Record<MeasurementKind, string> = {
  volume: 'Volume',
  area: 'Area',
  length: 'Length / distance',
  height: 'Height / elevation',
  other: 'Other',
};

export const MEASUREMENT_DEFAULT_UNITS: Record<MeasurementKind, string> = {
  volume: 'm³',
  area: 'm²',
  length: 'm',
  height: 'm',
  other: '',
};

/** A measurement taken from the photogrammetry products (stockpile volume,
 *  roof area, building height, setback…). */
export interface MeasurementEntry {
  id: string;
  kind: MeasurementKind;
  /** What was measured ("Stockpile A", "Main roof", "Front setback"). */
  feature: string;
  value: number | null;
  unit: string;
  /** How it was measured, tolerance, remarks. */
  method: string;
  /** PhotogrammetryEntry.id of the figure that shows it. */
  figureId: string | null;
}

export interface PhotogrammetryReport extends ReportBase {
  kind: 'photogrammetry';
  projectName: string;
  clientName: string;
  /** Pilot information beyond the name: licence / certification, contact. */
  pilotCredentials: string;
  pilotContact: string;
  /** Objective / scope of the survey. */
  surveyPurpose: string;
  // ---- Environmental conditions (weather is on the base) ----
  windConditions: string;
  lighting: string;
  // ---- Hardware, software & accuracy ----
  /** Camera / sensor the imagery was taken with. */
  cameraSensor: string;
  /** Photogrammetry software and version used for processing. */
  software: string;
  imageCount: number | null;
  imagesAligned: number | null;
  flightAltitudeM: number | null;
  /** Ground sampling distance in cm per pixel. */
  gsdCmPx: number | null;
  gcpCount: number | null;
  /** Root mean square error of the control / check points, in cm. */
  rmseCm: number | null;
  /** Coordinate reference system of the deliverables. */
  crs: string;
  /** Software, GSD, accuracy, control points… */
  processingNotes: string;
  /** Deliverables produced (or not), with specifications and links. */
  deliverables: DeliverableEntry[];
  /** Ordered figures (photos / video frames with annotations). */
  figures: PhotogrammetryEntry[];
  /** Imported Metashape deliverables (asset ids) listed in the Outputs section. */
  outputAssetIds: number[];
  measurements: MeasurementEntry[];
  findings: PhotogrammetryFinding[];
  observations: PhotogrammetryObservation[];
  conclusions: string;
}

export type InspectionReport = ThermalReport | PhotogrammetryReport;

const EMPTY_REPORT_BASE: Omit<ReportBase, 'kind'> = {
  version: 1,
  propertyAddress: '',
  inspectionDate: '',
  inspectionTime: '',
  sitePosition: '',
  weatherConditions: '',
  inspectorName: '',
  summary: '',
  droneModel: '',
  droneSerial: '',
  orthomosaicLink: '',
  linkedFlights: [],
  orthoAssetId: null,
};

export const EMPTY_THERMAL_REPORT: ThermalReport = {
  ...EMPTY_REPORT_BASE,
  kind: 'thermal',
  inspectorCredentials: '',
  inspectorContact: '',
  cameraMake: '',
  cameraModel: '',
  cameraSerial: '',
  assetTags: '',
  ambientTempC: null,
  humidityPct: null,
  loadConditions: '',
  emissivity: null,
  reflectedTempC: null,
  measurementDistanceM: null,
  imagingLog: [],
  anomalies: [],
  inventory: [],
  actionPlan: '',
  followUp: '',
  limitations: DEFAULT_THERMAL_LIMITATIONS,
};

export const EMPTY_PHOTOGRAMMETRY_REPORT: PhotogrammetryReport = {
  ...EMPTY_REPORT_BASE,
  kind: 'photogrammetry',
  projectName: '',
  clientName: '',
  pilotCredentials: '',
  pilotContact: '',
  surveyPurpose: '',
  windConditions: '',
  lighting: '',
  cameraSensor: '',
  software: '',
  imageCount: null,
  imagesAligned: null,
  flightAltitudeM: null,
  gsdCmPx: null,
  gcpCount: null,
  rmseCm: null,
  crs: '',
  processingNotes: '',
  deliverables: [],
  figures: [],
  outputAssetIds: [],
  measurements: [],
  findings: [],
  observations: [],
  conclusions: '',
};

/** Photogrammetry finding categories → labels. */
export const PHOTO_FINDING_CATEGORIES: Record<string, string> = {
  structural_defect: 'Structural Defect',
  surface_deterioration: 'Surface Deterioration',
  vegetation_encroachment: 'Vegetation Encroachment',
  erosion_drainage: 'Erosion / Drainage',
  obstruction: 'Encroachment / Obstruction',
  survey_note: 'Survey / Accuracy Note',
  other: 'Other',
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
