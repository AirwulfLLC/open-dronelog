/**
 * Photogrammetry survey report workflow: sections, export-time content and
 * the report-kind hooks for the shared shell. The figure list is the
 * Photogrammetry tab's queue (shared store): saving snapshots it into the
 * report, loading a saved report restores it.
 *
 * To add a component to this report, add a field to PhotogrammetryReport, a
 * section definition below, and render it in
 * src/lib/reports/photogrammetryReport.ts.
 */

import { useCallback, useMemo } from 'react';
import { useThermalStore } from '@/stores/thermalStore';
import { sanitizeQueueEntries, usePhotogrammetryStore } from '@/stores/photogrammetryStore';
import { buildPhotogrammetryFigures } from '@/lib/photogrammetryExport';
import { mergeById, parseAiJson } from '@/lib/reports/ai';
import { PHOTOGRAMMETRY_HEADER_LABELS } from '@/lib/reports/common';
import { collectOrthoExtras } from '@/lib/reports/extras';
import {
  renderPhotogrammetryReport,
  type MetashapeOutputSummary,
  type PhotogrammetryPrepared,
} from '@/lib/reports/photogrammetryReport';
import {
  CORE_DELIVERABLE_KINDS,
  DELIVERABLE_KIND_LABELS,
  ELEVATION_DELIVERABLE_KINDS,
  EMPTY_PHOTOGRAMMETRY_REPORT,
  MEASUREMENT_KIND_LABELS,
  METASHAPE_KIND_LABELS,
  PHOTO_FINDING_CATEGORIES,
  parseMetashapeMeta,
  type PhotogrammetryReport,
  type ThermalAsset,
} from '@/types/thermal';
import { ReportShell, type PreviewEditResult } from './ReportShell';
import { routeAssetNoteEdit } from './ThermalReportBuilder';
import { HeaderSection } from './sections/HeaderSection';
import { makeFlightDataSection } from './sections/FlightDataSection';
import { OrthomosaicSection } from './sections/OrthomosaicSection';
import { PhotogrammetryFiguresSection } from './sections/PhotogrammetryFiguresSection';
import { DeliverablesSection } from './sections/DeliverablesSection';
import { makeDeliverablesSection } from './sections/DeliverableRowsSection';
import { SurveyConditionsSection } from './sections/SurveyConditionsSection';
import { TechnicalSpecsActions, TechnicalSpecsSection } from './sections/TechnicalSpecsSection';
import { MeasurementsActions, MeasurementsSection } from './sections/MeasurementsSection';
import { FindingsActions, FindingsSection } from './sections/FindingsSection';
import { makeTextSection } from './sections/TextSection';
import {
  inputCls,
  labelCls,
  type ReportPatch,
  type ReportSectionDef,
  type SectionAi,
  type SectionProps,
} from './types';

function PhotogrammetryHeader(p: SectionProps<PhotogrammetryReport>) {
  const { report, update } = p;
  return (
    <HeaderSection
      {...p}
      labels={PHOTOGRAMMETRY_HEADER_LABELS}
      showWeather={false}
      summaryPlaceholder="Deliverables produced, coverage, overall site condition…"
      afterPerson={
        <>
          <div>
            <label className={labelCls}>Pilot credentials</label>
            <input
              className={inputCls}
              value={report.pilotCredentials}
              onChange={(e) => update({ pilotCredentials: e.target.value })}
              placeholder="FAA Part 107 remote pilot certificate no. …"
            />
          </div>
          <div>
            <label className={labelCls}>Pilot contact</label>
            <input
              className={inputCls}
              value={report.pilotContact}
              onChange={(e) => update({ pilotContact: e.target.value })}
              placeholder="Company · phone · e-mail"
            />
          </div>
          <div>
            <label className={labelCls}>Flight time (from the flight logs)</label>
            <input
              className={inputCls}
              value={report.inspectionTime}
              onChange={(e) => update({ inspectionTime: e.target.value })}
              placeholder="09:31–10:12"
            />
          </div>
          <div>
            <label className={labelCls}>Site position (from the flight logs)</label>
            <input
              className={inputCls}
              value={report.sitePosition}
              onChange={(e) => update({ sitePosition: e.target.value })}
              placeholder="41.110300, -85.211000"
            />
          </div>
        </>
      }
    >
      <div>
        <label className={labelCls}>Project name</label>
        <input
          className={inputCls}
          value={report.projectName}
          onChange={(e) => update({ projectName: e.target.value })}
          placeholder="Riverside warehouse roof survey — Phase 2"
        />
      </div>
      <div>
        <label className={labelCls}>Client</label>
        <input
          className={inputCls}
          value={report.clientName}
          onChange={(e) => update({ clientName: e.target.value })}
          placeholder="Riverside Holdings LLC"
        />
      </div>
    </HeaderSection>
  );
}

