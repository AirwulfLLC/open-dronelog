/**
 * Thermal inspection report workflow: sections, export-time content and the
 * report-kind hooks for the shared shell. To add a component to this report,
 * add a field to ThermalReport, a section definition below, and render it in
 * src/lib/reports/thermalReport.ts.
 */

import { useCallback } from 'react';
import { useThermalStore } from '@/stores/thermalStore';
import { THERMAL_HEADER_LABELS } from '@/lib/reports/common';
import { collectOrthoExtras, readAssetDataUrl } from '@/lib/reports/extras';
import {
  pairDetails,
  renderThermalReport,
  type PairNote,
  type ReportImages,
  type ThermalPrepared,
} from '@/lib/reports/thermalReport';
import { renderRadiometricAsset } from '@/lib/reports/thermalRender';
import { rememberThermalReportDefaults, thermalReportDefaults } from '@/lib/reports/thermalDefaults';
import { composeFigure, loadAssetAnnotations } from '@/lib/photogrammetryExport';
import { mergeById, parseAiJson } from '@/lib/reports/ai';
import {
  CLASSIFICATION_LABELS,
  DEFAULT_THERMAL_LIMITATIONS,
  EMPTY_THERMAL_REPORT,
  INVENTORY_STATUS_LABELS,
  valueSuffixFor,
  type MeasureOverrides,
  type ReportImageEntry,
  type ThermalAsset,
  type ThermalReport,
} from '@/types/thermal';
import { ReportShell, type PreviewEditResult } from './ReportShell';
import { HeaderSection } from './sections/HeaderSection';
import { ThermalAdminFields } from './sections/AdministrativeFields';
import { ConditionsActions, ConditionsSection } from './sections/ConditionsSection';
import { makeFlightDataSection } from './sections/FlightDataSection';
import { OrthomosaicSection } from './sections/OrthomosaicSection';
import { ThermalImagingActions, ThermalImagingSection } from './sections/ThermalImagingSection';
import { AnomaliesActions, AnomaliesSection } from './sections/AnomaliesSection';
import { InventoryActions, InventorySection } from './sections/InventorySection';
import { makeTextSection } from './sections/TextSection';
import { smallBtnCls, type ReportSectionDef, type SectionProps } from './types';

// ---- AI drafting facts: only what the user entered ----

const anomalyFacts = (r: ThermalReport) =>
  r.anomalies.map((a) => ({
    id: a.id,
    refId: a.refId,
    location: a.location,
    position: a.gpsLat != null && a.gpsLon != null ? `${a.gpsLat}, ${a.gpsLon}` : undefined,
    tMaxC: a.tMax,
    tMinC: a.tMin,
    baselineC: a.baseline,
    deltaTC: a.deltaT,
    severity: a.severity,
    classification: CLASSIFICATION_LABELS[a.classification] ?? a.classification,
    finding: a.finding || undefined,
    recommendation: a.recommendation || undefined,
  }));

const flightFacts = (r: ThermalReport) =>
  r.linkedFlights.map((f) => ({
    name: f.displayName,
    date: f.startTime,
    drone: f.droneModel,
    durationSecs: f.durationSecs,
    maxAltitudeM: f.maxAltitude,
    photos: f.photoCount,
  }));

const adminFacts = (r: ThermalReport) => ({
  propertyAddress: r.propertyAddress,
  sitePosition: r.sitePosition || undefined,
  inspectionDate: r.inspectionDate,
  inspectionTime: r.inspectionTime || undefined,
  inspector: r.inspectorName,
  credentials: r.inspectorCredentials || undefined,
  aircraft: r.droneModel || undefined,
  camera: [r.cameraMake, r.cameraModel].filter(Boolean).join(' ') || undefined,
  assetTags: r.assetTags || undefined,
});

/** Flight logs fill the base fields (date, time window, site, aircraft); nothing thermal-specific. */
const thermalFlights = makeFlightDataSection<ThermalReport>();

const conditionFacts = (r: ThermalReport) => ({
  weather: r.weatherConditions || undefined,
  ambientTempC: r.ambientTempC ?? undefined,
  relativeHumidityPct: r.humidityPct ?? undefined,
  loadConditions: r.loadConditions || undefined,
  emissivity: r.emissivity ?? undefined,
  reflectedTempC: r.reflectedTempC ?? undefined,
  measurementDistanceM: r.measurementDistanceM ?? undefined,
});

const inventoryFacts = (r: ThermalReport) =>
  r.inventory.map((i) => ({
    tag: i.tag,
    description: i.description,
    status: INVENTORY_STATUS_LABELS[i.status],
    note: i.note || undefined,
  }));

