/**
 * AnalysisPanel — right-hand controls for the Thermal Studio:
 * palette + scale, temperature-range isolation (isotherm), measurement
 * parameters, and the AI variance/anomaly analysis with findings list.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useThermalStore } from '@/stores/thermalStore';
import {
  PALETTES,
  drawColorBar,
  formatTemp,
  rangeStats,
} from '@/lib/thermalPalettes';
import { CLASSIFICATION_LABELS } from '@/types/thermal';
import type { AnomalyRegion } from '@/types/thermal';
import { NetworkPanel } from './NetworkPanel';

const SEVERITY_STYLES: Record<string, string> = {
  low: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  medium: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  high: 'bg-red-500/15 text-red-300 border-red-500/40',
};

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-gray-700/70">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-gray-300 hover:text-white"
      >
        {title}
        <span className={`transition-transform text-gray-500 ${open ? 'rotate-90' : ''}`}>›</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

export function AnalysisPanel() {
  const {
    analysis,
    matrix,
    paletteKey,
    setPalette,
    spanLow,
    spanHigh,
    setSpan,
    isothermEnabled,
    isothermLow,
    isothermHigh,
    isothermMode,
    setIsotherm,
    anomalies,
    runAnomalyDetection,
    clearAnomalies,
    isAnalyzing,
    reanalyze,
    measureOverrides,
  } = useThermalStore();

  const colorBarRef = useRef<HTMLCanvasElement>(null);
  const [zThreshold, setZThreshold] = useState(2.0);
  const [minRegionPx, setMinRegionPx] = useState(24);
  const [emissivity, setEmissivity] = useState<string>('');
  const [distance, setDistance] = useState<string>('');

  // `analysis` in the deps matters: the canvas only mounts once analysis is
  // loaded (early return below), so a paletteKey-only effect would never draw.
  useEffect(() => {
    if (colorBarRef.current) drawColorBar(colorBarRef.current, paletteKey);
  }, [paletteKey, analysis]);

  // Seed emissivity/distance inputs from analysis params
  useEffect(() => {
    if (analysis) {
      setEmissivity(
        String(measureOverrides.emissivity ?? analysis.params.emissivity ?? ''),
      );
      setDistance(String(measureOverrides.distance ?? analysis.params.distance ?? ''));
    }
  }, [analysis?.assetId]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = analysis?.stats ?? null;

  const isoStats = useMemo(() => {
    if (!matrix || !isothermEnabled) return null;
    return rangeStats(matrix.temps, isothermLow, isothermHigh);
  }, [matrix, isothermEnabled, isothermLow, isothermHigh]);

  const sliderMin = stats ? Math.floor(stats.min - 1) : -20;
  const sliderMax = stats ? Math.ceil(stats.max + 1) : 150;

  if (!analysis || !stats) {
    return (
      <div className="overflow-y-auto flex-1 min-h-0 text-sm">
        <div className="p-4 pb-0 text-xs text-gray-500">
          Select a radiometric image to see temperature analysis.
        </div>
        <Section title="Heat Flow Network (Radiation Exchange)">
          <NetworkPanel />
        </Section>
      </div>
    );
  }

  return (
    <div className="overflow-y-auto flex-1 min-h-0 text-sm">
      {/* Quick stats */}
      <Section title="Temperature Statistics">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <StatBox label="Max" value={formatTemp(stats.max)} accent="text-red-400" />
          <StatBox label="Min" value={formatTemp(stats.min)} accent="text-sky-400" />
          <StatBox label="Mean" value={formatTemp(stats.mean)} />
          <StatBox label="Median" value={formatTemp(stats.median)} />
          <StatBox label="Std Dev" value={`${stats.stdDev.toFixed(2)}°`} />
          <StatBox label="ΔT (max−min)" value={`${(stats.max - stats.min).toFixed(1)}°`} accent="text-amber-300" />
        </div>
        {/* Histogram */}
        <div className="mt-3">
          <Histogram />
        </div>
      </Section>

      {/* Palette */}
      <Section title="Palette & Scale">
        <div className="flex flex-wrap gap-1.5 mb-2">
          {PALETTES.map((p) => (
            <button
              key={p.key}
              onClick={() => setPalette(p.key)}
              className={`px-2 py-1 rounded text-[11px] border transition-colors ${
                paletteKey === p.key
                  ? 'bg-drone-primary/20 border-drone-primary text-white'
                  : 'border-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <canvas ref={colorBarRef} width={256} height={12} className="w-full h-3 rounded" />
        <div className="flex justify-between text-[10px] text-gray-500 mt-0.5">
          <span>{formatTemp(spanLow ?? stats.min)}</span>
          <span>{formatTemp(spanHigh ?? stats.max)}</span>
        </div>
        <div className="flex items-center gap-2 mt-2 text-[11px]">
          <label className="text-gray-400">Scale:</label>
          <button
            onClick={() => setSpan(null, null)}
            className={`px-2 py-0.5 rounded border ${
              spanLow == null && spanHigh == null
                ? 'border-drone-primary text-white'
                : 'border-gray-700 text-gray-400'
            }`}
          >
            Auto
          </button>
          <input
            type="number"
            step="0.5"
            value={spanLow ?? ''}
            placeholder={stats.min.toFixed(1)}
            onChange={(e) => setSpan(e.target.value === '' ? null : Number(e.target.value), spanHigh)}
            className="w-16 px-1.5 py-0.5 bg-gray-800 border border-gray-700 rounded text-white"
          />
          <span className="text-gray-500">to</span>
          <input
            type="number"
            step="0.5"
            value={spanHigh ?? ''}
            placeholder={stats.max.toFixed(1)}
            onChange={(e) => setSpan(spanLow, e.target.value === '' ? null : Number(e.target.value))}
            className="w-16 px-1.5 py-0.5 bg-gray-800 border border-gray-700 rounded text-white"
          />
        </div>
      </Section>

      {/* Temperature range isolation */}
      <Section title="Range Isolation (Isotherm)">
        <label className="flex items-center gap-2 text-xs text-gray-300 mb-2 cursor-pointer">
          <input
            type="checkbox"
            checked={isothermEnabled}
            onChange={(e) => setIsotherm(e.target.checked)}
            className="accent-sky-500"
          />
          Isolate a temperature range
        </label>
        {isothermEnabled && (
          <>
            <div className="space-y-2">
              <RangeRow
                label="Low"
                value={isothermLow}
                min={sliderMin}
                max={sliderMax}
                onChange={(v) => setIsotherm(true, Math.min(v, isothermHigh), undefined)}
              />
              <RangeRow
                label="High"
                value={isothermHigh}
                min={sliderMin}
                max={sliderMax}
                onChange={(v) => setIsotherm(true, undefined, Math.max(v, isothermLow))}
              />
            </div>
            <div className="flex items-center gap-2 mt-2 text-[11px]">
              <span className="text-gray-400">Display:</span>
              <button
                onClick={() => setIsotherm(true, undefined, undefined, 'highlight')}
                className={`px-2 py-0.5 rounded border ${
                  isothermMode === 'highlight'
                    ? 'border-drone-primary text-white'
                    : 'border-gray-700 text-gray-400'
                }`}
              >
                Highlight
              </button>
              <button
                onClick={() => setIsotherm(true, undefined, undefined, 'solo')}
                className={`px-2 py-0.5 rounded border ${
                  isothermMode === 'solo'
                    ? 'border-drone-primary text-white'
                    : 'border-gray-700 text-gray-400'
                }`}
              >
                Solo
              </button>
            </div>
            {isoStats && (
              <div className="mt-2 p-2 rounded bg-gray-800/60 border border-gray-700 text-[11px] text-gray-300 space-y-0.5">
                <div>
                  Pixels in range: <b>{isoStats.count.toLocaleString()}</b> ({isoStats.pct.toFixed(1)}%)
                </div>
                <div>
                  Range min/mean/max:{' '}
                  <b>
                    {formatTemp(isoStats.min)} / {formatTemp(isoStats.mean)} / {formatTemp(isoStats.max)}
                  </b>
                </div>
              </div>
            )}
          </>
        )}
      </Section>

      {/* Measurement parameters */}
      <Section title="Measurement Parameters" defaultOpen={false}>
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <label className="text-gray-400">
            Emissivity
            <input
              type="number"
              step="0.01"
              min="0.1"
              max="1"
              value={emissivity}
              onChange={(e) => setEmissivity(e.target.value)}
              className="mt-0.5 w-full px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-white"
            />
          </label>
          <label className="text-gray-400">
            Distance (m)
            <input
              type="number"
              step="1"
              min="1"
              value={distance}
              onChange={(e) => setDistance(e.target.value)}
              className="mt-0.5 w-full px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-white"
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2 mt-1.5 text-[11px] text-gray-500">
          <div>Humidity: {analysis.params.humidity}%</div>
          <div>Reflection: {formatTemp(analysis.params.reflection)}</div>
        </div>
        <button
          onClick={() =>
            reanalyze({
              emissivity: emissivity === '' ? undefined : Number(emissivity),
              distance: distance === '' ? undefined : Number(distance),
            })
          }
          disabled={isAnalyzing}
          className="mt-2 w-full py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium disabled:opacity-50"
        >
          Re-measure
        </button>
      </Section>

      {/* AI anomaly analysis */}
      <Section title="AI Variance Analysis">
        <div className="grid grid-cols-2 gap-2 text-[11px] mb-2">
          <label className="text-gray-400">
            Sensitivity (z-score)
            <input
              type="number"
              step="0.1"
              min="0.5"
              max="8"
              value={zThreshold}
              onChange={(e) => setZThreshold(Number(e.target.value))}
              className="mt-0.5 w-full px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-white"
            />
          </label>
          <label className="text-gray-400">
            Min region (px)
            <input
              type="number"
              step="1"
              min="1"
              value={minRegionPx}
              onChange={(e) => setMinRegionPx(Number(e.target.value))}
              className="mt-0.5 w-full px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-white"
            />
          </label>
        </div>
        {isothermEnabled && (
          <p className="text-[10px] text-sky-300/80 mb-2">
            Analysis will be restricted to the isolated range{' '}
            {formatTemp(isothermLow)} – {formatTemp(isothermHigh)}.
          </p>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => runAnomalyDetection({ zThreshold, minRegionPx })}
            disabled={isAnalyzing}
            className="flex-1 py-1.5 rounded bg-drone-primary hover:bg-drone-primary/80 text-white text-xs font-medium disabled:opacity-50"
          >
            {isAnalyzing ? 'Analyzing…' : anomalies ? 'Re-run analysis' : 'Detect anomalies'}
          </button>
          {anomalies && (
            <button
              onClick={clearAnomalies}
              className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs"
            >
              Clear
            </button>
          )}
        </div>

        {anomalies && (
          <div className="mt-3 space-y-2">
            <div className="text-[11px] text-gray-400">
              Baseline (median): <b className="text-gray-200">{formatTemp(anomalies.baseline)}</b> · σ ={' '}
              {anomalies.stdDev.toFixed(2)}° · {anomalies.regions.length} finding
              {anomalies.regions.length === 1 ? '' : 's'}
            </div>
            {anomalies.regions.length === 0 && (
              <p className="text-xs text-gray-500">
                No significant anomalies at this sensitivity.
              </p>
            )}
            {anomalies.regions.map((r) => (
              <AnomalyCard key={r.id} region={r} />
            ))}
          </div>
        )}
      </Section>

      {/* Heat flow network */}
      <Section title="Heat Flow Network (Radiation Exchange)">
        <NetworkPanel />
      </Section>
    </div>
  );
}

function StatBox({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="p-2 rounded bg-gray-800/60 border border-gray-700">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`font-mono font-semibold ${accent ?? 'text-gray-100'}`}>{value}</div>
    </div>
  );
}

function RangeRow({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-8 text-gray-400">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-sky-500"
      />
      <input
        type="number"
        step="0.1"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-16 px-1.5 py-0.5 bg-gray-800 border border-gray-700 rounded text-white"
      />
    </div>
  );
}

function AnomalyCard({ region: r }: { region: AnomalyRegion }) {
  return (
    <div className="p-2 rounded-lg bg-gray-800/60 border border-gray-700 text-[11px]">
      <div className="flex items-center justify-between mb-1">
        <span className="font-semibold text-gray-100">
          #{r.id} · {r.kind === 'hot' ? '🔥 Hot' : '❄️ Cold'} spot
        </span>
        <span
          className={`px-1.5 py-0.5 rounded border text-[10px] font-medium uppercase ${SEVERITY_STYLES[r.severity]}`}
        >
          {r.severity}
        </span>
      </div>
      <div className="text-gray-400">
        {CLASSIFICATION_LABELS[r.classification] ?? r.classification}
      </div>
      <div className="grid grid-cols-2 gap-x-2 mt-1 text-gray-400">
        <div>
          ΔT: <b className="text-gray-200">{r.deltaT > 0 ? '+' : ''}{r.deltaT.toFixed(1)}°C</b>
        </div>
        <div>
          Area: <b className="text-gray-200">{r.areaPx.toLocaleString()} px</b>
        </div>
        <div>
          Tmax: <b className="text-gray-200">{formatTemp(r.tMax)}</b>
        </div>
        <div>
          Tmin: <b className="text-gray-200">{formatTemp(r.tMin)}</b>
        </div>
      </div>
      <div className="text-gray-500 mt-0.5">
        @ ({Math.round(r.centroid[0])}, {Math.round(r.centroid[1])})
      </div>
    </div>
  );
}

function Histogram() {
  const { analysis, isothermEnabled, isothermLow, isothermHigh } = useThermalStore();
  const stats = analysis?.stats;
  if (!stats || stats.histogram.length === 0) return null;
  const maxCount = Math.max(...stats.histogram.map((b) => b.count));
  return (
    <div className="h-16 flex items-end gap-px">
      {stats.histogram.map((b, i) => {
        const inIso = isothermEnabled && b.temp >= isothermLow && b.temp <= isothermHigh;
        return (
          <div
            key={i}
            title={`${b.temp.toFixed(1)}°C: ${b.count.toLocaleString()} px`}
            className={`flex-1 rounded-t-sm ${inIso ? 'bg-sky-400' : 'bg-gray-600'}`}
            style={{ height: `${Math.max(2, (b.count / maxCount) * 100)}%` }}
          />
        );
      })}
    </div>
  );
}
