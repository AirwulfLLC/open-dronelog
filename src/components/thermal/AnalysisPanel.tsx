/**
 * AnalysisPanel — right-hand controls for the Thermal Studio:
 * palette + scale, temperature-range isolation (isotherm), measurement
 * parameters, and the AI variance/anomaly analysis with findings list.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useThermalStore } from '@/stores/thermalStore';
import * as thermalApi from '@/lib/thermalApi';
import {
  PALETTES,
  drawColorBar,
  formatTemp,
  rangeStats,
} from '@/lib/thermalPalettes';
import { CLASSIFICATION_LABELS, parseMetashapeMeta } from '@/types/thermal';
import type { AnomalyRegion, ThermalAsset } from '@/types/thermal';
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
    valueSuffix,
    assets,
    selectedAssetId,
  } = useThermalStore();
  const fmt = (v: number | null | undefined) => formatTemp(v, valueSuffix);
  const deg = valueSuffix === '' ? '' : '°';
  const selectedAssetForInfo = assets.find((a) => a.id === selectedAssetId) ?? null;

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
        <VegetationIndexSection />
        <div className="p-4 pb-0 text-xs text-gray-500">
          Select a radiometric image or vegetation index to see value analysis.
        </div>
        <Section title="Heat Flow Network (Radiation Exchange)">
          <NetworkPanel />
        </Section>
      </div>
    );
  }

  return (
    <div className="overflow-y-auto flex-1 min-h-0 text-sm">
      {selectedAssetForInfo && <IndexInfo asset={selectedAssetForInfo} />}
      {/* Quick stats */}
      <Section title={valueSuffix === '' ? 'Index Statistics' : 'Temperature Statistics'}>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <StatBox label="Max" value={fmt(stats.max)} accent="text-red-400" />
          <StatBox label="Min" value={fmt(stats.min)} accent="text-sky-400" />
          <StatBox label="Mean" value={fmt(stats.mean)} />
          <StatBox label="Median" value={fmt(stats.median)} />
          <StatBox label="Std Dev" value={`${stats.stdDev.toFixed(valueSuffix === '' ? 3 : 2)}${deg}`} />
          <StatBox label="Δ (max−min)" value={`${(stats.max - stats.min).toFixed(valueSuffix === '' ? 3 : 1)}${deg}`} accent="text-amber-300" />
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
          <span>{fmt(spanLow ?? stats.min)}</span>
          <span>{fmt(spanHigh ?? stats.max)}</span>
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
            step={valueSuffix === '' ? 0.05 : 0.5}
            value={spanLow ?? ''}
            placeholder={stats.min.toFixed(valueSuffix === '' ? 2 : 1)}
            onChange={(e) => setSpan(e.target.value === '' ? null : Number(e.target.value), spanHigh)}
            className="w-16 px-1.5 py-0.5 bg-gray-800 border border-gray-700 rounded text-white"
          />
          <span className="text-gray-500">to</span>
          <input
            type="number"
            step={valueSuffix === '' ? 0.05 : 0.5}
            value={spanHigh ?? ''}
            placeholder={stats.max.toFixed(valueSuffix === '' ? 2 : 1)}
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
                step={valueSuffix === '' ? 0.01 : 0.1}
                onChange={(v) => setIsotherm(true, Math.min(v, isothermHigh), undefined)}
              />
              <RangeRow
                label="High"
                value={isothermHigh}
                min={sliderMin}
                max={sliderMax}
                step={valueSuffix === '' ? 0.01 : 0.1}
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
                    {fmt(isoStats.min)} / {fmt(isoStats.mean)} / {fmt(isoStats.max)}
                  </b>
                </div>
              </div>
            )}
          </>
        )}
      </Section>

      {/* Measurement parameters — SDK physics, meaningless for index rasters.
          Also prevents Re-measure from writing SDK overrides that would then
          poison analysis of real thermal images. */}
      {valueSuffix !== '' && (
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
      )}

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
            {fmt(isothermLow)} – {fmt(isothermHigh)}.
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
              Baseline (median): <b className="text-gray-200">{fmt(anomalies.baseline)}</b> · σ ={' '}
              {anomalies.stdDev.toFixed(valueSuffix === '' ? 3 : 2)}{deg} · {anomalies.regions.length} finding
              {anomalies.regions.length === 1 ? '' : 's'}
            </div>
            {anomalies.regions.length === 0 && (
              <p className="text-xs text-gray-500">
                No significant anomalies at this sensitivity.
              </p>
            )}
            {anomalies.regions.map((r) => (
              <AnomalyCard key={r.id} region={r} suffix={valueSuffix} />
            ))}
          </div>
        )}

        {/* The AI narrative prompt is thermography-specific — hide for indices */}
        {valueSuffix !== '' && <AiNarrative />}
      </Section>

      {/* Heat flow network */}
      <Section title="Heat Flow Network (Radiation Exchange)">
        <NetworkPanel />
      </Section>
    </div>
  );
}