const coreDeliverables = makeDeliverablesSection(CORE_DELIVERABLE_KINDS, {
  seedFromFiles: true,
  emptyHint:
    'List the orthomosaic map, 3D point cloud and 3D textured mesh produced for this survey (resolution, point count, format, where they are hosted). "From imported files" creates rows from the Metashape products in the library.',
});

const elevationDeliverables = makeDeliverablesSection(ELEVATION_DELIVERABLE_KINDS, {
  seedFromFiles: true,
  emptyHint:
    'Digital elevation / surface models (DEM/DSM), digital terrain models (DTM) and contour line maps produced from the survey, with their resolution, interval and format. "From imported files" picks up GeoTIFFs named dem/dsm/dtm/contour.',
});

function CoreDeliverables(p: SectionProps<PhotogrammetryReport>) {
  return (
    <div className="space-y-3">
      <OrthomosaicSection
        {...p}
        importHint="Import your Metashape deliverables (orthomosaic GeoTIFFs, processing reports, camera files, point clouds) into the Photogrammetry library to embed the orthomosaic here and list the files in the report."
      >
        <DeliverablesSection {...p} />
      </OrthomosaicSection>
      <div>
        <label className={labelCls}>Deliverables produced</label>
        <coreDeliverables.Component {...p} />
      </div>
    </div>
  );
}

/** Flight logs fill the base fields plus the image count and flight altitude. */
const photogrammetryFlights = makeFlightDataSection<PhotogrammetryReport>((d) => {
  const patch: ReportPatch<PhotogrammetryReport> = {};
  if (d.photoCount != null) patch.imageCount = d.photoCount;
  if (d.maxAltitudeM != null) patch.flightAltitudeM = Math.round(d.maxAltitudeM);
  return patch;
});

const PHOTOGRAMMETRY_SECTIONS: ReportSectionDef<PhotogrammetryReport>[] = [
  { key: 'header', title: 'Header Data & Project Metadata', Component: PhotogrammetryHeader },
  {
    key: 'scope',
    title: 'Survey Scope',
    Component: makeTextSection<PhotogrammetryReport>('surveyPurpose', {
      minHeight: 64,
      placeholder: 'Objective, area of interest, required accuracy, deliverables requested…',
    }),
  },
  { key: 'conditions', title: 'Environmental Conditions', Component: SurveyConditionsSection },
  {
    key: 'flights',
    title: 'Flight Data (DJI)',
    Component: photogrammetryFlights.Component,
    Actions: photogrammetryFlights.Actions,
  },
  {
    key: 'specs',
    title: 'Hardware, Software & Accuracy',
    Component: TechnicalSpecsSection,
    Actions: TechnicalSpecsActions,
  },
  {
    key: 'processing',
    title: 'Processing Notes',
    Component: makeTextSection<PhotogrammetryReport>('processingNotes', {
      minHeight: 64,
      placeholder:
        'Alignment: high accuracy, generic + reference preselection · depth maps: medium · dense cloud 48 M points · mesh 2 M faces · 6 GCPs, RMSE 2.1 cm · CRS EPSG:6471',
    }),
  },
  {
    key: 'core',
    title: 'Core Visual Deliverables (Agisoft Metashape)',
    Component: CoreDeliverables,
    Actions: coreDeliverables.Actions,
  },
  {
    key: 'elevation',
    title: 'Topographical & Elevation Data',
    Component: elevationDeliverables.Component,
    Actions: elevationDeliverables.Actions,
  },
  { key: 'figures', title: 'Survey Imagery', Component: PhotogrammetryFiguresSection },
  {
    key: 'measurements',
    title: 'Advanced Analysis & Measurements',
    Component: MeasurementsSection,
    Actions: MeasurementsActions,
  },
  {
    key: 'findings',
    title: 'Findings & Observations (Asset Inspection Notes)',
    Component: FindingsSection,
    Actions: FindingsActions,
  },
  {
    key: 'conclusions',
    title: 'Conclusions & Recommendations',
    Component: makeTextSection<PhotogrammetryReport>('conclusions', {
      placeholder: 'Overall condition, priority items, follow-up survey interval…',
    }),
  },
];

