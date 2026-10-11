/**
 * Link the DJI flights that produced the imagery. Snapshots of their
 * operations data are embedded so the report renders anywhere.
 */

import { useFlightStore } from '@/stores/flightStore';
import type { FlightSnapshot, ReportBase } from '@/types/thermal';
import type { Flight } from '@/types';
import type { SectionProps } from '../types';

export function flightToSnapshot(f: Flight): FlightSnapshot {
  return {
    id: f.id,
    displayName: f.displayName || f.fileName,
    startTime: f.startTime,
    droneModel: f.droneModel,
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

export function FlightDataSection({ report, update }: SectionProps<ReportBase>) {
  const { flights } = useFlightStore();

  const toggleFlight = (f: Flight) => {
    const linked = report.linkedFlights.some((s) => s.id === f.id);
    update({
      linkedFlights: linked
        ? report.linkedFlights.filter((s) => s.id !== f.id)
        : [...report.linkedFlights, flightToSnapshot(f)],
    });
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
        embedded in the report and their full telemetry is included in exported
        inspection bundles.
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