// ---------------- Vegetation indices ----------------

const BAND_ROLES = ['—', 'B', 'G', 'R', 'RE', 'NIR', 'T'] as const;
const BAND_ROLE_LABELS: Record<string, string> = {
  B: 'Blue',
  G: 'Green',
  R: 'Red',
  RE: 'RedEdge',
  NIR: 'NIR',
  T: 'Thermal',
};

const INDEX_PRESETS: Array<{ name: string; formula: string; needs: string[] }> = [
  { name: 'NDVI', formula: '(NIR - R) / (NIR + R)', needs: ['NIR', 'R'] },
  { name: 'GNDVI', formula: '(NIR - G) / (NIR + G)', needs: ['NIR', 'G'] },
  { name: 'NDRE', formula: '(NIR - RE) / (NIR + RE)', needs: ['NIR', 'RE'] },
  { name: 'SAVI', formula: '1.5 * (NIR - R) / (NIR + R + 0.5)', needs: ['NIR', 'R'] },
  { name: 'VARI', formula: '(G - R) / (G + R - B)', needs: ['G', 'R', 'B'] },
];

/** Sensible default band roles by band count (common camera layouts). */
function defaultMapping(bands: number): string[] {
  if (bands === 4) return ['G', 'R', 'RE', 'NIR']; // DJI Mavic 3M
  if (bands === 5) return ['B', 'G', 'R', 'RE', 'NIR']; // P4M / RedEdge
  if (bands >= 6) {
    const roles = ['B', 'G', 'R', 'RE', 'NIR', 'T']; // MicaSense Altum
    return Array.from({ length: bands }, (_, i) => roles[i] ?? '—');
  }
  return Array.from({ length: bands }, () => '—');
}