// ---- AI drafting: facts come only from what the user entered ----

const flightFacts = (r: PhotogrammetryReport) =>
  r.linkedFlights.map((f) => ({
    name: f.displayName,
    date: f.startTime,
    drone: f.droneModel,
    durationSecs: f.durationSecs,
    distanceM: f.totalDistance,
    maxAltitudeM: f.maxAltitude,
    photos: f.photoCount,
  }));

const findingFacts = (r: PhotogrammetryReport) =>
  r.findings.map((f) => ({
    id: f.id,
    refId: f.refId,
    figure: f.figureId ? `Figure ${r.figures.findIndex((x) => x.id === f.figureId) + 1}` : undefined,
    location: f.location,
    category: PHOTO_FINDING_CATEGORIES[f.category] ?? f.category,
    severity: f.severity,
    observation: f.observation || undefined,
    recommendation: f.recommendation || undefined,
  }));

const observationFacts = (r: PhotogrammetryReport) =>
  r.observations.map((o) => ({
    id: o.id,
    refId: o.refId,
    figure: o.figureId ? `Figure ${r.figures.findIndex((x) => x.id === o.figureId) + 1}` : undefined,
    location: o.location,
    text: o.text || undefined,
  }));

const figureFacts = (r: PhotogrammetryReport) =>
  r.figures.map((f, i) => ({ figure: i + 1, caption: f.caption || undefined }));

const conditionFacts = (r: PhotogrammetryReport) => ({
  weather: r.weatherConditions || undefined,
  wind: r.windConditions || undefined,
  lighting: r.lighting || undefined,
});

const specFacts = (r: PhotogrammetryReport) => ({
  aircraft: r.droneModel || undefined,
  cameraSensor: r.cameraSensor || undefined,
  software: r.software || undefined,
  imagesCaptured: r.imageCount ?? undefined,
  imagesAligned: r.imagesAligned ?? undefined,
  flightAltitudeM: r.flightAltitudeM ?? undefined,
  gsdCmPerPixel: r.gsdCmPx ?? undefined,
  groundControlPoints: r.gcpCount ?? undefined,
  rmseCm: r.rmseCm ?? undefined,
  crs: r.crs || undefined,
});

const deliverableRowFacts = (r: PhotogrammetryReport) =>
  r.deliverables.map((d) => ({
    deliverable: d.kind === 'other' ? d.title || 'Other' : DELIVERABLE_KIND_LABELS[d.kind],
    status: d.status === 'produced' ? 'produced' : 'not produced',
    details: d.details || undefined,
    hostedAt: d.link || undefined,
  }));

const measurementFacts = (r: PhotogrammetryReport) =>
  r.measurements.map((m) => ({
    type: MEASUREMENT_KIND_LABELS[m.kind],
    feature: m.feature,
    value: m.value == null ? undefined : `${m.value} ${m.unit}`.trim(),
    method: m.method || undefined,
    figure: m.figureId ? `Figure ${r.figures.findIndex((x) => x.id === m.figureId) + 1}` : undefined,
  }));

