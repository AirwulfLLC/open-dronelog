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

import { useCallback } from 'react';
import { useThermalStore } from '@/stores/thermalStore';
import { sanitizeQueueEntries, usePhotogrammetryStore } from '@/stores/photogrammetryStore';
import { buildPhotogrammetryFigures } from '@/lib/photogrammetryExport';
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
import { inputCls, labelCls, type ReportSectionDef, type SectionProps } from './types';

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
      empty={emptyPhotogrammetryReport}
      sections={PHOTOGRAMMETRY_SECTIONS}
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
