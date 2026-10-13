/**
 * Thermal inspection report, rendered once against ReportWriter (PDF, Word,
 * RTF and the editable preview all come from this).
 *
 * Sections: Header Data (administrative & metadata) · Executive Summary ·
 * Environmental & System Conditions · Flight Operations · Orthomosaic ·
 * Thermal Imaging Log & Comparative Matrix · Thermal Anomaly Log · Asset
 * Inventory & Exception List · Action Plan & Repair Prioritization ·
 * Follow-Up & Re-inspection · Limitations, Definitions & Disclaimer.
 */

import { CLASSIFICATION_LABELS, INVENTORY_STATUS_LABELS } from '@/types/thermal';
import type { InventoryStatus, ThermalAsset, ThermalReport } from '@/types/thermal';
import {
  SEVERITY_LABELS,
  assetNoteEdit,
  edit,
  flightOperations,
  fmtGps,
  fmtTemp,
  generatedBy,
  hasOrthoContent,
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
  /** entry.id → data URLs (PNG/JPEG), the pictures' notes and provenance line */
  [entryId: string]: {
    thermal: string | null;
    visual: string | null;
    notes: PairNote[];
    /** Picture names (as named in the library), palette and scale, capture time, position. */
    details?: string;
    /** Unit of the thermal picture's values: '°C', or '' for a vegetation index. */
    unit?: string;
  };
}

export interface ThermalPrepared {
  images: ReportImages;
  extras: OrthoExtras;
}

/** Provenance line printed under an imaging pair: the pictures' names as they
 *  read in the library (renames included), the palette and temperature scale
 *  the thermal picture was rendered with, then the capture time and position
 *  of the thermal picture (or the visual one when there is no thermal). */
