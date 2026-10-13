/**
 * Hardware, software and accuracy metrics of a photogrammetry survey: the
 * aircraft and camera, the processing software, image counts, flight
 * altitude, GSD, ground control and RMSE, coordinate system. Most of it can
 * be read from the linked flight logs, the imagery's EXIF data and the
 * imported Metashape camera file.
 */

import { useThermalStore } from '@/stores/thermalStore';
import { baseFlightPatch, deriveFromFlights } from '@/lib/reports/flightFill';
import { parseMetashapeMeta, type PhotogrammetryReport } from '@/types/thermal';
import { NumField, inputCls, labelCls, smallBtnCls, type ReportPatch, type SectionProps } from '../types';
import { cameraFromPictures } from './AdministrativeFields';

export function TechnicalSpecsActions({ report, update, setNotice }: SectionProps<PhotogrammetryReport>) {
  const assets = useThermalStore((s) => s.assets);

  const fill = () => {
    const patch: ReportPatch<PhotogrammetryReport> = {};
    const filled: string[] = [];

    // Aircraft, images and altitude from the flight logs
    if (report.linkedFlights.length > 0) {
      const d = deriveFromFlights(report.linkedFlights);
      const base = baseFlightPatch(d);
      if (base.droneModel) patch.droneModel = base.droneModel;
      if (base.droneSerial) patch.droneSerial = base.droneSerial;
      if (d.photoCount != null) patch.imageCount = d.photoCount;
      if (d.maxAltitudeM != null) patch.flightAltitudeM = Math.round(d.maxAltitudeM);
      if (base.droneModel || d.photoCount != null || d.maxAltitudeM != null) filled.push('flight logs');
    }

    // The camera from the survey photos' EXIF data
    const cam = cameraFromPictures(assets.filter((a) => a.source === 'photogrammetry' && a.assetType === 'image'));
    const sensor = [cam.make, cam.model].filter(Boolean).join(' ');
    if (sensor) {
      patch.cameraSensor = sensor;
      filled.push('imagery EXIF');
    }

    // Aligned cameras and the CRS from the Metashape camera file (a ticked
    // deliverable first, else any in the library)
    const cameraFiles = assets.filter((a) => parseMetashapeMeta(a)?.kind === 'cameras_xml');
    const cameraFile = cameraFiles.find((a) => report.outputAssetIds.includes(a.id)) ?? cameraFiles[0];
    const meta = cameraFile ? parseMetashapeMeta(cameraFile) : null;
    if (meta?.cameraCount != null) patch.imagesAligned = meta.cameraCount;
    if (meta?.crs) patch.crs = meta.crs;
    if (meta?.cameraCount != null || meta?.crs) filled.push(`${cameraFile?.fileName}`);

    if (filled.length === 0) {
      setNotice('Nothing to read yet — link the flights, import the survey photos or the Metashape camera file (XML).');
      return;
    }
    update(patch);
    setNotice(`Filled from ${filled.join(', ')}. GSD, control points and RMSE come from the processing report.`);
  };

  return (
    <button
      onClick={fill}
      className={smallBtnCls}
      title="Aircraft, image count and altitude from the flight logs; camera from the photos' EXIF; aligned cameras and CRS from the Metashape camera file"
    >
      ↻ Fill from flights & imagery
    </button>
  );
}

export function TechnicalSpecsSection({ report, update }: SectionProps<PhotogrammetryReport>) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <div>
        <label className={labelCls}>Aircraft</label>
        <input
          className={inputCls}
          value={report.droneModel}
          onChange={(e) => update({ droneModel: e.target.value })}
          placeholder="Mavic 3 Enterprise"
        />
      </div>
      <div>
        <label className={labelCls}>Aircraft serial number</label>
        <input className={inputCls} value={report.droneSerial} onChange={(e) => update({ droneSerial: e.target.value })} />
      </div>
      <div>
        <label className={labelCls}>Camera / sensor</label>
        <input
          className={inputCls}
          value={report.cameraSensor}
          onChange={(e) => update({ cameraSensor: e.target.value })}
          placeholder="20 MP 4/3 CMOS, 24 mm, mechanical shutter"
        />
      </div>
      <div className="col-span-2">
        <label className={labelCls}>Photogrammetry software</label>
        <input
          className={inputCls}
          value={report.software}
          onChange={(e) => update({ software: e.target.value })}
          placeholder="Agisoft Metashape Professional 2.1"
        />
      </div>
      <div>
        <label className={labelCls}>Coordinate reference system</label>
        <input
          className={inputCls}
          value={report.crs}
          onChange={(e) => update({ crs: e.target.value })}
          placeholder="WGS 84 / UTM zone 16N"
        />
      </div>
      <NumField label="Images captured" value={report.imageCount} step={1} onChange={(v) => update({ imageCount: v })} />
      <NumField label="Images aligned" value={report.imagesAligned} step={1} onChange={(v) => update({ imagesAligned: v })} />
      <NumField
        label="Flight altitude (m AGL)"
        value={report.flightAltitudeM}
        step={1}
        onChange={(v) => update({ flightAltitudeM: v })}
      />
      <NumField label="GSD (cm / pixel)" value={report.gsdCmPx} step={0.01} onChange={(v) => update({ gsdCmPx: v })} />
      <NumField label="Ground control points" value={report.gcpCount} step={1} onChange={(v) => update({ gcpCount: v })} />
      <NumField label="RMSE (cm)" value={report.rmseCm} step={0.1} onChange={(v) => update({ rmseCm: v })} />
    </div>
  );
}
