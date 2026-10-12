/**
 * Photogrammetry survey report export (PDF + RTF).
 *
 * Sections: Header Data · Survey Scope & Summary · Flight Operations ·
 * Photogrammetry Outputs (Agisoft Metashape) · Survey Imagery · Findings &
 * Observations · Conclusions & Recommendations. Shared sections come from
 * ./common; the outputs summary and findings are specific to this kind.
 */

import { PHOTO_FINDING_CATEGORIES } from '@/types/thermal';
import type { PhotogrammetryReport } from '@/types/thermal';
import type { PhotogrammetryFigure } from '@/lib/photogrammetryExport';
import { createPdfWriter } from './pdfWriter';
import { RtfWriter } from './rtfWriter';
import {
  PHOTOGRAMMETRY_HEADER_LABELS,
  SEVERITY_LABELS,
  generatedBy,
  hasOrthoContent,
  pdfFigures,
  pdfFlightOperations,
  pdfHeaderData,
  pdfOrthoBody,
  prioritySummary,
  rtfFigures,
  rtfFlightOperations,
  rtfHeaderData,
  rtfOrthoBody,
  type OrthoExtras,
} from './common';

/** One imported Metashape deliverable listed in the outputs section. */
export interface MetashapeOutputSummary {
  fileName: string;
  kindLabel: string;
  details: string;
}

export interface PhotogrammetryReportExtras extends OrthoExtras {
  /** Composed figures in report order. */
  figures: PhotogrammetryFigure[];
  /** Imported Metashape deliverables (orthomosaics, reports, point clouds…). */
  metashapeOutputs: MetashapeOutputSummary[];
}

const SUBTITLE = generatedBy('Agisoft Metashape workflow');

/** "Figure 3" for a finding's linked figure, or '—'. */
function figureRef(report: PhotogrammetryReport, figureId: string | null): string {
  if (!figureId) return '—';
  const idx = report.figures.findIndex((f) => f.id === figureId);
  return idx < 0 ? '—' : `Figure ${idx + 1}`;
}

function hasOutputsContent(report: PhotogrammetryReport, extras: PhotogrammetryReportExtras): boolean {
  return (
    hasOrthoContent(extras, report.orthomosaicLink) ||
    !!report.processingNotes.trim() ||
    extras.metashapeOutputs.length > 0
  );
}

