/**
 * Photogrammetry survey report workflow: sections, export composition and
 * the report-kind hooks for the shared shell. The figure list is the
 * Photogrammetry tab's queue (shared store): saving snapshots it into the
 * report, loading a saved report restores it.
 *
 * To add a component to this report, add a field to PhotogrammetryReport, a
 * section definition below, and its renderer in
 * src/lib/reports/photogrammetryReport.ts.
 */

import { useCallback } from 'react';
import { useThermalStore } from '@/stores/thermalStore';
import { sanitizeQueueEntries, usePhotogrammetryStore } from '@/stores/photogrammetryStore';
import { buildPhotogrammetryFigures } from '@/lib/photogrammetryExport';
import { PHOTOGRAMMETRY_HEADER_LABELS } from '@/lib/reports/common';
import { collectOrthoExtras } from '@/lib/reports/extras';
import {
  buildPhotogrammetryReportPdf,
  buildPhotogrammetryReportRtf,
  type MetashapeOutputSummary,
  type PhotogrammetryReportExtras,
} from '@/lib/reports/photogrammetryReport';
import {
  EMPTY_PHOTOGRAMMETRY_REPORT,
  METASHAPE_KIND_LABELS,
  parseMetashapeMeta,
  type PhotogrammetryReport,
  type ThermalAsset,
} from '@/types/thermal';
import { ReportShell } from './ReportShell';
import { HeaderSection } from './sections/HeaderSection';
import { FlightDataSection } from './sections/FlightDataSection';
import { OrthomosaicSection } from './sections/OrthomosaicSection';
import { PhotogrammetryFiguresSection } from './sections/PhotogrammetryFiguresSection';
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
  { key: 'ortho', title: 'Photogrammetry Outputs (Agisoft Metashape)', Component: OrthomosaicSection },
  {
    key: 'processing',
    title: 'Processing Notes',
    Component: makeTextSection<PhotogrammetryReport>('processingNotes', {
      minHeight: 64,
      hint: 'Imported Metashape deliverables (orthomosaics, reports, camera files, point clouds) are listed automatically in the exported report.',
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
  return {
    ...EMPTY_PHOTOGRAMMETRY_REPORT,
    ...(parsed as Partial<PhotogrammetryReport>),
    kind: 'photogrammetry',
    figures: [],
  };
}

function metashapeOutputs(assets: ThermalAsset[]): MetashapeOutputSummary[] {
  return assets
    .filter((a) => a.source === 'metashape')
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

interface Props {
  onClose: () => void;
}

export function PhotogrammetryReportBuilder({ onClose }: Props) {
  const assets = useThermalStore((s) => s.assets);
  const { queue, setQueue } = usePhotogrammetryStore();

  const collectExtras = useCallback(
    async (report: PhotogrammetryReport): Promise<PhotogrammetryReportExtras> => {
      // Debounced annotation edits from the Photogrammetry tab must be in the
      // DB before the figures are composed from it.
      await usePhotogrammetryStore.getState().flushAnnotations();
      return {
        ...(await collectOrthoExtras(report.orthoAssetId, assets)),
        figures: await buildPhotogrammetryFigures(report.figures, assets),
        metashapeOutputs: metashapeOutputs(assets),
      };
    },
    [assets],
  );

  const buildPdf = useCallback(
    async (report: PhotogrammetryReport) =>
      buildPhotogrammetryReportPdf(report, await collectExtras(report)),
    [collectExtras],
  );
  const buildRtf = useCallback(
    async (report: PhotogrammetryReport) =>
      buildPhotogrammetryReportRtf(report, await collectExtras(report)),
    [collectExtras],
  );

  // The queue store is canonical for figures: snapshot it on save/export and
  // restore it from a loaded report (reports predating figures leave it alone).
  const serialize = useCallback((report: PhotogrammetryReport) => ({ ...report, figures: queue }), [queue]);
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

  const referencedAssetIds = useCallback(
    (report: PhotogrammetryReport): number[] => {
      const ids = new Set<number>();
      for (const f of report.figures) ids.add(f.assetId);
      if (report.orthoAssetId != null) ids.add(report.orthoAssetId);
      for (const a of assets) {
        if (a.source === 'metashape') ids.add(a.id);
      }
      return [...ids];
    },
    [assets],
  );

  return (
    <ReportShell<PhotogrammetryReport>
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
      buildPdf={buildPdf}
      buildRtf={buildRtf}
      onNewBlank={onNewBlank}
      onClose={onClose}
    />
  );
}
