/**
 * Photogrammetry survey report, rendered once against ReportWriter (PDF,
 * Word, RTF and the editable preview all come from this).
 *
 * Sections: Header Data · Survey Scope & Summary · Flight Operations ·
 * Photogrammetry Outputs (Agisoft Metashape) · Survey Imagery · Findings &
 * Observations · Conclusions & Recommendations.
 */

import { PHOTO_FINDING_CATEGORIES } from '@/types/thermal';
import type { PhotogrammetryReport } from '@/types/thermal';
import type { PhotogrammetryFigure } from '@/lib/photogrammetryExport';
import {
  PHOTOGRAMMETRY_HEADER_LABELS,
  SEVERITY_LABELS,
  edit,
  figuresSection,
  flightOperations,
  generatedBy,
  hasOrthoContent,
  headerData,
  orthoBody,
  prioritySummary,
  type OrthoExtras,
} from './common';
import type { ReportWriter } from './writer';

/** One imported Metashape deliverable listed in the outputs section. */
export interface MetashapeOutputSummary {
  fileName: string;
  kindLabel: string;
  details: string;
}

export interface PhotogrammetryPrepared extends OrthoExtras {
  /** Composed figures (images, provenance, notes) keyed by entry id. */
  figures: PhotogrammetryFigure[];
  /** The Metashape deliverables selected for this report. */
  metashapeOutputs: MetashapeOutputSummary[];
}

/** "Figure 3" for a finding's linked figure, or '—'. */
function figureRef(report: PhotogrammetryReport, figureId: string | null): string {
  if (!figureId) return '—';
  const idx = report.figures.findIndex((f) => f.id === figureId);
  return idx < 0 ? '—' : `Figure ${idx + 1}`;
}

function hasOutputsContent(report: PhotogrammetryReport, p: PhotogrammetryPrepared): boolean {
  return (
    hasOrthoContent(p, report.orthomosaicLink) ||
    !!report.processingNotes.trim() ||
    p.metashapeOutputs.length > 0
  );
}

export function renderPhotogrammetryReport(
  w: ReportWriter,
  report: PhotogrammetryReport,
  p: PhotogrammetryPrepared,
): void {
  w.title('Photogrammetry Survey Report', generatedBy('Agisoft Metashape workflow'));
  headerData(
    w,
    report,
    PHOTOGRAMMETRY_HEADER_LABELS,
    report.projectName.trim() || w.editable ? [['Project', report.projectName, edit('projectName', true)]] : [],
  );

  if (report.surveyPurpose.trim() || report.summary.trim() || w.editable) {
    w.sectionHeading('Survey Scope & Summary');
    w.paragraph(report.surveyPurpose, {
      edit: edit('surveyPurpose'),
      hint: 'Objective, area of interest, required accuracy, deliverables requested…',
    });
    w.paragraph(report.summary, {
      edit: edit('summary'),
      hint: 'Deliverables produced, coverage, overall site condition…',
    });
  }

  flightOperations(w, report.linkedFlights ?? []);

  if (hasOutputsContent(report, p) || w.editable) {
    w.sectionHeading('Photogrammetry Outputs (Agisoft Metashape)');
    orthoBody(w, p, report.orthomosaicLink);
    if (report.processingNotes.trim() || w.editable) {
      w.subheading('Processing notes');
      w.paragraph(report.processingNotes, {
        edit: edit('processingNotes'),
        hint: 'Software, alignment, GSD, control points, CRS…',
      });
    }
    if (p.metashapeOutputs.length > 0) {
      w.subheading('Deliverables');
      for (const o of p.metashapeOutputs) {
        w.detail(`${o.fileName} — ${o.kindLabel}${o.details ? ` · ${o.details}` : ''}`);
      }
      w.space(3);
    }
  }

  figuresSection(w, 'Survey Imagery', report.figures, p.figures);

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
      report.findings.map((f, i) => [
        f.refId,
        figureRef(report, f.figureId),
        { text: f.location, edit: edit(`findings.${i}.location`, true) },
        PHOTO_FINDING_CATEGORIES[f.category] ?? f.category,
        SEVERITY_LABELS[f.severity] ?? f.severity,
      ]),
    );
    report.findings.forEach((f, i) => {
      if (!f.observation.trim() && !f.recommendation.trim() && !w.editable) return;
      w.boldLine(`${f.refId} — ${PHOTO_FINDING_CATEGORIES[f.category] ?? f.category}`);
      w.paragraph(f.observation, { edit: edit(`findings.${i}.observation`), hint: 'Describe the observation…', size: 9 });
      if (f.recommendation.trim() || w.editable) {
        w.boldLine('Recommendation:');
        w.paragraph(f.recommendation, {
          edit: edit(`findings.${i}.recommendation`),
          hint: 'Recommended follow-up…',
          size: 9,
        });
      }
    });
  }

  // ---- Conclusions ----
  w.sectionHeading('Conclusions & Recommendations');
  w.paragraph(report.conclusions, { edit: edit('conclusions'), placeholder: 'No conclusions recorded.' });
  if (report.findings.length > 0) {
    w.paragraph(prioritySummary(report.findings.map((f) => f.severity)), { size: 9 });
  }

  w.footers(report.propertyAddress.trim() || report.projectName);
}