/** Adds the AI drafting definitions; file names need the asset list. */
function withAi(sections: ReportSectionDef<PhotogrammetryReport>[], assets: ThermalAsset[]) {
  const fileFacts = (r: PhotogrammetryReport) =>
    metashapeOutputs(assets, r.outputAssetIds).map((o) => ({ file: o.fileName, kind: o.kindLabel, details: o.details || undefined }));
  const siteFacts = (r: PhotogrammetryReport) => ({
    projectName: r.projectName || undefined,
    client: r.clientName || undefined,
    siteAddress: r.propertyAddress,
    sitePosition: r.sitePosition || undefined,
    surveyDate: r.inspectionDate,
    flightTime: r.inspectionTime || undefined,
    operator: r.inspectorName,
  });
  const ai: Record<string, SectionAi<PhotogrammetryReport>> = {
    header: {
      instruction: () =>
        'Write the Summary of this photogrammetry survey report: one or two short paragraphs covering the project, client and site, the method (UAV photogrammetry with the stated aircraft and camera, processed in the stated software), the accuracy achieved where given, the deliverables produced, the key measurements, and the overall condition found, mentioning the number of findings by severity. Do not list every finding.',
      facts: (r) => ({
        ...siteFacts(r),
        surveyScopeNotes: r.surveyPurpose || undefined,
        existingSummaryNotes: r.summary || undefined,
        conditions: conditionFacts(r),
        specifications: specFacts(r),
        flights: flightFacts(r),
        deliverables: deliverableRowFacts(r),
        filesDelivered: fileFacts(r),
        figures: figureFacts(r),
        measurements: measurementFacts(r),
        findings: findingFacts(r),
        observations: observationFacts(r),
      }),
      apply: (_r, reply) => ({ summary: reply }),
      snapshot: (r) => ({ summary: r.summary }),
    },
    scope: {
      instruction: () =>
        'Write the Survey Scope section: the objective, the client and the area of interest, the method (UAV photogrammetry, the processing software) and the deliverables requested or produced. One or two short paragraphs.',
      facts: (r) => ({
        ...siteFacts(r),
        existingScopeNotes: r.surveyPurpose || undefined,
        summaryNotes: r.summary || undefined,
        specifications: specFacts(r),
        flights: flightFacts(r),
        deliverables: deliverableRowFacts(r),
        filesDelivered: fileFacts(r),
        figures: figureFacts(r),
      }),
      apply: (_r, reply) => ({ surveyPurpose: reply }),
      snapshot: (r) => ({ surveyPurpose: r.surveyPurpose }),
    },
    processing: {
      instruction: () =>
        'Write the Processing Notes: the imagery captured (counts, altitude and dates where given), the software and workflow, the products generated and their characteristics (resolution, bands, coordinate system, camera and marker counts), and the accuracy information given (GSD, control points, RMSE). Where a value is not in the facts, do not invent it — say it was not recorded. One short paragraph or a few compact sentences.',
      facts: (r) => ({
        existingProcessingNotes: r.processingNotes || undefined,
        specifications: specFacts(r),
        conditions: conditionFacts(r),
        flights: flightFacts(r),
        deliverables: deliverableRowFacts(r),
        filesDelivered: fileFacts(r),
      }),
      apply: (_r, reply) => ({ processingNotes: reply }),
      snapshot: (r) => ({ processingNotes: r.processingNotes }),
    },
    findings: {
      instruction: () =>
        'For each finding write "observation" (one to three sentences describing what the imagery shows at that location and what it indicates, consistent with the category and severity) and "recommendation" (a specific follow-up or corrective action). For each observation entry write "text" (one to two neutral sentences recording what was seen — no defect grading). Keep the intent of any existing text. Return ONLY JSON: {"findings": [{"id", "observation", "recommendation"}], "observations": [{"id", "text"}]} using the given ids — no other text.',
      facts: (r) => ({
        findings: findingFacts(r),
        observations: observationFacts(r),
        figures: figureFacts(r),
        measurements: measurementFacts(r),
      }),
      apply: (r, reply) => {
        const parsed = parseAiJson<{ findings?: unknown; observations?: unknown }>(reply);
        if (!parsed || typeof parsed !== 'object') return null;
        const f = mergeById(r.findings, parsed.findings, ['observation', 'recommendation']);
        const o = mergeById(r.observations, parsed.observations, ['text']);
        if (!f.changed && !o.changed) return null;
        return { findings: f.entries, observations: o.entries };
      },
      snapshot: (r) => ({ findings: r.findings, observations: r.observations }),
      // Restore the drafted text per entry; entries added since stay
      restore: (r, snap) => ({
        findings: r.findings.map((f) => {
          const before = (snap.findings ?? []).find((x) => x.id === f.id);
          return before ? { ...f, observation: before.observation, recommendation: before.recommendation } : f;
        }),
        observations: r.observations.map((o) => {
          const before = (snap.observations ?? []).find((x) => x.id === o.id);
          return before ? { ...o, text: before.text } : o;
        }),
      }),
    },
    conclusions: {
      instruction: () =>
        'Write the Conclusions & Recommendations section: the overall condition of the site, what the deliverables and measurements establish, the priority items by severity, and the recommended follow-up actions and re-survey interval. One or two short paragraphs; refer to findings by their ids.',
      facts: (r) => ({
        summaryNotes: r.summary || undefined,
        scopeNotes: r.surveyPurpose || undefined,
        existingConclusionNotes: r.conclusions || undefined,
        specifications: specFacts(r),
        deliverables: deliverableRowFacts(r),
        measurements: measurementFacts(r),
        findings: findingFacts(r),
        observations: observationFacts(r),
      }),
      apply: (_r, reply) => ({ conclusions: reply }),
      snapshot: (r) => ({ conclusions: r.conclusions }),
    },
  };
  return sections.map((s) => (ai[s.key] ? { ...s, ai: ai[s.key] } : s));
}