function ThermalHeader(p: SectionProps<ThermalReport>) {
  return (
    <HeaderSection
      {...p}
      labels={THERMAL_HEADER_LABELS}
      showWeather={false}
      summaryLabel="Executive summary"
      summaryPlaceholder="Primary discoveries, problem locations and urgency levels…"
      afterPerson={<ThermalAdminFields {...p} />}
    />
  );
}

function LimitationsActions({ report, update }: SectionProps<ThermalReport>) {
  const isStandard = report.limitations.trim() === DEFAULT_THERMAL_LIMITATIONS.trim();
  return (
    <button
      onClick={() => {
        if (
          !report.limitations.trim() ||
          window.confirm('Replace this text with the standard limitations, definitions and disclaimer?')
        ) {
          update({ limitations: DEFAULT_THERMAL_LIMITATIONS });
        }
      }}
      disabled={isStandard}
      className={`${smallBtnCls} disabled:opacity-40`}
      title="Put the standard text back"
    >
      ↺ Standard text
    </button>
  );
}

const THERMAL_SECTIONS: ReportSectionDef<ThermalReport>[] = [
  {
    key: 'header',
    title: 'Header Data & Administrative Information',
    Component: ThermalHeader,
    ai: {
      instruction: () =>
        'Write the Executive Summary of this thermal inspection report: one or two short paragraphs covering the scope and method (UAV thermal imaging with the radiometric camera, equipment and conditions stated), the site, what was imaged, the primary discoveries with their locations and urgency, the overall condition with the number of anomalies by severity, and any assets that could not be inspected. Do not list every anomaly.',
      facts: (r) => ({
        ...adminFacts(r),
        conditions: conditionFacts(r),
        existingSummaryNotes: r.summary || undefined,
        flights: flightFacts(r),
        imagingPairs: r.imagingLog.map((e) => ({ caption: e.caption, lrf: e.lrfData || undefined })),
        anomalies: anomalyFacts(r),
        assetInventory: inventoryFacts(r),
      }),
      apply: (_r, reply) => ({ summary: reply }),
      snapshot: (r) => ({ summary: r.summary }),
    },
  },
  {
    key: 'conditions',
    title: 'Environmental & System Conditions',
    Component: ConditionsSection,
    Actions: ConditionsActions,
  },
  {
    key: 'flights',
    title: 'Flight Data (DJI)',
    Component: thermalFlights.Component,
    Actions: thermalFlights.Actions,
  },
  {
    key: 'ortho',
    title: 'Orthomosaic (Agisoft Metashape)',
    Component: (p: SectionProps<ThermalReport>) => (
      <OrthomosaicSection
        {...p}
        importHint="Import a Metashape orthomosaic (GeoTIFF) into the Thermal Studio asset library to embed it here. Processing reports, camera files and point clouds can also be imported — they travel with exported inspection bundles."
      />
    ),
  },
  {
    key: 'imaging',
    title: 'Thermal Imaging Log / Comparative Matrix',
    Component: ThermalImagingSection,
    Actions: ThermalImagingActions,
  },
  {
    key: 'anomalies',
    title: 'Anomalies & Findings',
    Component: AnomaliesSection,
    Actions: AnomaliesActions,
    ai: {
      instruction: () =>
        'For each anomaly write "finding" (one to three sentences interpreting the thermal signature from the measured temperatures, delta-T and classification — what it most likely indicates and why) and "recommendation" (a specific corrective or verification action). Where existing text is given, keep its intent and improve the wording. Return ONLY a JSON array of objects {"id", "finding", "recommendation"} using the given ids — no other text.',
      facts: (r) => ({ conditions: conditionFacts(r), anomalies: anomalyFacts(r) }),
      apply: (r, reply) => {
        const parsed = parseAiJson<unknown>(reply);
        // Accept a bare array or a {"anomalies": [...]} wrapper
        const rows = Array.isArray(parsed) ? parsed : (parsed as { anomalies?: unknown } | null)?.anomalies;
        const { entries, changed } = mergeById(r.anomalies, rows, ['finding', 'recommendation']);
        return changed ? { anomalies: entries } : null;
      },
      snapshot: (r) => ({ anomalies: r.anomalies }),
      // Restore the drafted text per anomaly; anomalies added since stay
      restore: (r, snap) => ({
        anomalies: r.anomalies.map((a) => {
          const before = (snap.anomalies ?? []).find((x) => x.id === a.id);
          return before ? { ...a, finding: before.finding, recommendation: before.recommendation } : a;
        }),
      }),
    },
  },
  {
    key: 'inventory',
    title: 'Asset Inventory & Exception List',
    Component: InventorySection,
    Actions: InventoryActions,
  },
  {
    key: 'actionPlan',
    title: 'Action Plan & Repair Prioritization',
    Component: makeTextSection<ThermalReport>('actionPlan', {
      placeholder:
        '1. (High) Repair active moisture intrusion at A-01 …\n2. (Medium) Re-insulate void at A-02 …\n3. Energy-saving upgrades: …',
    }),
    ai: {
      instruction: () =>
        'Write the Action Plan & Repair Prioritization as a numbered list: one item per anomaly (or per group of related anomalies), ordered High → Medium → Low severity, each naming the anomaly id, the corrective, troubleshooting or predictive-maintenance action as a work order, and a timeframe (immediate / schedule / monitor). If there are no anomalies, state that no corrective action is required.',
      facts: (r) => ({ anomalies: anomalyFacts(r), assetInventory: inventoryFacts(r), existingPlanNotes: r.actionPlan || undefined }),
      apply: (_r, reply) => ({ actionPlan: reply }),
      snapshot: (r) => ({ actionPlan: r.actionPlan }),
    },
  },
  {
    key: 'followUp',
    title: 'Follow-Up & Re-inspection',
    Component: makeTextSection<ThermalReport>('followUp', {
      placeholder:
        'Post-repair verification scan of A-01 and A-02 within 30 days of the repair, under comparable load and ambient conditions …\nPeriodic re-inspection of the switchgear every 12 months; trend the hot-spot temperatures against this report.',
    }),
    ai: {
      instruction: () =>
        'Write the Follow-Up & Re-inspection plan: for each High and Medium anomaly, the post-repair verification scan to perform and when; the periodic re-inspection or temperature-trending interval appropriate to the assets inspected; what later scans should reproduce from this report to be comparable (load conditions, ambient conditions, emissivity and distance settings, palette and scale); and a note on any assets that were not inspected. If there are no anomalies, recommend a routine interval only. A short numbered list or two short paragraphs.',
      facts: (r) => ({
        inspectionDate: r.inspectionDate,
        conditions: conditionFacts(r),
        anomalies: anomalyFacts(r),
        actionPlanNotes: r.actionPlan || undefined,
        assetInventory: inventoryFacts(r),
        existingFollowUpNotes: r.followUp || undefined,
      }),
      apply: (_r, reply) => ({ followUp: reply }),
      snapshot: (r) => ({ followUp: r.followUp }),
    },
  },
  {
    key: 'limitations',
    title: 'Limitations, Definitions & Disclaimer',
    Component: makeTextSection<ThermalReport>('limitations', {
      minHeight: 180,
      hint: 'Printed as the closing section: what thermography can and cannot show, the terms used, and the disclaimer. Edit freely or restore the standard text.',
    }),
    Actions: LimitationsActions,
  },
];

