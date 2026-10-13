/**
 * Thermal report header extras: survey time, thermographer credentials and
 * contact details, the camera used (fillable from the imagery's EXIF) and the
 * asset ID tags covered. Rendered inside the shared HeaderSection grid.
 */

import { useThermalStore } from '@/stores/thermalStore';
import { parseCameraMeta, type ThermalAsset, type ThermalReport } from '@/types/thermal';
import { inputCls, labelCls, smallBtnCls, type SectionProps } from '../types';

/** Ids of every picture the report refers to (imaging pairs and anomalies). */
export function referencedPictureIds(report: ThermalReport): Set<number> {
  const ids = new Set<number>();
  for (const e of report.imagingLog) {
    if (e.thermalAssetId != null) ids.add(e.thermalAssetId);
    if (e.visualAssetId != null) ids.add(e.visualAssetId);
  }
  for (const a of report.anomalies) if (a.assetId != null) ids.add(a.assetId);
  return ids;
}

/** The most frequent non-blank value, or ''. */
function mostCommon(values: Array<string | null | undefined>): string {
  const counts = new Map<string, number>();
  for (const v of values) {
    const s = v?.trim();
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** Camera make / model / serial read from a set of pictures' EXIF data. */
export function cameraFromPictures(pictures: ThermalAsset[]): { make: string; model: string; serial: string } {
  return {
    make: mostCommon(pictures.map((a) => parseCameraMeta(a).cameraMake)),
    model: mostCommon(pictures.map((a) => a.cameraModel)),
    serial: mostCommon(pictures.map((a) => parseCameraMeta(a).cameraSerial)),
  };
}

export function ThermalAdminFields({ report, update, setNotice }: SectionProps<ThermalReport>) {
  const assets = useThermalStore((s) => s.assets);

  const fillCamera = () => {
    // The report's own pictures first; the whole thermal library before any are linked
    let pool = assets.filter((a) => referencedPictureIds(report).has(a.id));
    if (pool.length === 0) pool = assets.filter((a) => a.source === 'thermal' && a.assetType === 'image');
    const cam = cameraFromPictures(pool);
    if (!cam.make && !cam.model && !cam.serial) {
      setNotice('The imagery carries no camera details in its EXIF data — enter them manually.');
      return;
    }
    update({
      cameraMake: cam.make || report.cameraMake,
      cameraModel: cam.model || report.cameraModel,
      cameraSerial: cam.serial || report.cameraSerial,
    });
    setNotice(
      `Camera details read from ${pool.length} picture(s)` +
        (cam.serial ? '.' : ' — no serial number was recorded in the EXIF data; enter it manually.'),
    );
  };

  return (
    <>
      <div>
        <label className={labelCls}>Inspection time</label>
        <input
          className={inputCls}
          value={report.inspectionTime}
          onChange={(e) => update({ inspectionTime: e.target.value })}
          placeholder="09:30–11:15"
        />
      </div>
      <div>
        <label className={labelCls}>Credentials</label>
        <input
          className={inputCls}
          value={report.inspectorCredentials}
          onChange={(e) => update({ inspectorCredentials: e.target.value })}
          placeholder="Level II Thermographer (ITC), FAA Part 107"
        />
      </div>
      <div className="col-span-2">
        <label className={labelCls}>Contact details</label>
        <input
          className={inputCls}
          value={report.inspectorContact}
          onChange={(e) => update({ inspectorContact: e.target.value })}
          placeholder="Company · phone · e-mail"
        />
      </div>
      <div>
        <label className={labelCls}>Camera make</label>
        <input
          className={inputCls}
          value={report.cameraMake}
          onChange={(e) => update({ cameraMake: e.target.value })}
          placeholder="DJI"
        />
      </div>
      <div>
        <label className={labelCls}>Camera model</label>
        <input
          className={inputCls}
          value={report.cameraModel}
          onChange={(e) => update({ cameraModel: e.target.value })}
          placeholder="Zenmuse H20T"
        />
      </div>
      <div>
        <label className={labelCls}>Camera serial number</label>
        <input
          className={inputCls}
          value={report.cameraSerial}
          onChange={(e) => update({ cameraSerial: e.target.value })}
        />
      </div>
      <div className="flex items-end">
        <button
          onClick={fillCamera}
          className={smallBtnCls}
          title="Read make, model and serial number from the EXIF data of the pictures in this report"
        >
          📷 Fill camera from imagery
        </button>
      </div>
      <div className="col-span-2">
        <label className={labelCls}>Asset IDs / tags covered</label>
        <input
          className={inputCls}
          value={report.assetTags}
          onChange={(e) => update({ assetTags: e.target.value })}
          placeholder="Building A envelope; roof R-1 to R-4; switchgear MDP-1, MDP-2"
        />
      </div>
    </>
  );
}
