/**
 * Thermal inspection report export (PDF + RTF).
 *
 * Sections: Header Data · Summary · Flight Operations · Orthomosaic ·
 * Thermal Imaging Log & Comparative Matrix · Thermal Anomaly Log · Action
 * Plan & Repair Prioritization. Shared sections come from ./common; the
 * imaging log and anomaly log are specific to this kind.
 */

import { CLASSIFICATION_LABELS } from '@/types/thermal';
import type { ReportImageEntry, ThermalReport } from '@/types/thermal';
import { createPdfWriter } from './pdfWriter';
import { RtfWriter, dataUrlToRtfPict } from './rtfWriter';
import {
  SEVERITY_LABELS,
  THERMAL_HEADER_LABELS,
  fmtGps,
  fmtTemp,
  generatedBy,
  hasOrthoContent,
  pdfFlightOperations,
  pdfHeaderData,
  pdfOrthoBody,
  prioritySummary,
  rtfFlightOperations,
  rtfHeaderData,
  rtfOrthoBody,
  type OrthoExtras,
} from './common';

export interface ReportImages {
  /** entry.id → { thermal, visual } data URLs (PNG/JPEG) */
  [entryId: string]: { thermal: string | null; visual: string | null };
}

export type ThermalReportExtras = OrthoExtras;

const SUBTITLE = generatedBy('DJI Thermal SDK');

export async function buildThermalReportPdf(
  report: ThermalReport,
  images: ReportImages,
  extras: ThermalReportExtras = {},
): Promise<Uint8Array> {
  const w = await createPdfWriter();
  const { doc } = w;

  w.title('Thermal Inspection Report', SUBTITLE);
  pdfHeaderData(w, report, THERMAL_HEADER_LABELS);

  if (report.summary.trim()) {
    w.sectionHeading('Summary');
    w.paragraph(report.summary);
  }

  pdfFlightOperations(w, report.linkedFlights ?? []);

  if (hasOrthoContent(extras, report.orthomosaicLink)) {
    w.sectionHeading('Orthomosaic (Agisoft Metashape)');
    pdfOrthoBody(w, extras, report.orthomosaicLink);
  }

  // ---- Imaging log / comparative matrix ----
  w.sectionHeading('Thermal Imaging Log & Comparative Matrix');
  if (report.imagingLog.length === 0) {
    w.paragraph('No imaging entries.');
  }
  for (let i = 0; i < report.imagingLog.length; i++) {
    const entry = report.imagingLog[i];
    const imgPair = images[entry.id] ?? { thermal: null, visual: null };
    const colW = (w.contentW - 6) / 2;
    const imgH = colW * 0.75;

    const pairTitle = `${i + 1}. ${entry.caption || 'Imaging pair'}`;
    w.checkPage(imgH + 21 + w.lineCount(pairTitle, 10, true) * 5);
    w.subheading(pairTitle);

    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(110, 110, 110);
    doc.text('Visual (Zoom/Wide)', w.margin, w.y);
    doc.text('Thermal (Infrared)', w.margin + colW + 6, w.y);
    doc.setTextColor(0, 0, 0);
    w.y += 2;

    const drawImg = (dataUrl: string | null, x: number) => {
      if (!dataUrl || !w.image(dataUrl, x, w.y, colW, imgH)) {
        w.placeholder(x, w.y, colW, imgH, 'No image');
      }
    };
    drawImg(imgPair.visual, w.margin);
    drawImg(imgPair.thermal, w.margin + colW + 6);
    w.y += imgH + 4;

    if (entry.lrfData.trim()) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.text('LRF / Range Data: ', w.margin, w.y);
      doc.setFont('helvetica', 'normal');
      const lines = doc.splitTextToSize(entry.lrfData, w.contentW - 30) as string[];
      doc.text(lines, w.margin + 30, w.y);
      w.y += Math.max(4, lines.length * 4);
    }
    w.y += 4;
  }

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

    // Findings detail
    for (const a of report.anomalies) {
      if (!a.finding.trim() && !a.recommendation.trim()) continue;
      w.checkPage(14);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.text(`${a.refId} — Finding`, w.margin, w.y);
      w.y += 4.5;
      if (a.finding.trim()) w.paragraph(a.finding, 9);
      if (a.recommendation.trim()) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        w.checkPage(6);
        doc.text('Recommendation:', w.margin, w.y);
        w.y += 4.5;
        w.paragraph(a.recommendation, 9);
      }
    }
  }

  // ---- Action plan ----
  w.sectionHeading('Action Plan & Repair Prioritization');
  w.paragraph(report.actionPlan.trim() || 'No action plan recorded.');
  if (report.anomalies.length > 0) {
    w.paragraph(prioritySummary(report.anomalies.map((a) => a.severity)), 9);
  }

  w.footers(report.propertyAddress);
  return w.bytes();
}