function emptyThermalReport(): ThermalReport {
  return {
    ...EMPTY_THERMAL_REPORT,
    // The thermographer's details and camera from the last report
    ...thermalReportDefaults(),
    inspectionDate: new Date().toISOString().slice(0, 10),
  };
}

/** Stored JSON → current shape. Fields this workflow no longer knows (e.g. the
 *  `photogrammetry` figures of reports saved by the earlier combined builder)
 *  ride along untouched, so re-saving never destroys them. Reports saved
 *  before a section existed get its empty value (and the standard
 *  limitations text). */
function normalizeThermal(parsed: Record<string, unknown>): ThermalReport {
  return { ...EMPTY_THERMAL_REPORT, ...(parsed as Partial<ThermalReport>), kind: 'thermal' };
}

/** Tell the user when a loaded report carries figures this workflow cannot show. */
function legacyFiguresNotice(parsed: Record<string, unknown>): string | void {
  const legacy = parsed.photogrammetry;
  if (!Array.isArray(legacy) || legacy.length === 0) return;
  return (
    `This report was saved by the earlier combined builder and holds ${legacy.length} photogrammetry ` +
    'figure(s). They stay in the saved document but the thermal report no longer exports them — ' +
    'build a Photogrammetry Survey Report from the Photogrammetry tab to include them.'
  );
}

const ASSET_NOTE_PREFIX = 'assetNote.';

/** Preview edits of picture notes go to the asset, not the report document. */
export function routeAssetNoteEdit(path: string, value: string): PreviewEditResult {
  if (!path.startsWith(ASSET_NOTE_PREFIX)) return { handled: false };
  const id = Number(path.slice(ASSET_NOTE_PREFIX.length));
  if (Number.isFinite(id)) useThermalStore.getState().setAssetNotes(id, value);
  return { handled: true, invalidatesPrepared: true };
}

