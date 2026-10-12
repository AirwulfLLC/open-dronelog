/**
 * Thermal inspection report workflow: sections, export-time content and the
 * report-kind hooks for the shared shell. To add a component to this report,
 * add a field to ThermalReport, a section definition below, and render it in
 * src/lib/reports/thermalReport.ts.
 */

import React, { useCallback } from 'react';
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
import { mergeById, parseAiJson } from '@/lib/reports/ai';
import { CLASSIFICATION_LABELS, EMPTY_THERMAL_REPORT, type ThermalReport } from '@/types/thermal';
import { ReportShell, type PreviewEditResult } from './ReportShell';
import { HeaderSection } from './sections/HeaderSection';
import { FlightDataSection } from './sections/FlightDataSection';
import { OrthomosaicSection } from './sections/OrthomosaicSection';
import { ThermalImagingActions, ThermalImagingSection } from './sections/ThermalImagingSection';
import { AnomaliesActions, AnomaliesSection } from './sections/AnomaliesSection';
import { makeTextSection } from './sections/TextSection';
import type { ReportSectionDef, SectionProps } from './types';

/** Facts shared by the thermal AI drafts. */
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

const THERMAL_SECTIONS: ReportSectionDef<ThermalReport>[] = [
  {
    key: 'header',
    title: 'Header Data',
    Component: (p: SectionProps<ThermalReport>) => <HeaderSection {...p} labels={THERMAL_HEADER_LABELS} />,
    ai: {
      instruction: () =>
        'Write the Summary of this thermal inspection report: one or two short paragraphs covering the scope and method (UAV thermal imaging with a DJI radiometric camera), the site and conditions, what was imaged, and the overall condition with the number of anomalies by severity. Do not list every anomaly.',
      facts: (r) => ({
        propertyAddress: r.propertyAddress,
        inspectionDate: r.inspectionDate,
        weatherConditions: r.weatherConditions,
        inspector: r.inspectorName,
        existingSummaryNotes: r.summary || undefined,
        flights: flightFacts(r),
        imagingPairs: r.imagingLog.map((e) => ({ caption: e.caption, lrf: e.lrfData || undefined })),
        anomalies: anomalyFacts(r),
      }),
      apply: (_r, reply) => ({ summary: reply }),
      snapshot: (r) => ({ summary: r.summary }),
    },
  },
  { key: 'flights', title: 'Flight Data (DJI)', Component: FlightDataSection },
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
      facts: (r) => ({ anomalies: anomalyFacts(r) }),
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
    key: 'actionPlan',
    title: 'Action Plan & Repair Prioritization',
    Component: makeTextSection<ThermalReport>('actionPlan', {
      placeholder:
        '1. (High) Repair active moisture intrusion at A-01 …\n2. (Medium) Re-insulate void at A-02 …\n3. Energy-saving upgrades: …',
    }),
    ai: {
      instruction: () =>
        'Write the Action Plan & Repair Prioritization as a numbered list: one item per anomaly (or per group of related anomalies), ordered High → Medium → Low severity, each naming the anomaly id, the corrective action and a timeframe (immediate / schedule / monitor). Close with one sentence on verification by follow-up scan. If there are no anomalies, state that no corrective action is required and recommend a routine re-inspection interval.',
      facts: (r) => ({ anomalies: anomalyFacts(r), existingPlanNotes: r.actionPlan || undefined }),
      apply: (_r, reply) => ({ actionPlan: reply }),
      snapshot: (r) => ({ actionPlan: r.actionPlan }),
    },
  },
];

function emptyThermalReport(): ThermalReport {
  return { ...EMPTY_THERMAL_REPORT, inspectionDate: new Date().toISOString().slice(0, 10) };
}

/** Stored JSON → current shape. Fields this workflow no longer knows (e.g. the
 *  `photogrammetry` figures of reports saved by the earlier combined builder)
 *  ride along untouched, so re-saving never destroys them. */
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

interface Props {
  onClose: () => void;
  /** Thermal Studio's live composed view (palette + annotations) of the selected asset. */
  exportComposedImage: React.MutableRefObject<(() => Promise<string | null>) | null>;
}

export function ThermalReportBuilder({ onClose, exportComposedImage }: Props) {
  const { assets, selectedAssetId, annotations } = useThermalStore();

  const assetToDataUrl = useCallback(
    async (assetId: number | null): Promise<string | null> => {
      if (assetId == null) return null;
      const asset = assets.find((a) => a.id === assetId);
      if (!asset || asset.assetType !== 'image') return null;
      // Use the live annotated/palette-rendered view for the selected asset
      if (
        assetId === selectedAssetId &&
        exportComposedImage.current &&
        (annotations.length > 0 || asset.isRadiometric)
      ) {
        try {
          const composed = await exportComposedImage.current();
          if (composed) return composed;
        } catch {
          // fall through to the stored file
        }
      }
      return readAssetDataUrl(asset);
    },
    [assets, selectedAssetId, exportComposedImage, annotations],
  );

  const prepare = useCallback(
    async (report: ThermalReport): Promise<ThermalPrepared> => {
      // Notes typed moments ago must be in the list we read from
      await useThermalStore.getState().flushAssetNotes();
      const current = useThermalStore.getState().assets;
      const images: ReportImages = {};
      const find = (id: number | null) => (id == null ? null : current.find((x) => x.id === id) ?? null);
      for (const entry of report.imagingLog) {
        const visual = find(entry.visualAssetId);
        const thermal = find(entry.thermalAssetId);
        const notes: PairNote[] = [];
        if (visual) notes.push({ assetId: visual.id, label: 'Visual note', text: visual.notes ?? '' });
        if (thermal) notes.push({ assetId: thermal.id, label: 'Thermal note', text: thermal.notes ?? '' });
        images[entry.id] = {
          thermal: await assetToDataUrl(entry.thermalAssetId),
          visual: await assetToDataUrl(entry.visualAssetId),
          notes,
          // Picture names as they read in the library (renames included)
          details: pairDetails(visual, thermal),
        };
      }
      return { images, extras: await collectOrthoExtras(report.orthoAssetId, current) };
    },
    [assetToDataUrl],
  );

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
      referencedAssetIds={referencedAssetIds}
      prepare={prepare}
      render={renderThermalReport}
      onPreviewEdit={routeAssetNoteEdit}
      onClose={onClose}
    />
  );
}