/** Band mapping + index computation for multispectral orthomosaics. */
function VegetationIndexSection() {
  const { assets, selectedAssetId, loadAssets, selectAsset } = useThermalStore();
  const asset: ThermalAsset | null = assets.find((a) => a.id === selectedAssetId) ?? null;
  const meta = asset ? parseMetashapeMeta(asset) : null;
  const bands = meta?.kind === 'multispectral' ? (meta.bands ?? 0) : 0;

  const [roles, setRoles] = useState<string[]>([]);
  const [preset, setPreset] = useState('NDVI');
  const [formula, setFormula] = useState(INDEX_PRESETS[0].formula);
  const [indexName, setIndexName] = useState('NDVI');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRoles(defaultMapping(bands));
    setError(null);
  }, [selectedAssetId, bands]);

  if (!asset || !meta || meta.kind !== 'multispectral' || bands === 0) return null;

  const mapping: Record<string, number> = {};
  roles.forEach((role, i) => {
    if (role !== '—' && !(role in mapping)) mapping[role] = i;
  });

  const applyPreset = (name: string) => {
    setPreset(name);
    const p = INDEX_PRESETS.find((x) => x.name === name);
    if (p) {
      setFormula(p.formula);
      setIndexName(p.name);
    }
  };

  const missing =
    INDEX_PRESETS.find((p) => p.name === preset)?.needs.filter((n) => !(n in mapping)) ?? [];

  const compute = async () => {
    if (selectedAssetId == null) return;
    const sourceId = selectedAssetId;
    setBusy(true);
    setError(null);
    try {
      const created = await thermalApi.computeVegetationIndex(
        sourceId,
        indexName.trim() || 'Index',
        formula,
        mapping,
      );
      await loadAssets();
      // Only jump to the result if the user hasn't moved on meanwhile
      if (useThermalStore.getState().selectedAssetId === sourceId) {
        await selectAsset(created.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Vegetation Index (Multispectral)">
      <p className="text-[10px] text-gray-500 mb-2">
        {bands}-band multispectral raster ({meta.bitsPerSample}-bit). Map each band to
        its spectral role, then compute an index — the result becomes a new asset
        with the full analysis pipeline (histogram, range isolation, anomalies).
      </p>

      {/* Band mapping */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 mb-2">
        {roles.map((role, i) => (
          <div key={i} className="flex items-center gap-1.5 text-[11px]">
            <span className="text-gray-500 w-14">Band {i + 1}</span>
            <select
              value={role}
              onChange={(e) => {
                const next = e.target.value;
                // A role can only map to one band — claiming it here clears
                // it from any other band.
                setRoles(
                  roles.map((r, j) =>
                    j === i ? next : r === next && next !== '—' ? '—' : r,
                  ),
                );
              }}
              className="flex-1 px-1 py-0.5 bg-gray-800 border border-gray-700 rounded text-white"
            >
              {BAND_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r === '—' ? '— unused —' : `${r} (${BAND_ROLE_LABELS[r]})`}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      {/* Preset + formula */}
      <div className="flex items-center gap-1.5 mb-1.5 text-[11px]">
        <span className="text-gray-400">Preset</span>
        <select
          value={preset}
          onChange={(e) => applyPreset(e.target.value)}
          className="flex-1 px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-white"
        >
          {INDEX_PRESETS.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
        <input
          value={indexName}
          onChange={(e) => setIndexName(e.target.value)}
          placeholder="Name"
          className="w-20 px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-white"
        />
      </div>
      <input
        value={formula}
        onChange={(e) => {
          setFormula(e.target.value);
          setPreset('custom');
        }}
        placeholder="(NIR - R) / (NIR + R)"
        className="w-full px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-[11px] text-white font-mono"
      />
      <p className="mt-1 text-[10px] text-gray-600">
        Variables: mapped band roles ({Object.keys(mapping).join(', ') || 'none'}) ·
        operators + − × ÷ and parentheses · constants allowed.
      </p>
      {missing.length > 0 && preset !== 'custom' && (
        <p className="mt-1 text-[10px] text-amber-400/90">
          {preset} needs band role(s): {missing.join(', ')} — map them above.
        </p>
      )}
      {error && <p className="mt-1 text-[10px] text-red-400 whitespace-pre-wrap">{error}</p>}
      <button
        onClick={compute}
        disabled={busy || Object.keys(mapping).length === 0}
        className="mt-2 w-full py-1.5 rounded bg-green-700/80 hover:bg-green-700 text-white text-xs font-medium disabled:opacity-50"
      >
        {busy ? 'Computing…' : `Compute ${indexName.trim() || 'index'}`}
      </button>
    </Section>
  );
}

/** Info line shown when the selected asset is a computed index. */
function IndexInfo({ asset }: { asset: ThermalAsset }) {
  const meta = parseMetashapeMeta(asset);
  if (meta?.kind !== 'vegetation_index') return null;
  return (
    <div className="px-3 pt-2 text-[10px] text-gray-500">
      <span className="text-green-400 font-medium">{meta.indexName ?? 'Index'}</span>
      {meta.formula ? ` = ${meta.formula}` : ''}
      {meta.stats
        ? ` · range ${meta.stats.min.toFixed(3)} … ${meta.stats.max.toFixed(3)}`
        : ''}
    </div>
  );
}

const AI_PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini',
};

/** AI narrative generation — uses the provider + key selected in Settings. */
function AiNarrative() {
  const { selectedAssetId, analysis, anomalies, networkResult } = useThermalStore();
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [provider, setProvider] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [narrative, setNarrative] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    thermalApi
      .thermalAiGetConfig()
      .then((cfg) => {
        if (cancelled) return;
        setProvider(cfg.provider);
        const keyed = {
          claude: cfg.hasClaudeKey,
          openai: cfg.hasOpenaiKey,
          gemini: cfg.hasGeminiKey,
        }[cfg.provider];
        setHasKey(!!keyed);
      })
      .catch(() => {
        if (!cancelled) setHasKey(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Clear stale narrative when the asset changes
  useEffect(() => {
    setNarrative(null);
    setError(null);
  }, [selectedAssetId]);

  const generate = async () => {
    if (selectedAssetId == null || !analysis) return;
    setBusy(true);
    setError(null);
    try {
      const context = {
        temperatureStats: analysis.stats,
        measurementParams: analysis.params,
        detectedAnomalies: anomalies ?? undefined,
        heatFlowNetwork: networkResult
          ? { flows: networkResult.flows, balances: networkResult.balances }
          : undefined,
      };
      const text = await thermalApi.thermalAiGenerateFindings(
        selectedAssetId,
        JSON.stringify(context),
      );
      setNarrative(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!analysis) return null;

  return (
    <div className="mt-3 pt-3 border-t border-gray-700/60">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-semibold text-gray-400">
          AI Narrative{provider ? ` (${AI_PROVIDER_LABELS[provider] ?? provider})` : ''}
        </span>
        {narrative && (
          <button
            onClick={() => {
              navigator.clipboard.writeText(narrative).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              });
            }}
            className="text-[10px] text-gray-500 hover:text-white"
          >
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        )}
      </div>
      {hasKey === false ? (
        <p className="text-[10px] text-gray-500">
          Pick an AI provider and add its API key in Settings (below the DJI API key)
          to generate narrative findings from the image and measured data.
        </p>
      ) : (
        <>
          <button
            onClick={generate}
            disabled={busy || hasKey == null}
            className="w-full py-1.5 rounded bg-purple-600/70 hover:bg-purple-600 text-white text-xs font-medium disabled:opacity-50"
          >
            {busy
              ? 'Analyzing with AI… (can take a minute)'
              : narrative
                ? 'Regenerate narrative'
                : anomalies
                  ? 'Generate AI narrative of findings'
                  : 'Generate AI narrative (runs on image + stats)'}
          </button>
          {error && <p className="mt-1.5 text-[10px] text-red-400 whitespace-pre-wrap">{error}</p>}
          {narrative && (
            <div className="mt-2 p-2 rounded bg-gray-900/60 border border-gray-700 text-[11px] text-gray-300 whitespace-pre-wrap max-h-64 overflow-y-auto select-text">
              {narrative}
            </div>
          )}
        </>
      )}
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
  step = 0.1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-8 text-gray-400">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-sky-500"
      />
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-16 px-1.5 py-0.5 bg-gray-800 border border-gray-700 rounded text-white"
      />
    </div>
  );
}

function AnomalyCard({ region: r, suffix = '°C' }: { region: AnomalyRegion; suffix?: string }) {
  const isIndex = suffix === '';
  return (
    <div className="p-2 rounded-lg bg-gray-800/60 border border-gray-700 text-[11px]">
      <div className="flex items-center justify-between mb-1">
        <span className="font-semibold text-gray-100">
          #{r.id} · {isIndex
            ? r.kind === 'hot' ? '▲ High' : '▼ Low'
            : r.kind === 'hot' ? '🔥 Hot' : '❄️ Cold'}{' '}
          spot
        </span>
        <span
          className={`px-1.5 py-0.5 rounded border text-[10px] font-medium uppercase ${SEVERITY_STYLES[r.severity]}`}
        >
          {r.severity}
        </span>
      </div>
      {!isIndex && (
        <div className="text-gray-400">
          {CLASSIFICATION_LABELS[r.classification] ?? r.classification}
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-2 mt-1 text-gray-400">
        <div>
          Δ: <b className="text-gray-200">{r.deltaT > 0 ? '+' : ''}{r.deltaT.toFixed(isIndex ? 3 : 1)}{suffix}</b>
        </div>
        <div>
          Area: <b className="text-gray-200">{r.areaPx.toLocaleString()} px</b>
        </div>
        <div>
          Max: <b className="text-gray-200">{formatTemp(r.tMax, suffix)}</b>
        </div>
        <div>
          Min: <b className="text-gray-200">{formatTemp(r.tMin, suffix)}</b>
        </div>
      </div>
      <div className="text-gray-500 mt-0.5">
        @ ({Math.round(r.centroid[0])}, {Math.round(r.centroid[1])})
      </div>
    </div>
  );
}

function Histogram() {
  const { analysis, isothermEnabled, isothermLow, isothermHigh, valueSuffix } = useThermalStore();
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
            title={`${formatTemp(b.temp, valueSuffix)}: ${b.count.toLocaleString()} px`}
            className={`flex-1 rounded-t-sm ${inIso ? 'bg-sky-400' : 'bg-gray-600'}`}
            style={{ height: `${Math.max(2, (b.count / maxCount) * 100)}%` }}
          />
        );
      })}
    </div>
  );
}
