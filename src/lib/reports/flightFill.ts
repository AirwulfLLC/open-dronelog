/**
 * What a report can take from the DJI flight logs linked to it: the survey
 * date and time window, the site position, the aircraft, and (per kind) the
 * image count and flight altitude. Pure functions over the embedded flight
 * snapshots.
 */

import type { FlightSnapshot, ReportBase } from '@/types/thermal';
import type { ReportPatch } from '@/components/reports/types';

/** Flight start times come out of the database as "2026-02-01 14:35:52+00"
 *  (microseconds optional) — the legacy Date parser takes that form as is,
 *  while the ISO form needs the offset spelled "+00:00". Epoch ms or null. */
export function parseFlightTime(value: string | null | undefined): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  const iso = raw
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/([+-]\d{2})$/, '$1:00');
  for (const candidate of [raw, iso]) {
    const ms = Date.parse(candidate);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');
// Local time of the machine, like every other flight time the app shows
const dateOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const timeOf = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export interface FlightDerived {
  /** Date of the earliest flight (YYYY-MM-DD). */
  date: string | null;
  /** "09:31–10:12" from the earliest take-off to the latest landing (with
   *  dates when the flights span several days). */
  timeWindow: string | null;
  /** "lat, lon" of the first flight with a home point. */
  sitePosition: string | null;
  /** "Matrice 30T (Alpha)" — the most-flown model, with the aircraft name. */
  droneModel: string | null;
  droneSerial: string | null;
  /** Photos taken over all flights (null when no flight recorded a count). */
  photoCount: number | null;
  /** Highest altitude over all flights (m). */
  maxAltitudeM: number | null;
}

export function deriveFromFlights(flights: FlightSnapshot[]): FlightDerived {
  const out: FlightDerived = {
    date: null,
    timeWindow: null,
    sitePosition: null,
    droneModel: null,
    droneSerial: null,
    photoCount: null,
    maxAltitudeM: null,
  };
  if (flights.length === 0) return out;

  const timed = flights
    .map((f) => ({ f, start: parseFlightTime(f.startTime) }))
    .filter((x): x is { f: FlightSnapshot; start: number } => x.start != null);
  if (timed.length > 0) {
    const first = timed.reduce((a, b) => (b.start < a.start ? b : a));
    const ends = timed.filter((x) => x.f.durationSecs != null).map((x) => x.start + (x.f.durationSecs ?? 0) * 1000);
    out.date = dateOf(first.start);
    if (ends.length === 0) {
      // No durations recorded: the take-off time is all that is known
      out.timeWindow = timeOf(first.start);
    } else {
      const lastEnd = Math.max(first.start, ...ends);
      out.timeWindow =
        dateOf(first.start) === dateOf(lastEnd)
          ? `${timeOf(first.start)}–${timeOf(lastEnd)}`
          : `${dateOf(first.start)} ${timeOf(first.start)} – ${dateOf(lastEnd)} ${timeOf(lastEnd)}`;
    }
  }

  const home = flights.find((f) => f.homeLat != null && f.homeLon != null);
  if (home && home.homeLat != null && home.homeLon != null) {
    out.sitePosition = `${home.homeLat.toFixed(6)}, ${home.homeLon.toFixed(6)}`;
  }

  // The aircraft: the model flown most often (first linked wins a tie), named
  // after its aircraft name
  const byModel = new Map<string, { count: number; f: FlightSnapshot }>();
  for (const f of flights) {
    const model = f.droneModel?.trim();
    if (!model) continue;
    const cur = byModel.get(model);
    if (cur) cur.count += 1;
    else byModel.set(model, { count: 1, f });
  }
  let top: { count: number; f: FlightSnapshot } | null = null;
  for (const v of byModel.values()) if (!top || v.count > top.count) top = v;
  if (top) {
    const model = top.f.droneModel?.trim() ?? '';
    const name = top.f.aircraftName?.trim();
    out.droneModel = name && name !== model ? `${model} (${name})` : model;
    out.droneSerial = flights.find((f) => f.droneModel?.trim() === model && f.droneSerial)?.droneSerial ?? null;
  }

  const counted = flights.filter((f) => f.photoCount != null);
  if (counted.length > 0) out.photoCount = counted.reduce((s, f) => s + (f.photoCount ?? 0), 0);
  const altitudes = flights.map((f) => f.maxAltitude).filter((a): a is number => a != null);
  if (altitudes.length > 0) out.maxAltitudeM = Math.max(...altitudes);
  return out;
}

/** The base-report fields the flight logs can fill. */
export function baseFlightPatch(d: FlightDerived): ReportPatch<ReportBase> {
  const patch: ReportPatch<ReportBase> = {};
  if (d.date) patch.inspectionDate = d.date;
  if (d.timeWindow) patch.inspectionTime = d.timeWindow;
  if (d.sitePosition) patch.sitePosition = d.sitePosition;
  if (d.droneModel) patch.droneModel = d.droneModel;
  if (d.droneSerial) patch.droneSerial = d.droneSerial;
  return patch;
}

/** Readable names for the fields the flight logs fill (for notices). */
export const FLIGHT_FIELD_LABELS: Record<string, string> = {
  inspectionDate: 'date',
  inspectionTime: 'time window',
  sitePosition: 'site position',
  droneModel: 'aircraft',
  droneSerial: 'aircraft serial',
  imageCount: 'image count',
  flightAltitudeM: 'flight altitude',
};

/** Merge a fresh derivation into the report without touching what the user
 *  typed: a field is refreshed when it is blank, still holds what the
 *  previous derivation (over the previously linked flights) put there, or
 *  is the date a new report starts with (today). */
export function refreshDerived<T extends object>(report: T, previous: Partial<T>, next: Partial<T>): Partial<T> {
  const today = new Date().toISOString().slice(0, 10);
  const out: Partial<T> = {};
  for (const key of Object.keys(next) as Array<keyof T>) {
    const current = report[key];
    const blank = current == null || (typeof current === 'string' && !current.trim());
    const ours = previous[key] !== undefined && current === previous[key];
    const untouchedDate = key === 'inspectionDate' && current === today;
    if (blank || ours || untouchedDate) out[key] = next[key];
  }
  return out;
}