export function pairDetails(visual: ThermalAsset | null, thermal: ThermalAsset | null, scale?: string): string {
  const shot = thermal ?? visual;
  return [
    visual ? `Visual: ${visual.fileName}` : null,
    thermal ? `Thermal: ${thermal.fileName}` : null,
    scale ?? null,
    shot?.capturedAt ?? null,
    shot && shot.gpsLat != null && shot.gpsLon != null ? fmtGps(shot.gpsLat, shot.gpsLon) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "dT +6.2 °C" — 'dT' rather than Δ: jsPDF's built-in fonts cannot print it.
 *  Vegetation-index deltas are unitless and shown with more precision. */
const fmtDelta = (dT: number | null, unit: string) =>
  dT == null ? null : `dT ${dT > 0 ? '+' : ''}${dT.toFixed(unit ? 1 : 3)}${unit ? ` ${unit}` : ''}`;

/** A number without trailing zeros ("33.3", "5"). */
const fmtNum = (v: number, dp: number) => String(Number(v.toFixed(dp)));

/** The anomalies logged on a pair's thermal picture, with severity and delta-T. */
function anomaliesOnPicture(report: ThermalReport, assetId: number | null, unit: string): string {
  if (assetId == null) return '';
  const linked = report.anomalies.filter((a) => a.assetId === assetId);
  if (linked.length === 0) return '';
  return (
    'Anomalies in this image: ' +
    linked
      .map(
        (a) =>
          `${a.refId} (${[SEVERITY_LABELS[a.severity] ?? a.severity, fmtDelta(a.deltaT, unit)].filter(Boolean).join(', ')})`,
      )
      .join(' · ')
  );
}

export function renderThermalReport(w: ReportWriter, report: ThermalReport, p: ThermalPrepared): void {
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

  w.title('Thermal Inspection Report', generatedBy('Thermal inspection workflow'));

  // ---- Header data: administrative & metadata ----
  w.sectionHeading('Header Data');
  w.kv('Property Address', report.propertyAddress, edit('propertyAddress', true));
  // The date is an ISO value behind a date picker — free text would break it
  w.kv('Inspection Date', report.inspectionDate);
  kvOpt('Inspection Time', report.inspectionTime, 'inspectionTime');
  w.kv('Inspector / Thermographer', report.inspectorName, edit('inspectorName', true));
  kvOpt('Credentials', report.inspectorCredentials, 'inspectorCredentials');
  kvOpt('Contact', report.inspectorContact, 'inspectorContact');
  kvOpt('Camera Make', report.cameraMake, 'cameraMake');
  kvOpt('Camera Model', report.cameraModel, 'cameraModel');
  kvOpt('Camera Serial Number', report.cameraSerial, 'cameraSerial');
  kvOpt('Asset IDs / Tags', report.assetTags, 'assetTags');
  w.space(3);

  // ---- Executive summary ----
  // The severity tally belongs under the summary; without one it goes with
  // the action plan rather than standing alone under an empty heading
  const tally = report.anomalies.length > 0 ? prioritySummary(report.anomalies.map((a) => a.severity)) : null;
  let tallyPrinted = false;
  if (report.summary.trim() || editable) {
    w.sectionHeading('Executive Summary');
    w.paragraph(report.summary, {
      edit: edit('summary'),
      hint: 'Primary discoveries, problem locations and urgency levels…',
    });
    if (tally) {
      w.paragraph(tally, { size: 9 });
      tallyPrinted = true;
    }
  }

  // ---- Environmental & system conditions ----
  const hasConditions =
    report.weatherConditions.trim() ||
    report.loadConditions.trim() ||
    [report.ambientTempC, report.humidityPct, report.emissivity, report.reflectedTempC, report.measurementDistanceM].some(
      (v) => v != null,
    );
  if (hasConditions || editable) {
    w.sectionHeading('Environmental & System Conditions');
    kvOpt('Weather Conditions', report.weatherConditions, 'weatherConditions');
    kvNum('Ambient Temperature', report.ambientTempC, fmtTemp);
    kvNum('Relative Humidity', report.humidityPct, (v) => `${fmtNum(v, 1)}%`);
    kvOpt('System / Load Conditions', report.loadConditions, 'loadConditions');
    kvNum('Emissivity Setting', report.emissivity, (v) => v.toFixed(2));
    kvNum('Reflected (Background) Temperature', report.reflectedTempC, fmtTemp);
    kvNum('Measurement Distance', report.measurementDistanceM, (v) => `${fmtNum(v, 2)} m`);
    w.space(3);
  }

  flightOperations(w, report.linkedFlights ?? []);

  if (hasOrthoContent(p.extras, report.orthomosaicLink) || editable) {
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
      details: pair.details,
    });
    const linked = anomaliesOnPicture(report, entry.thermalAssetId, pair.unit ?? '°C');
    if (linked) w.smallText(linked);
    if (entry.lrfData.trim() || editable) {
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
      if (!a.finding.trim() && !a.recommendation.trim() && !editable) return;
      w.boldLine(`${a.refId} — Finding`);
      w.paragraph(a.finding, { edit: edit(`anomalies.${i}.finding`), hint: 'Describe the finding…', size: 9 });
      if (a.recommendation.trim() || editable) {
        w.boldLine('Recommendation:');
        w.paragraph(a.recommendation, {
          edit: edit(`anomalies.${i}.recommendation`),
          hint: 'Recommended corrective action…',
          size: 9,
        });
      }
    });
  }

  // ---- Asset inventory & exception list ----
  w.sectionHeading('Asset Inventory & Exception List');
  if (report.inventory.length === 0) {
    w.paragraph('No asset inventory recorded.');
  } else {
    w.table(
      [
        { label: 'Asset / Tag', w: 34 },
        { label: 'Description', w: 68 },
        { label: 'Status', w: 36 },
        { label: 'Notes', w: 40 },
      ],
      report.inventory.map((r, i) => [
        { text: r.tag, edit: edit(`inventory.${i}.tag`, true) },
        { text: r.description, edit: edit(`inventory.${i}.description`, true) },
        INVENTORY_STATUS_LABELS[r.status] ?? r.status,
        { text: r.note, edit: edit(`inventory.${i}.note`, true) },
      ]),
    );
    const count = (s: InventoryStatus) => report.inventory.filter((r) => r.status === s).length;
    w.paragraph(
      `${report.inventory.length} item(s) listed: ${count('normal')} normal, ${count('exception')} exception(s), ` +
        `${count('not_inspected')} not inspected or inaccessible.`,
      { size: 9 },
    );
    const missed = report.inventory.filter((r) => r.status === 'not_inspected');
    if (missed.length > 0) {
      w.boldLine('Uninspected assets / inaccessible areas');
      for (const r of missed) {
        w.detail(
          [r.tag, r.description].filter((s) => s.trim()).join(' — ') + (r.note.trim() ? ` (${r.note.trim()})` : ''),
        );
      }
      w.space(3);
    }
  }

  // ---- Action plan ----
  w.sectionHeading('Action Plan & Repair Prioritization');
  w.paragraph(report.actionPlan, { edit: edit('actionPlan'), placeholder: 'No action plan recorded.' });
  if (tally && !tallyPrinted) w.paragraph(tally, { size: 9 });

  // ---- Follow-up ----
  w.sectionHeading('Follow-Up & Re-inspection');
  w.paragraph(report.followUp, { edit: edit('followUp'), placeholder: 'No follow-up plan recorded.' });

  // ---- Limitations, definitions, disclaimer ----
  if (report.limitations.trim() || editable) {
    w.sectionHeading('Limitations, Definitions & Disclaimer');
    w.paragraph(report.limitations, {
      edit: edit('limitations'),
      hint: 'Limitations of the method, definitions of the terms used, disclaimer…',
    });
  }

  w.footers(report.propertyAddress);
}
