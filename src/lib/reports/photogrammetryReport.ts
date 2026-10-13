/**
 * Photogrammetry survey report, rendered once against ReportWriter (PDF,
 * Word, RTF and the editable preview all come from this).
 *
 * Sections: Header Data (project metadata) · Survey Scope & Summary ·
 * Environmental Conditions · Hardware, Software & Accuracy · Flight
 * Operations · Core Visual Deliverables · Topographical & Elevation Data ·
 * Survey Imagery · Advanced Analysis & Measurements · Findings &
 * Observations (asset inspection notes) · Conclusions & Recommendations.
 */

import {
  CORE_DELIVERABLE_KINDS,
  DELIVERABLE_KIND_LABELS,
  ELEVATION_DELIVERABLE_KINDS,
  MEASUREMENT_KIND_LABELS,
  PHOTO_FINDING_CATEGORIES,
} from '@/types/thermal';
import type { DeliverableKind, PhotogrammetryReport } from '@/types/thermal';
import type { PhotogrammetryFigure } from '@/lib/photogrammetryExport';
import {
  SEVERITY_LABELS,
  edit,
  figuresSection,
  flightOperations,
  generatedBy,
  hasOrthoContent,
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

/** "Figure 3" for a linked figure, or '—'. */
function figureRef(report: PhotogrammetryReport, figureId: string | null): string {
  if (!figureId) return '—';
  const idx = report.figures.findIndex((f) => f.id === figureId);
  return idx < 0 ? '—' : `Figure ${idx + 1}`;
}

/** A number without trailing zeros ("1.5", "412"). */
const fmtNum = (v: number, dp: number) => String(Number(v.toFixed(dp)));

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

/** The deliverable rows of the given kinds: name and status, specification, where it lives. */
function deliverableRows(w: ReportWriter, report: PhotogrammetryReport, kinds: DeliverableKind[]): void {
  report.deliverables.forEach((d, i) => {
    if (!kinds.includes(d.kind)) return;
    const name = d.kind === 'other' ? d.title.trim() || 'Other deliverable' : DELIVERABLE_KIND_LABELS[d.kind];
    w.boldLine(d.status === 'not_produced' ? `${name} — not produced` : name);
    w.paragraph(d.details, {
      edit: edit(`deliverables.${i}.details`, true),
      hint: 'Resolution, point count, format, extent, CRS…',
      size: 9,
    });
    if (w.editable || isUrl(d.link)) {
      if (d.link.trim() || w.editable) w.link(d.link, edit(`deliverables.${i}.link`, true));
    } else if (d.link.trim()) {
      // Not a web address ("delivered on USB"): plain text, not a hyperlink
      w.detail(`Delivered as: ${d.link}`);
    }
    w.space(2);
  });
}

export function renderPhotogrammetryReport(
  w: ReportWriter,
  report: PhotogrammetryReport,
  p: PhotogrammetryPrepared,
): void {
  const editable = w.editable;
  /** A text row, printed when filled in (always in the preview, where it can be typed into). */
  const kvOpt = (label: string, value: string, path: string) => {
    if (!value.trim() && !editable) return;
    w.kv(label, value, edit(path, true));
  };
  /** A number row — typed in the builder, so not editable in the preview. */
  const kvNum = (label: string, value: number | null, fmt: (v: number) => string) => {
    if (value != null) w.kv(label, fmt(value));
  };

  w.title('Photogrammetry Survey Report', generatedBy('Photogrammetry survey workflow'));

  // ---- Header data: project metadata ----
  w.sectionHeading('Header Data');
  kvOpt('Project', report.projectName, 'projectName');
  kvOpt('Client', report.clientName, 'clientName');
  w.kv('Site / Project Address', report.propertyAddress, edit('propertyAddress', true));
  // The date is an ISO value behind a date picker — free text would break it
  w.kv('Survey Date', report.inspectionDate);
  kvOpt('Flight Time', report.inspectionTime, 'inspectionTime');
  kvOpt('Site Position', report.sitePosition, 'sitePosition');
  w.kv('Pilot / Operator', report.inspectorName, edit('inspectorName', true));
  kvOpt('Pilot Credentials', report.pilotCredentials, 'pilotCredentials');
  kvOpt('Contact', report.pilotContact, 'pilotContact');
  w.space(3);

  // ---- Scope & summary ----
  if (report.surveyPurpose.trim() || report.summary.trim() || editable) {
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

  // ---- Environmental conditions ----
  if (report.weatherConditions.trim() || report.windConditions.trim() || report.lighting.trim() || editable) {
    w.sectionHeading('Environmental Conditions');
    kvOpt('Weather', report.weatherConditions, 'weatherConditions');
    kvOpt('Wind', report.windConditions, 'windConditions');
    kvOpt('Lighting', report.lighting, 'lighting');
    w.space(3);
  }

  // ---- Hardware, software & accuracy ----
  const hasSpecs =
    [report.droneModel, report.droneSerial, report.cameraSensor, report.software, report.crs, report.processingNotes].some(
      (s) => s.trim(),
    ) ||
    [report.imageCount, report.imagesAligned, report.flightAltitudeM, report.gsdCmPx, report.gcpCount, report.rmseCm].some(
      (v) => v != null,
    );
  if (hasSpecs || editable) {
    w.sectionHeading('Hardware, Software & Accuracy');
    kvOpt('Aircraft', report.droneModel, 'droneModel');
    kvOpt('Aircraft Serial Number', report.droneSerial, 'droneSerial');
    kvOpt('Camera / Sensor', report.cameraSensor, 'cameraSensor');
    kvOpt('Processing Software', report.software, 'software');
    kvNum('Images Captured', report.imageCount, (v) => fmtNum(v, 0));
    kvNum('Images Aligned', report.imagesAligned, (v) => fmtNum(v, 0));
    kvNum('Flight Altitude', report.flightAltitudeM, (v) => `${fmtNum(v, 1)} m AGL`);
    kvNum('Ground Sampling Distance (GSD)', report.gsdCmPx, (v) => `${fmtNum(v, 2)} cm / pixel`);
    kvNum('Ground Control Points', report.gcpCount, (v) => fmtNum(v, 0));
    kvNum('RMSE', report.rmseCm, (v) => `${fmtNum(v, 2)} cm`);
    kvOpt('Coordinate Reference System', report.crs, 'crs');
    if (report.processingNotes.trim() || editable) {
      w.subheading('Processing notes');
      w.paragraph(report.processingNotes, {
        edit: edit('processingNotes'),
        hint: 'Alignment, depth maps, dense cloud, mesh and texture settings, control point residuals…',
      });
    }
    w.space(3);
  }

  flightOperations(w, report.linkedFlights ?? []);

  // ---- Core visual deliverables ----
  const coreRows = report.deliverables.filter((d) => CORE_DELIVERABLE_KINDS.includes(d.kind));
  if (hasOrthoContent(p, report.orthomosaicLink) || coreRows.length > 0 || p.metashapeOutputs.length > 0 || editable) {
    w.sectionHeading('Core Visual Deliverables');
    orthoBody(w, p, report.orthomosaicLink);
    deliverableRows(w, report, CORE_DELIVERABLE_KINDS);
    if (p.metashapeOutputs.length > 0) {
      w.subheading('Files delivered');
      for (const o of p.metashapeOutputs) {
        w.detail(`${o.fileName} — ${o.kindLabel}${o.details ? ` · ${o.details}` : ''}`);
      }
      w.space(3);
    }
  }

  // ---- Topographical & elevation data ----
  const elevationRows = report.deliverables.filter((d) => ELEVATION_DELIVERABLE_KINDS.includes(d.kind));
  if (elevationRows.length > 0 || editable) {
    w.sectionHeading('Topographical & Elevation Data');
    if (elevationRows.length === 0) {
      // Only reachable in the preview: the files skip the empty section
      w.smallText('No DEM/DSM, DTM or contour products listed — add them in the builder.');
    } else {
      deliverableRows(w, report, ELEVATION_DELIVERABLE_KINDS);
    }
  }

  figuresSection(w, 'Survey Imagery', report.figures, p.figures);

  // ---- Advanced analysis & measurements ----
  if (report.measurements.length > 0 || editable) {
    w.sectionHeading('Advanced Analysis & Measurements');
    if (report.measurements.length === 0) {
      w.smallText('No measurements recorded — add volumes, areas, lengths or heights in the builder.');
    } else {
      w.table(
        [
          { label: 'Type', w: 30 },
          { label: 'Feature', w: 56 },
          { label: 'Value', w: 30 },
          { label: 'Method / Remarks', w: 44 },
          { label: 'Figure', w: 18 },
        ],
        report.measurements.map((m, i) => [
          MEASUREMENT_KIND_LABELS[m.kind] ?? m.kind,
          { text: m.feature, edit: edit(`measurements.${i}.feature`, true) },
          m.value == null ? '—' : `${fmtNum(m.value, 2)}${m.unit.trim() ? ` ${m.unit.trim()}` : ''}`,
          { text: m.method, edit: edit(`measurements.${i}.method`, true) },
          figureRef(report, m.figureId),
        ]),
      );
    }
  }

  // ---- Findings (asset inspection notes) ----
  w.sectionHeading('Findings & Observations (Asset Inspection Notes)');
  if (report.findings.length === 0 && report.observations.length === 0) {
    w.paragraph('No findings or observations recorded.');
  }
  if (report.findings.length > 0) {
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
      if (!f.observation.trim() && !f.recommendation.trim() && !editable) return;
      w.boldLine(`${f.refId} — ${PHOTO_FINDING_CATEGORIES[f.category] ?? f.category}`);
      w.paragraph(f.observation, { edit: edit(`findings.${i}.observation`), hint: 'Describe the observation…', size: 9 });
      if (f.recommendation.trim() || editable) {
        w.boldLine('Recommendation:');
        w.paragraph(f.recommendation, {
          edit: edit(`findings.${i}.recommendation`),
          hint: 'Recommended follow-up…',
          size: 9,
        });
      }
    });
  }

  // ---- Observations (neutral notes, no grade) ----
  if (report.observations.length > 0) {
    w.subheading('Observations');
    w.table(
      [
        { label: 'ID', w: 14 },
        { label: 'Figure', w: 18 },
        { label: 'Location', w: 146 },
      ],
      report.observations.map((o, i) => [
        o.refId,
        figureRef(report, o.figureId),
        { text: o.location, edit: edit(`observations.${i}.location`, true) },
      ]),
    );
    report.observations.forEach((o, i) => {
      if (!o.text.trim() && !editable) return;
      w.boldLine(`${o.refId} — Observation`);
      w.paragraph(o.text, { edit: edit(`observations.${i}.text`), hint: 'What the imagery showed…', size: 9 });
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
