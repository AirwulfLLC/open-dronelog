/**
 * Thermal inspection report, rendered once against ReportWriter (PDF, Word,
 * RTF and the editable preview all come from this).
 *
 * Sections: Header Data · Summary · Flight Operations · Orthomosaic ·
 * Thermal Imaging Log & Comparative Matrix · Thermal Anomaly Log · Action
 * Plan & Repair Prioritization.
 */

import { CLASSIFICATION_LABELS } from '@/types/thermal';
import type { ThermalReport } from '@/types/thermal';
import {
  SEVERITY_LABELS,
  THERMAL_HEADER_LABELS,
  assetNoteEdit,
  edit,
  flightOperations,
  fmtGps,
  fmtTemp,
  generatedBy,
  hasOrthoContent,
  headerData,
  orthoBody,
  prioritySummary,
  type OrthoExtras,
} from './common';
import type { ReportWriter } from './writer';

/** A per-picture note attached to one of the pair's assets. */
export interface PairNote {
  assetId: number;
  label: string;
  text: string;
}

export interface ReportImages {
  /** entry.id → data URLs (PNG/JPEG) and the pictures' notes */
  [entryId: string]: { thermal: string | null; visual: string | null; notes: PairNote[] };
}

export interface ThermalPrepared {
  images: ReportImages;
  extras: OrthoExtras;
}

export function renderThermalReport(w: ReportWriter, report: ThermalReport, p: ThermalPrepared): void {
  w.title('Thermal Inspection Report', generatedBy('Thermal inspection workflow'));
  headerData(w, report, THERMAL_HEADER_LABELS);

  if (report.summary.trim() || w.editable) {
    w.sectionHeading('Summary');
    w.paragraph(report.summary, { edit: edit('summary'), hint: 'Scope, methodology and overall condition summary…' });
  }

  flightOperations(w, report.linkedFlights ?? []);

  if (hasOrthoContent(p.extras, report.orthomosaicLink) || w.editable) {
    w.sectionHeading('Orthomosaic (Agisoft Metashape)');
    orthoBody(w, p.extras, report.orthomosaicLink);
  }

  // ---- Imaging log / comparative matrix ----
  w.sectionHeading('Thermal Imaging Log & Comparative Matrix');
  if (report.imagingLog.length === 0) w.paragraph('No imaging entries.');
  report.imagingLog.forEach((entry, i) => {
    const pair = p.images[entry.id] ?? { thermal: null, visual: null, notes: [] };
    w.imagePair({
      index: i + 1,
      caption: entry.caption,
      captionEdit: edit(`imagingLog.${i}.caption`, true),
      leftLabel: 'Visual (Zoom/Wide)',
      leftImage: pair.visual,
      rightLabel: 'Thermal (Infrared)',
      rightImage: pair.thermal,
    });
    if (entry.lrfData.trim() || w.editable) {
      w.kv('LRF / Range Data', entry.lrfData, edit(`imagingLog.${i}.lrfData`, true), { compact: true });
    }
    w.notes(pair.notes.map((n) => ({ label: n.label, text: n.text, edit: assetNoteEdit(n.assetId) })));
    w.space(4);
  });

  // ---- Anomaly log ----
  w.sectionHeading('Thermal Anomaly Log');
  if (report.anomalies.length === 0) {
    w.paragraph('No anomalies recorded.');
  } else {
    w.table(
      [
        { label: 'ID', w: 14 },
        { label: 'Location / Geotag', w: 44 },
        { label: 'T max', w: 18 },
        { label: 'T min', w: 18 },
        { label: 'Baseline', w: 20 },
        // 'dT': jsPDF's built-in WinAnsi fonts cannot encode Δ (U+0394)
        { label: 'dT', w: 10 },
        { label: 'Severity', w: 15 },
        { label: 'Classification', w: 39 },
      ],
      report.anomalies.map((a) => [
        a.refId,
        `${a.location}${a.gpsLat != null ? `\n${fmtGps(a.gpsLat, a.gpsLon)}` : ''}`,
        fmtTemp(a.tMax),
        fmtTemp(a.tMin),
        fmtTemp(a.baseline),
        a.deltaT == null ? '—' : `${a.deltaT > 0 ? '+' : ''}${a.deltaT.toFixed(1)}`,
        SEVERITY_LABELS[a.severity] ?? a.severity,
        CLASSIFICATION_LABELS[a.classification] ?? a.classification,
      ]),
    );
    report.anomalies.forEach((a, i) => {
      if (!a.finding.trim() && !a.recommendation.trim() && !w.editable) return;
      w.boldLine(`${a.refId} — Finding`);
      w.paragraph(a.finding, { edit: edit(`anomalies.${i}.finding`), hint: 'Describe the finding…', size: 9 });
      if (a.recommendation.trim() || w.editable) {
        w.boldLine('Recommendation:');
        w.paragraph(a.recommendation, {
          edit: edit(`anomalies.${i}.recommendation`),
          hint: 'Recommended corrective action…',
          size: 9,
        });
      }
    });
  }

  // ---- Action plan ----
  w.sectionHeading('Action Plan & Repair Prioritization');
  w.paragraph(report.actionPlan, { edit: edit('actionPlan'), placeholder: 'No action plan recorded.' });
  if (report.anomalies.length > 0) {
    w.paragraph(prioritySummary(report.anomalies.map((a) => a.severity)), { size: 9 });
  }

  w.footers(report.propertyAddress);
}
