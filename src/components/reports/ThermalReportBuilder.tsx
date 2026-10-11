/**
 * Thermal inspection report workflow: sections, export composition and the
 * report-kind hooks for the shared shell. To add a component to this report,
 * add a field to ThermalReport, a section definition below, and its renderer
 * in src/lib/reports/thermalReport.ts.
 */

import React, { useCallback } from 'react';
import { useThermalStore } from '@/stores/thermalStore';
import { THERMAL_HEADER_LABELS } from '@/lib/reports/common';
import { collectOrthoExtras, readAssetDataUrl } from '@/lib/reports/extras';
import {
  buildThermalReportPdf,
  buildThermalReportRtf,
  type ReportImages,
} from '@/lib/reports/thermalReport';
import { EMPTY_THERMAL_REPORT, type ThermalReport } from '@/types/thermal';
import { ReportShell } from './ReportShell';
import { HeaderSection } from './sections/HeaderSection';
import { FlightDataSection } from './sections/FlightDataSection';
import { OrthomosaicSection } from './sections/OrthomosaicSection';
import { ThermalImagingActions, ThermalImagingSection } from './sections/ThermalImagingSection';
import { AnomaliesActions, AnomaliesSection } from './sections/AnomaliesSection';
import { makeTextSection } from './sections/TextSection';
import type { ReportSectionDef, SectionProps } from './types';

const THERMAL_SECTIONS: ReportSectionDef<ThermalReport>[] = [
  {
    key: 'header',
    title: 'Header Data',
    Component: (p: SectionProps<ThermalReport>) => <HeaderSection {...p} labels={THERMAL_HEADER_LABELS} />,
  },
  { key: 'flights', title: 'Flight Data (DJI)', Component: FlightDataSection },
  { key: 'ortho', title: 'Orthomosaic (Agisoft Metashape)', Component: OrthomosaicSection },
  {
    key: 'imaging',
    title: 'Thermal Imaging Log / Comparative Matrix',
    Component: ThermalImagingSection,
    Actions: ThermalImagingActions,
  },
  { key: 'anomalies', title: 'Anomalies & Findings', Component: AnomaliesSection, Actions: AnomaliesActions },
  {
    key: 'actionPlan',
    title: 'Action Plan & Repair Prioritization',
    Component: makeTextSection<ThermalReport>('actionPlan', {
      placeholder:
        '1. (High) Repair active moisture intrusion at A-01 …\n2. (Medium) Re-insulate void at A-02 …\n3. Energy-saving upgrades: …',
    }),
  },
];

function emptyThermalReport(): ThermalReport {
  return { ...EMPTY_THERMAL_REPORT, inspectionDate: new Date().toISOString().slice(0, 10) };
}

/** Stored JSON → current shape. Reports saved before the workflows were split
 *  may carry a `photogrammetry` figure list; it belongs to the other kind. */
function normalizeThermal(parsed: Record<string, unknown>): ThermalReport {
  const { photogrammetry: _legacyFigures, ...rest } = parsed;
  void _legacyFigures;
  return { ...EMPTY_THERMAL_REPORT, ...(rest as Partial<ThermalReport>), kind: 'thermal' };
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

  const collectImages = useCallback(
    async (report: ThermalReport): Promise<ReportImages> => {
      const images: ReportImages = {};
      for (const entry of report.imagingLog) {
        images[entry.id] = {
          thermal: await assetToDataUrl(entry.thermalAssetId),
          visual: await assetToDataUrl(entry.visualAssetId),
        };
      }
      return images;
    },
    [assetToDataUrl],
  );

  const buildPdf = useCallback(
    async (report: ThermalReport) =>
      buildThermalReportPdf(
        report,
        await collectImages(report),
        await collectOrthoExtras(report.orthoAssetId, assets),
      ),
    [collectImages, assets],
  );

  const buildRtf = useCallback(
    async (report: ThermalReport) =>
      buildThermalReportRtf(
        report,
        await collectImages(report),
        await collectOrthoExtras(report.orthoAssetId, assets),
      ),
    [collectImages, assets],
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
    <ReportShell<ThermalReport>
      kind="thermal"
      title="Thermal Inspection Report"
      icon="🌡️"
      defaultName="Inspection Report"
      empty={emptyThermalReport}
      sections={THERMAL_SECTIONS}
      normalize={normalizeThermal}
      serialize={(r) => r}
      referencedAssetIds={referencedAssetIds}
      buildPdf={buildPdf}
      buildRtf={buildRtf}
      onClose={onClose}
    />
  );
}