export function buildThermalReportRtf(
  report: ThermalReport,
  images: ReportImages,
  extras: ThermalReportExtras = {},
): string {
  const w = new RtfWriter();
  w.title('Thermal Inspection Report', SUBTITLE);
  rtfHeaderData(w, report, THERMAL_HEADER_LABELS);

  if (report.summary.trim()) {
    w.sectionHeading('Summary');
    w.para(report.summary);
  }

  rtfFlightOperations(w, report.linkedFlights ?? []);

  if (hasOrthoContent(extras, report.orthomosaicLink)) {
    w.sectionHeading('Orthomosaic (Agisoft Metashape)');
    rtfOrthoBody(w, extras, report.orthomosaicLink);
  }

  w.sectionHeading('Thermal Imaging Log & Comparative Matrix');
  if (report.imagingLog.length === 0) w.para('No imaging entries.');
  report.imagingLog.forEach((entry: ReportImageEntry, i: number) => {
    w.sub(`${i + 1}. ${entry.caption || 'Imaging pair'}`);
    const pair = images[entry.id] ?? { thermal: null, visual: null };
    // ~7.5cm wide each (4252 twips), 4:3
    const pw = 4252;
    const ph = 3189;
    const visual = pair.visual ? dataUrlToRtfPict(pair.visual, pw, ph) : '(no visual image)';
    const thermal = pair.thermal ? dataUrlToRtfPict(pair.thermal, pw, ph) : '(no thermal image)';
    w.raw(`{\\pard\\sa60\\fs18\\cf3 Visual (Zoom/Wide)\\tab\\tab Thermal (Infrared)\\par}`);
    w.raw(`{\\pard\\sa120 ${visual} ${thermal}\\par}`);
    if (entry.lrfData.trim()) {
      w.kv('LRF / Range Data', entry.lrfData);
    }
  });

  w.sectionHeading('Thermal Anomaly Log');
  if (report.anomalies.length === 0) {
    w.para('No anomalies recorded.');
  } else {
    for (const a of report.anomalies) {
      w.sub(`${a.refId} — ${SEVERITY_LABELS[a.severity] ?? a.severity} severity`);
      w.kv('Location', a.location || '—');
      if (a.gpsLat != null) w.kv('Geotag', fmtGps(a.gpsLat, a.gpsLon));
      w.kv(
        'Temperatures',
        `Tmax ${fmtTemp(a.tMax)} · Tmin ${fmtTemp(a.tMin)} · Baseline ${fmtTemp(a.baseline)}` +
          (a.deltaT != null ? ` · ΔT ${a.deltaT > 0 ? '+' : ''}${a.deltaT.toFixed(1)} °C` : ''),
      );
      w.kv('Classification', CLASSIFICATION_LABELS[a.classification] ?? a.classification);
      if (a.finding.trim()) w.kv('Finding', a.finding);
      if (a.recommendation.trim()) w.kv('Recommendation', a.recommendation);
    }
  }

  w.sectionHeading('Action Plan & Repair Prioritization');
  w.para(report.actionPlan.trim() || 'No action plan recorded.');
  if (report.anomalies.length > 0) {
    w.para(prioritySummary(report.anomalies.map((a) => a.severity)));
  }

  return w.finish();
}
