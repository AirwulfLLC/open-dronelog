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
  EMPTY_PHOTOGRAMMETRY_REPORT,
  METASHAPE_KIND_LABELS,
  PHOTO_FINDING_CATEGORIES,
  parseMetashapeMeta,
  type PhotogrammetryReport,
  type ThermalAsset,
} from '@/types/thermal';
import { ReportShell, type PreviewEditResult } from './ReportShell';
import { routeAssetNoteEdit } from './ThermalReportBuilder';
import { HeaderSection } from './sections/HeaderSection';
import { FlightDataSection } from './sections/FlightDataSection';
import { OrthomosaicSection } from './sections/OrthomosaicSection';
import { PhotogrammetryFiguresSection } from './sections/PhotogrammetryFiguresSection';
import { DeliverablesSection } from './sections/DeliverablesSection';
import { FindingsActions, FindingsSection } from './sections/FindingsSection';
import { makeTextSection } from './sections/TextSection';
import { inputCls, labelCls, type ReportSectionDef, type SectionAi, type SectionProps } from './types';

function PhotogrammetryHeader(p: SectionProps<PhotogrammetryReport>) {
  return (
    <HeaderSection
      {...p}
      labels={PHOTOGRAMMETRY_HEADER_LABELS}
      summaryPlaceholder="Deliverables produced, coverage, overall site condition…"
    >
      <div className="col-span-2">
        <label className={labelCls}>Project name</label>
        <input
          className={inputCls}
          value={p.report.projectName}
          onChange={(e) => p.update({ projectName: e.target.value })}
          placeholder="Riverside warehouse roof survey — Phase 2"
        />
      </div>
    </HeaderSection>
  );
}

function PhotogrammetryOutputs(p: SectionProps<PhotogrammetryReport>) {
  return (
    <OrthomosaicSection
      {...p}
      importHint="Import your Metashape deliverables (orthomosaic GeoTIFFs, processing reports, camera files, point clouds) into the Photogrammetry library to embed the orthomosaic here and list the deliverables in the report."
    >
      <DeliverablesSection {...p} />
    </OrthomosaicSection>
  );
}

const PHOTOGRAMMETRY_SECTIONS: ReportSectionDef<PhotogrammetryReport>[] = [
  { key: 'header', title: 'Header Data', Component: PhotogrammetryHeader },
  {
    key: 'scope',
    title: 'Survey Scope',
    Component: makeTextSection<PhotogrammetryReport>('surveyPurpose', {
      minHeight: 64,
      placeholder: 'Objective, area of interest, required accuracy, deliverables requested…',
    }),
  },
  { key: 'flights', title: 'Flight Data (DJI)', Component: FlightDataSection },
  { key: 'ortho', title: 'Photogrammetry Outputs (Agisoft Metashape)', Component: PhotogrammetryOutputs },
  {
    key: 'processing',
    title: 'Processing Notes',
    Component: makeTextSection<PhotogrammetryReport>('processingNotes', {
      minHeight: 64,
      placeholder: 'Metashape 2.x · 412 images aligned (98%) · GSD 1.2 cm/px · 6 GCPs, RMSE 2.1 cm · CRS EPSG:6471',
    }),
  },
  { key: 'figures', title: 'Survey Imagery', Component: PhotogrammetryFiguresSection },
  { key: 'findings', title: 'Findings & Observations', Component: FindingsSection, Actions: FindingsActions },
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

/** Adds the AI drafting definitions; deliverable names need the asset list. */
function withAi(sections: ReportSectionDef<PhotogrammetryReport>[], assets: ThermalAsset[]) {
  const deliverableFacts = (r: PhotogrammetryReport) =>
    metashapeOutputs(assets, r.outputAssetIds).map((o) => ({ file: o.fileName, kind: o.kindLabel, details: o.details || undefined }));
  const siteFacts = (r: PhotogrammetryReport) => ({
    projectName: r.projectName || undefined,
    siteAddress: r.propertyAddress,
    surveyDate: r.inspectionDate,
    weatherConditions: r.weatherConditions,
    operator: r.inspectorName,
  });
  const ai: Record<string, SectionAi<PhotogrammetryReport>> = {
    header: {
      instruction: () =>
        'Write the Summary of this photogrammetry survey report: one or two short paragraphs covering the project and site, the method (UAV photogrammetry processed in Agisoft Metashape), the deliverables produced, and the overall condition found, mentioning the number of findings by severity. Do not list every finding.',
      facts: (r) => ({
        ...siteFacts(r),
        surveyScopeNotes: r.surveyPurpose || undefined,
        existingSummaryNotes: r.summary || undefined,
        flights: flightFacts(r),
        deliverables: deliverableFacts(r),
        figures: figureFacts(r),
        findings: findingFacts(r),
        observations: observationFacts(r),
      }),
      apply: (_r, reply) => ({ summary: reply }),
      snapshot: (r) => ({ summary: r.summary }),
    },
    scope: {
      instruction: () =>
        'Write the Survey Scope section: the objective, the area of interest, the method (UAV photogrammetry, Agisoft Metashape processing) and the deliverables requested or produced. One or two short paragraphs.',
      facts: (r) => ({
        ...siteFacts(r),
        existingScopeNotes: r.surveyPurpose || undefined,
        summaryNotes: r.summary || undefined,
        flights: flightFacts(r),
        deliverables: deliverableFacts(r),
        figures: figureFacts(r),
      }),
      apply: (_r, reply) => ({ surveyPurpose: reply }),
      snapshot: (r) => ({ surveyPurpose: r.surveyPurpose }),
    },
    processing: {
      instruction: () =>
        'Write the Processing Notes: the imagery captured (counts and dates where given), the products generated and their characteristics (dimensions, bands, coordinate system, camera and marker counts), and any accuracy information given. Where a value such as GSD or RMSE is not in the facts, do not invent it — say it was not recorded. One short paragraph or a few compact sentences.',
      facts: (r) => ({
        existingProcessingNotes: r.processingNotes || undefined,
        flights: flightFacts(r),
        deliverables: deliverableFacts(r),
      }),
      apply: (_r, reply) => ({ processingNotes: reply }),
      snapshot: (r) => ({ processingNotes: r.processingNotes }),
    },
    findings: {
      instruction: () =>
        'For each finding write "observation" (one to three sentences describing what the imagery shows at that location and what it indicates, consistent with the category and severity) and "recommendation" (a specific follow-up or corrective action). For each observation entry write "text" (one to two neutral sentences recording what was seen — no defect grading). Keep the intent of any existing text. Return ONLY JSON: {"findings": [{"id", "observation", "recommendation"}], "observations": [{"id", "text"}]} using the given ids — no other text.',
      facts: (r) => ({ findings: findingFacts(r), observations: observationFacts(r), figures: figureFacts(r) }),
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
        'Write the Conclusions & Recommendations section: the overall condition of the site, the priority items by severity, and the recommended follow-up actions and re-survey interval. One or two short paragraphs; refer to findings by their ids.',
      facts: (r) => ({
        summaryNotes: r.summary || undefined,
        scopeNotes: r.surveyPurpose || undefined,
        existingConclusionNotes: r.conclusions || undefined,
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

/** Stored JSON → current shape; the figure list lives in the queue store. */
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