export async function buildPhotogrammetryReportPdf(
  report: PhotogrammetryReport,
  extras: PhotogrammetryReportExtras,
): Promise<Uint8Array> {
  const w = await createPdfWriter();
  const { doc } = w;

  w.title('Photogrammetry Survey Report', SUBTITLE);
  pdfHeaderData(
    w,
    report,
    PHOTOGRAMMETRY_HEADER_LABELS,
    report.projectName.trim() ? [['Project', report.projectName]] : [],
  );

  if (report.surveyPurpose.trim() || report.summary.trim()) {
    w.sectionHeading('Survey Scope & Summary');
    w.paragraph(report.surveyPurpose);
    w.paragraph(report.summary);
  }

  pdfFlightOperations(w, report.linkedFlights ?? []);

  if (hasOutputsContent(report, extras)) {
    w.sectionHeading('Photogrammetry Outputs (Agisoft Metashape)');
    pdfOrthoBody(w, extras, report.orthomosaicLink);
    if (report.processingNotes.trim()) {
      w.subheading('Processing notes');
      w.paragraph(report.processingNotes);
    }
    if (extras.metashapeOutputs.length > 0) {
      w.subheading('Imported deliverables');
      for (const o of extras.metashapeOutputs) {
        w.lines(`${o.fileName} — ${o.kindLabel}${o.details ? ` · ${o.details}` : ''}`, 8.5, 4.2);
      }
      w.y += 3;
    }
  }

  pdfFigures(w, extras.figures, 'Survey Imagery');

  // ---- Findings ----
  w.sectionHeading('Findings & Observations');
  if (report.findings.length === 0) {
    w.paragraph('No findings recorded.');
  } else {
    // Observations and recommendations follow as detail paragraphs, so the
    // table stays an index (like the thermal anomaly log)
    w.table(
      [
        { label: 'ID', w: 14 },
        { label: 'Figure', w: 18 },
        { label: 'Location', w: 70 },
        { label: 'Category', w: 56 },
        { label: 'Severity', w: 20 },
      ],
      report.findings.map((f) => [
        f.refId,
        figureRef(report, f.figureId),
        f.location,
        PHOTO_FINDING_CATEGORIES[f.category] ?? f.category,
        SEVERITY_LABELS[f.severity] ?? f.severity,
      ]),
    );
    for (const f of report.findings) {
      if (!f.observation.trim() && !f.recommendation.trim()) continue;
      w.checkPage(14);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.text(`${f.refId} — ${PHOTO_FINDING_CATEGORIES[f.category] ?? f.category}`, w.margin, w.y);
      w.y += 4.5;
      if (f.observation.trim()) w.paragraph(f.observation, 9);
      if (f.recommendation.trim()) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        w.checkPage(6);
        doc.text('Recommendation:', w.margin, w.y);
        w.y += 4.5;
        w.paragraph(f.recommendation, 9);
      }
    }
  }

  // ---- Conclusions ----
  w.sectionHeading('Conclusions & Recommendations');
  w.paragraph(report.conclusions.trim() || 'No conclusions recorded.');
  if (report.findings.length > 0) {
    w.paragraph(prioritySummary(report.findings.map((f) => f.severity)), 9);
  }

  w.footers(report.propertyAddress.trim() || report.projectName);
  return w.bytes();
}

export function buildPhotogrammetryReportRtf(
  report: PhotogrammetryReport,
  extras: PhotogrammetryReportExtras,
): string {
  const w = new RtfWriter();
  w.title('Photogrammetry Survey Report', SUBTITLE);
  rtfHeaderData(
    w,
    report,
    PHOTOGRAMMETRY_HEADER_LABELS,
    report.projectName.trim() ? [['Project', report.projectName]] : [],
  );

  if (report.surveyPurpose.trim() || report.summary.trim()) {
    w.sectionHeading('Survey Scope & Summary');
    w.para(report.surveyPurpose);
    w.para(report.summary);
  }

  rtfFlightOperations(w, report.linkedFlights ?? []);

  if (hasOutputsContent(report, extras)) {
    w.sectionHeading('Photogrammetry Outputs (Agisoft Metashape)');
    rtfOrthoBody(w, extras, report.orthomosaicLink);
    if (report.processingNotes.trim()) {
      w.sub('Processing notes');
      w.para(report.processingNotes);
    }
    if (extras.metashapeOutputs.length > 0) {
      w.sub('Imported deliverables');
      for (const o of extras.metashapeOutputs) {
        w.kv(o.fileName, `${o.kindLabel}${o.details ? ` · ${o.details}` : ''}`);
      }
    }
  }

  rtfFigures(w, extras.figures, 'Survey Imagery');

  w.sectionHeading('Findings & Observations');
  if (report.findings.length === 0) {
    w.para('No findings recorded.');
  } else {
    for (const f of report.findings) {
      w.sub(`${f.refId} — ${SEVERITY_LABELS[f.severity] ?? f.severity} severity`);
      w.kv('Figure', figureRef(report, f.figureId));
      w.kv('Location', f.location || '—');
      w.kv('Category', PHOTO_FINDING_CATEGORIES[f.category] ?? f.category);
      if (f.observation.trim()) w.kv('Observation', f.observation);
      if (f.recommendation.trim()) w.kv('Recommendation', f.recommendation);
    }
  }

  w.sectionHeading('Conclusions & Recommendations');
  w.para(report.conclusions.trim() || 'No conclusions recorded.');
  if (report.findings.length > 0) {
    w.para(prioritySummary(report.findings.map((f) => f.severity)));
  }

  return w.finish();
}
