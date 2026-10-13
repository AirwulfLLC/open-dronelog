/**
 * Environmental & System Conditions — the weather, ambient temperature and
 * humidity, the system or electrical load during the survey, and the
 * measurement calibration (emissivity, reflected temperature, distance),
 * which can be copied from the selected picture's radiometric analysis.
 */

import { useThermalStore } from '@/stores/thermalStore';
import type { ThermalReport } from '@/types/thermal';
import { NumField, inputCls, labelCls, smallBtnCls, type SectionProps } from '../types';

export function ConditionsActions({ update, setNotice }: SectionProps<ThermalReport>) {
  const analysis = useThermalStore((s) => s.analysis);
  const valueSuffix = useThermalStore((s) => s.valueSuffix);
  const apply = () => {
    // A vegetation index is "measurable" too, but its analysis carries no
    // camera parameters (they come back as zeros)
    if (!analysis || valueSuffix === '') {
      setNotice('Select a radiometric thermal picture first — the parameters are read from its analysis.');
      return;
    }
    const p = analysis.params;
    update({
      emissivity: p.emissivity,
      reflectedTempC: p.reflection,
      ambientTempC: p.ambientTemp,
      humidityPct: p.humidity,
      measurementDistanceM: p.distance,
    });
    setNotice('Measurement parameters copied from the selected picture’s analysis.');
  };
  return (
    <button
      onClick={apply}
      className={smallBtnCls}
      title="Copy emissivity, reflected temperature, ambient temperature, humidity and distance from the selected picture’s analysis"
    >
      ⚙ Use analysis parameters
    </button>
  );
}

export function ConditionsSection({ report, update }: SectionProps<ThermalReport>) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="col-span-3">
        <label className={labelCls}>Weather conditions (sun exposure, wind, precipitation)</label>
        <input
          className={inputCls}
          value={report.weatherConditions}
          onChange={(e) => update({ weatherConditions: e.target.value })}
          placeholder="Overcast, wind 3 m/s NW, no direct sun, no precipitation last 24 h"
        />
      </div>
      <NumField label="Ambient temperature (°C)" value={report.ambientTempC} onChange={(v) => update({ ambientTempC: v })} />
      <NumField label="Relative humidity (%)" value={report.humidityPct} step={1} onChange={(v) => update({ humidityPct: v })} />
      <NumField
        label="Measurement distance (m)"
        value={report.measurementDistanceM}
        step={0.5}
        onChange={(v) => update({ measurementDistanceM: v })}
      />
      <div className="col-span-3">
        <label className={labelCls}>System / electrical load conditions</label>
        <input
          className={inputCls}
          value={report.loadConditions}
          onChange={(e) => update({ loadConditions: e.target.value })}
          placeholder="Switchgear under normal live load (~80%); HVAC in heating mode; building occupied"
        />
      </div>
      <NumField label="Emissivity setting" value={report.emissivity} step={0.01} onChange={(v) => update({ emissivity: v })} />
      <NumField
        label="Reflected / background temperature (°C)"
        value={report.reflectedTempC}
        onChange={(v) => update({ reflectedTempC: v })}
      />
      <p className="text-[10px] text-gray-500 self-end pb-1">
        Calibration values the temperatures were measured with — printed so the readings can be reproduced.
      </p>
    </div>
  );
}