function emptyPhotogrammetryReport(): PhotogrammetryReport {
  return { ...EMPTY_PHOTOGRAMMETRY_REPORT, inspectionDate: new Date().toISOString().slice(0, 10) };
}

/** Stored JSON → current shape; the figure list lives in the queue store.
 *  Reports saved before a section existed get its empty value. */
function normalizePhotogrammetry(parsed: Record<string, unknown>): PhotogrammetryReport {
  // A bundle import nulls ids whose assets were not in the bundle
  const outputAssetIds = Array.isArray(parsed.outputAssetIds)
    ? parsed.outputAssetIds.filter((id): id is number => typeof id === 'number')
    : [];
  return {
    ...EMPTY_PHOTOGRAMMETRY_REPORT,
    ...(parsed as Partial<PhotogrammetryReport>),
    kind: 'photogrammetry',
    figures: [],
    outputAssetIds,
  };
}

/** The deliverables the user ticked, in library order. */
function metashapeOutputs(assets: ThermalAsset[], selectedIds: number[]): MetashapeOutputSummary[] {
  const selected = new Set(selectedIds);
  return assets
    .filter((a) => a.source === 'metashape' && selected.has(a.id))
    .map((a) => {
      const m = parseMetashapeMeta(a);
      const details = [
        m?.width ? `${m.width}×${m.height} px` : null,
        m?.bands ? `${m.bands} bands` : null,
        m?.cameraCount != null ? `${m.cameraCount.toLocaleString()} cameras` : null,
        m?.markerCount != null ? `${m.markerCount} markers` : null,
        m?.crs ?? null,
        m?.indexName ? `index ${m.indexName}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return { fileName: a.fileName, kindLabel: m ? METASHAPE_KIND_LABELS[m.kind] ?? m.kind : 'Metashape export', details };
    });
}

const FIGURE_CAPTION = /^figures\.(\d+)\.caption$/;

interface Props {
  onClose: () => void;
}

export function PhotogrammetryReportBuilder({ onClose }: Props) {
  const assets = useThermalStore((s) => s.assets);
  const { queue, setQueue, updateEntry } = usePhotogrammetryStore();
  const sections = useMemo(() => withAi(PHOTOGRAMMETRY_SECTIONS, assets), [assets]);

  const prepare = useCallback(
    async (report: PhotogrammetryReport): Promise<PhotogrammetryPrepared> => {
      // Debounced annotation and note edits must be in the DB / list first
      await usePhotogrammetryStore.getState().flushAnnotations();
      await useThermalStore.getState().flushAssetNotes();
      const current = useThermalStore.getState().assets;
      return {
        ...(await collectOrthoExtras(report.orthoAssetId, current)),
        figures: await buildPhotogrammetryFigures(report.figures, current),
        metashapeOutputs: metashapeOutputs(current, report.outputAssetIds),
      };
    },
    [],
  );

  // The queue store is canonical for figures: snapshot it on save/export and
  // restore it from a loaded report (reports predating figures leave it alone).
  // Deliverable ids whose assets were deleted since are pruned here.
  const serialize = useCallback(
    (report: PhotogrammetryReport): PhotogrammetryReport => ({
      ...report,
      figures: queue,
      outputAssetIds: report.outputAssetIds.filter((id) => assets.some((a) => a.id === id)),
    }),
    [queue, assets],
  );
  const onLoaded = useCallback(
    (parsed: Record<string, unknown>) => {
      const stored = parsed.figures ?? parsed.photogrammetry;
      if (Array.isArray(stored)) setQueue(sanitizeQueueEntries(stored));
    },
    [setQueue],
  );
  const onNewBlank = useCallback(() => {
    // Loading replaces the queue, so a blank report offers the symmetric
    // reset — but the queue may be imagery staged for this new report.
    if (
      queue.length > 0 &&
      window.confirm(
        `Also clear the ${queue.length} queued figure(s)?\n\nChoose Cancel to keep them for the new report.`,
      )
    ) {
      setQueue([]);
    }
  }, [queue, setQueue]);

  /** Figure captions live in the queue; picture notes on the asset. */
  const onPreviewEdit = useCallback(
    (path: string, value: string): PreviewEditResult => {
      const m = FIGURE_CAPTION.exec(path);
      if (m) {
        const entry = queue[Number(m[1])];
        if (entry) updateEntry(entry.id, { caption: value });
        return { handled: true };
      }
      return routeAssetNoteEdit(path, value);
    },
    [queue, updateEntry],
  );

  const referencedAssetIds = useCallback(
    (report: PhotogrammetryReport): number[] => {
      // Only this report's own evidence travels: its figures, the embedded
      // orthomosaic and the deliverables the user listed — not every Metashape
      // file in the shared library.
      const ids = new Set<number>();
      for (const f of report.figures) ids.add(f.assetId);
      if (report.orthoAssetId != null) ids.add(report.orthoAssetId);
      for (const id of report.outputAssetIds) ids.add(id);
      return [...ids];
    },
    [],
  );

  return (
    <ReportShell<PhotogrammetryReport, PhotogrammetryPrepared>
      kind="photogrammetry"
      title="Photogrammetry Survey Report"
      icon="📷"
      defaultName="Survey Report"
      aiWorkflow="photogrammetry survey"
      empty={emptyPhotogrammetryReport}
      sections={sections}
      normalize={normalizePhotogrammetry}
      onLoaded={onLoaded}
      serialize={serialize}
      referencedAssetIds={referencedAssetIds}
      prepare={prepare}
      render={renderPhotogrammetryReport}
      onPreviewEdit={onPreviewEdit}
      onNewBlank={onNewBlank}
      onClose={onClose}
    />
  );
}
