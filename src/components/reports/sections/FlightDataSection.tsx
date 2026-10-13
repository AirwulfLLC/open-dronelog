/**
 * Link the DJI flights that produced the imagery. Snapshots of their
 * operations data are embedded so the report renders anywhere, and the
 * report's header fields are filled from the logs: the survey date and
 * time window, the site position and the aircraft, plus whatever the
 * report kind derives itself (image count, flight altitude…). Every link
 * refreshes the values the logs filled (the window widens, the image count
 * grows) and leaves values the user typed alone; the "Fill from flight
 * logs" action re-applies everything.
 */

import { useFlightStore } from '@/stores/flightStore';
import {
  FLIGHT_FIELD_LABELS,
  baseFlightPatch,
  deriveFromFlights,
  refreshDerived,
  type FlightDerived,
} from '@/lib/reports/flightFill';
import type { FlightSnapshot, ReportBase } from '@/types/thermal';
import type { Flight } from '@/types';
import { smallBtnCls, type ReportPatch, type SectionProps } from '../types';

export function flightToSnapshot(f: Flight): FlightSnapshot {
  return {
    id: f.id,
    displayName: f.displayName || f.fileName,
    startTime: f.startTime,
    droneModel: f.droneModel,
    droneSerial: f.droneSerial ?? null,
    aircraftName: f.aircraftName,
    durationSecs: f.durationSecs,
    totalDistance: f.totalDistance,
    maxAltitude: f.maxAltitude,
    maxSpeed: f.maxSpeed,
    homeLat: f.homeLat ?? null,
    homeLon: f.homeLon ?? null,
    photoCount: f.photoCount,
  };
}

/** Fields of a report kind beyond the base ones that the flight logs can fill. */
export type FlightDerivePatch<R> = (d: FlightDerived) => ReportPatch<R>;

function patchFromFlights<R extends ReportBase>(flights: FlightSnapshot[], derive?: FlightDerivePatch<R>): ReportPatch<R> {
  const d = deriveFromFlights(flights);
  return { ...(baseFlightPatch(d) as ReportPatch<R>), ...(derive ? derive(d) : {}) };
}

/** The section and its heading action for one report kind. */
export function makeFlightDataSection<R extends ReportBase>(derive?: FlightDerivePatch<R>) {
  function Component({ report, update }: SectionProps<R>) {
    const { flights } = useFlightStore();

    const toggleFlight = (f: Flight) => {
      const linked = report.linkedFlights.some((s) => s.id === f.id);
      if (linked) {
        update({ linkedFlights: report.linkedFlights.filter((s) => s.id !== f.id) } as ReportPatch<R>);
        return;
      }
      const linkedFlights = [...report.linkedFlights, flightToSnapshot(f)];
      // Refresh what the logs filled before (the window widens, the image
      // count grows with more batteries and days); keep what the user typed
      const previous = patchFromFlights(report.linkedFlights, derive);
      const next = patchFromFlights(linkedFlights, derive);
      const applied = refreshDerived(report, previous as Partial<R>, next as Partial<R>);
      update({ ...(applied as ReportPatch<R>), linkedFlights } as ReportPatch<R>);
    };

    if (flights.length === 0) {
      return (
        <p className="text-[11px] text-gray-500">
          No flights in the log yet — import DJI flight logs from the Individual/Overview
          views, then link them here.
        </p>
      );
    }

    return (
      <>
        <p className="text-[11px] text-gray-500 mb-2">
          Link the flights that produced this report's imagery. Their operations data is
          embedded in the report, their full telemetry is included in exported inspection
          bundles, and the survey date, time window, site position and aircraft are filled
          in from the logs.
        </p>
        <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-700 divide-y divide-gray-800">
          {flights.map((f) => {
            const linked = report.linkedFlights.some((s) => s.id === f.id);
            return (
              <label
                key={f.id}
                className={`flex items-center gap-2 px-2.5 py-1.5 text-[11px] cursor-pointer ${
                  linked ? 'bg-drone-primary/10 text-white' : 'text-gray-400 hover:bg-gray-800/60'
                }`}
              >
                <input
                  type="checkbox"
                  checked={linked}
                  onChange={() => toggleFlight(f)}
                  className="accent-sky-500"
                />
                <span className="flex-1 truncate">{f.displayName || f.fileName}</span>
                <span className="text-gray-500 whitespace-nowrap">
                  {f.startTime ? f.startTime.slice(0, 10) : ''}
                  {f.droneModel ? ` · ${f.droneModel}` : ''}
                </span>
              </label>
            );
          })}
        </div>
        {report.linkedFlights.length > 0 && (
          <p className="mt-1.5 text-[10px] text-gray-500">
            {report.linkedFlights.length} flight(s) linked
            {report.linkedFlights.some((s) => !flights.some((f) => f.id === s.id)) &&
              ' (some linked flights are no longer in the log — their snapshots remain in the report)'}
          </p>
        )}
      </>
    );
  }
  Component.displayName = 'FlightDataSection';

  function Actions({ report, update, setNotice }: SectionProps<R>) {
    const refill = () => {
      if (report.linkedFlights.length === 0) {
        setNotice('Link a flight first — the data is read from the linked flight logs.');
        return;
      }
      const patch = patchFromFlights(report.linkedFlights, derive);
      update(patch);
      const filled = Object.keys(patch).map((k) => FLIGHT_FIELD_LABELS[k] ?? k);
      setNotice(
        filled.length > 0
          ? `Filled from ${report.linkedFlights.length} flight log(s): ${filled.join(', ')}.`
          : 'The linked flight logs carry none of the data the report can use.',
      );
    };
    return (
      <button
        onClick={refill}
        disabled={report.linkedFlights.length === 0}
        className={`${smallBtnCls} disabled:opacity-40`}
        title="Set the survey date, time window, site position, aircraft and flight-derived figures from the linked flight logs (overwrites)"
      >
        ↻ Fill from flight logs
      </button>
    );
  }
  Actions.displayName = 'FlightDataActions';

  return { Component, Actions };
}