/** A pair's picture as printed: radiometric pictures through the pair's
 *  palette and span, everything else as stored — the picture's annotations
 *  drawn in either case. */
async function renderPairPicture(
  asset: ThermalAsset,
  entry: ReportImageEntry,
  overrides: MeasureOverrides,
): Promise<{ dataUrl: string | null; scale?: string }> {
  const annotations = await loadAssetAnnotations(asset.id);
  if (asset.isRadiometric) {
    try {
      const r = await renderRadiometricAsset(asset, entry, annotations, overrides);
      if (r) {
        const unit = valueSuffixFor(asset);
        const dp = unit ? 1 : 3;
        return {
          dataUrl: r.dataUrl,
          scale: `${r.paletteLabel} palette, scale ${r.low.toFixed(dp)} to ${r.high.toFixed(dp)}${unit ? ' °C' : ''}`,
        };
      }
    } catch (e) {
      // No SDK (thermal add-on missing) or an unreadable matrix: the stored
      // picture's own rendering, still with its drawings (below)
      console.warn(`Radiometric rendering of "${asset.fileName}" failed:`, e);
    }
  }
  try {
    const composed = await composeFigure(asset, annotations);
    if (composed) return { dataUrl: composed.dataUrl };
  } catch (e) {
    console.warn(`Picture "${asset.fileName}" could not be composed:`, e);
  }
  return { dataUrl: await readAssetDataUrl(asset) };
}

interface Props {
  onClose: () => void;
}

export function ThermalReportBuilder({ onClose }: Props) {
  const assets = useThermalStore((s) => s.assets);

  const prepare = useCallback(async (report: ThermalReport): Promise<ThermalPrepared> => {
    const store = useThermalStore.getState();
    // Drawings and notes made moments ago must be in the database / list first
    await store.flushAnnotations();
    await store.flushAssetNotes();
    const current = store.assets;
    const overrides = store.measureOverrides;
    const find = (id: number | null) => (id == null ? null : (current.find((x) => x.id === id) ?? null));
    const images: ReportImages = {};
    for (const entry of report.imagingLog) {
      const visual = find(entry.visualAssetId);
      const thermal = find(entry.thermalAssetId);
      const notes: PairNote[] = [];
      if (visual) notes.push({ assetId: visual.id, label: 'Visual note', text: visual.notes ?? '' });
      if (thermal) notes.push({ assetId: thermal.id, label: 'Thermal note', text: thermal.notes ?? '' });
      const thermalOut = thermal ? await renderPairPicture(thermal, entry, overrides) : null;
      const visualOut = visual ? await renderPairPicture(visual, entry, overrides) : null;
      images[entry.id] = {
        thermal: thermalOut?.dataUrl ?? null,
        visual: visualOut?.dataUrl ?? null,
        notes,
        // Picture names as they read in the library, palette and scale, capture data
        details: pairDetails(visual, thermal, thermalOut?.scale),
        unit: thermal ? valueSuffixFor(thermal) : '°C',
      };
    }
    return { images, extras: await collectOrthoExtras(report.orthoAssetId, current) };
  }, []);

  const referencedAssetIds = useCallback(
    (report: ThermalReport): number[] => {
      const ids = new Set<number>();
      for (const e of report.imagingLog) {
        if (e.thermalAssetId != null) ids.add(e.thermalAssetId);
        if (e.visualAssetId != null) ids.add(e.visualAssetId);
      }
      for (const a of report.anomalies) {
        if (a.assetId != null) ids.add(a.assetId);
      }
      if (report.orthoAssetId != null) ids.add(report.orthoAssetId);
      // Metashape documents (reports, camera files, point clouds) always
      // travel with the inspection — they are part of its evidence base.
      for (const a of assets) {
        if (a.source === 'metashape') ids.add(a.id);
      }
      return [...ids];
    },
    [assets],
  );

  return (
    <ReportShell<ThermalReport, ThermalPrepared>
      kind="thermal"
      title="Thermal Inspection Report"
      icon="🌡️"
      defaultName="Inspection Report"
      aiWorkflow="thermal inspection"
      empty={emptyThermalReport}
      sections={THERMAL_SECTIONS}
      normalize={normalizeThermal}
      onLoaded={legacyFiguresNotice}
      serialize={(r) => r}
      // The thermographer's details and camera of a saved/exported report seed the next new one
      onPersist={rememberThermalReportDefaults}
      referencedAssetIds={referencedAssetIds}
      prepare={prepare}
      render={renderThermalReport}
      onPreviewEdit={routeAssetNoteEdit}
      onClose={onClose}
    />
  );
}
