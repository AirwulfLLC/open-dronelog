/**
 * Environmental conditions of a photogrammetry flight: weather, wind and
 * lighting — the things that decide how clean the data is.
 */

import type { PhotogrammetryReport } from '@/types/thermal';
import { inputCls, labelCls, type SectionProps } from '../types';

export function SurveyConditionsSection({ report, update }: SectionProps<PhotogrammetryReport>) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="col-span-2">
        <label className={labelCls}>Weather conditions</label>
        <input
          className={inputCls}
          value={report.weatherConditions}
          onChange={(e) => update({ weatherConditions: e.target.value })}
          placeholder="Clear, 18 °C, no precipitation"
        />
      </div>
      <div>
        <label className={labelCls}>Wind</label>
        <input
          className={inputCls}
          value={report.windConditions}
          onChange={(e) => update({ windConditions: e.target.value })}
          placeholder="3–5 m/s from the NW, gusts to 7 m/s"
        />
      </div>
      <div>
        <label className={labelCls}>Lighting</label>
        <input
          className={inputCls}
          value={report.lighting}
          onChange={(e) => update({ lighting: e.target.value })}
          placeholder="Overcast / diffuse, sun 42° high, minimal shadows"
        />
      </div>
    </div>
  );
}
