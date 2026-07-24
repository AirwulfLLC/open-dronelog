/**
 * NetworkPanel — sidebar section for the heat-flow network:
 * solve controls (steady / transient), property editors for the selected
 * node/conductor (m·cp, sources, conductance — constant or time/temperature
 * tables), per-conductor flows, per-node surface heat balances, and a
 * transient temperature chart.
 */

import { useMemo, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import { useThermalStore } from '@/stores/thermalStore';
import { formatWatts } from './NetworkLayer';
import type {
  NetConductor,
  NetNode,
  NetNodeKind,
  PropValue,
} from '@/types/thermal';

const inputCls =
  'w-full px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-[11px] text-white placeholder-gray-500 focus:outline-none focus:border-drone-primary';
const labelCls = 'block text-[10px] font-medium text-gray-500 mb-0.5';

/** Editor for a PropValue: constant, f(time) or f(temperature). */
function PropEditor({
  label,
  unit,
  value,
  onChange,
  allowNone,
  timeUnit = 's',
}: {
  label: string;
  unit: string;
  value: PropValue | null | undefined;
  onChange: (v: PropValue | null) => void;
  allowNone?: boolean;
  timeUnit?: string;
}) {
  const mode = value?.mode ?? (allowNone ? 'none' : 'constant');

  const setMode = (m: string) => {
    if (m === 'none') {
      onChange(null);
    } else if (m === 'constant') {
      // Spread the old value so an entered table survives a round trip
      // through constant mode (serde ignores the inactive field).
      onChange({ ...value, mode: 'constant', value: value?.value ?? firstPointY(value) ?? 1 });
    } else {
      const base = value?.value ?? firstPointY(value) ?? 1;
      onChange({
        ...value,
        mode: m as 'timeTable' | 'tempTable',
        points: value?.points?.length ? value.points : [[0, base], [100, base]],
      });
    }
  };

  return (
    <div className="mb-2">
      <div className="flex items-center justify-between">
        <label className={labelCls}>
          {label} <span className="text-gray-600">({unit})</span>
        </label>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          className="px-1 py-0.5 bg-gray-800 border border-gray-700 rounded text-[10px] text-gray-300"
        >
          {allowNone && <option value="none">none</option>}
          <option value="constant">constant</option>
          <option value="timeTable">f(time)</option>
          <option value="tempTable">f(temp)</option>
        </select>
      </div>
      {value?.mode === 'constant' && (
        <input
          type="number"
          step="any"
          className={inputCls}
          value={value.value ?? ''}
          onChange={(e) =>
            onChange({ mode: 'constant', value: e.target.value === '' ? 0 : Number(e.target.value) })
          }
        />
      )}
      {(value?.mode === 'timeTable' || value?.mode === 'tempTable') && (
        <TableEditor
          xLabel={value.mode === 'timeTable' ? `t (${timeUnit})` : 'T (°C)'}
          yLabel={unit}
          points={value.points ?? []}
          onChange={(points) => onChange({ ...value, points })}
        />
      )}
    </div>
  );
}

function firstPointY(v: PropValue | null | undefined): number | undefined {
  return v?.points?.[0]?.[1];
}

function TableEditor({
  xLabel,
  yLabel,
  points,
  onChange,
}: {
  xLabel: string;
  yLabel: string;
  points: Array<[number, number]>;
  onChange: (points: Array<[number, number]>) => void;
}) {
  return (
    <div className="mt-1 border border-gray-700 rounded p-1.5 bg-gray-900/40">
      <div className="grid grid-cols-[1fr_1fr_20px] gap-1 text-[9px] text-gray-500 mb-0.5">
        <span>{xLabel}</span>
        <span>{yLabel}</span>
        <span />
      </div>
      {points.map((p, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_20px] gap-1 mb-1">
          <input
            type="number"
            step="any"
            className={inputCls}
            value={p[0]}
            onChange={(e) => {
              const next = points.map((q, j) => (j === i ? ([Number(e.target.value), q[1]] as [number, number]) : q));
              onChange(next);
            }}
          />
          <input
            type="number"
            step="any"
            className={inputCls}
            value={p[1]}
            onChange={(e) => {
              const next = points.map((q, j) => (j === i ? ([q[0], Number(e.target.value)] as [number, number]) : q));
              onChange(next);
            }}
          />
          <button
            onClick={() => onChange(points.filter((_, j) => j !== i))}
            className="text-gray-500 hover:text-red-400 text-xs"
            title="Remove row"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        onClick={() => {
          const last = points[points.length - 1];
          onChange([...points, [last ? last[0] + 100 : 0, last ? last[1] : 1]]);
        }}
        className="text-[10px] text-sky-400 hover:text-sky-300"
      >
        + add row
      </button>
    </div>
  );
}

function NodeEditor({ node }: { node: NetNode }) {
  const { updateNetNode, removeNetElement } = useThermalStore();
  return (
    <div className="p-2 rounded-lg bg-gray-800/50 border border-drone-primary/40 mb-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-semibold text-white">Node {node.id}</span>
        <button
          onClick={() => removeNetElement('node', node.id)}
          className="text-gray-500 hover:text-red-400 text-xs"
          title="Delete node (and attached conductors)"
        >
          🗑
        </button>
      </div>
      <div className="grid grid-cols-2 gap-1.5 mb-1.5">
        <div>
          <label className={labelCls}>Label</label>
          <input
            className={inputCls}
            value={node.label}
            placeholder={node.id}
            onChange={(e) => updateNetNode(node.id, { label: e.target.value })}
          />
        </div>
        <div>
          <label className={labelCls}>Kind</label>
          <select
            className={inputCls}
            value={node.kind}
            onChange={(e) => updateNetNode(node.id, { kind: e.target.value as NetNodeKind })}
          >
            <option value="diffusion">Diffusion (has mass)</option>
            <option value="arithmetic">Arithmetic (massless)</option>
            <option value="boundary">Boundary (fixed T)</option>
          </select>
        </div>
      </div>
      <div className="mb-1.5">
        <label className={labelCls}>
          {node.kind === 'boundary' ? 'Temperature (°C)' : 'Initial temperature (°C)'}
        </label>
        <input
          type="number"
          step="0.1"
          className={inputCls}
          value={node.initialTempC}
          onChange={(e) => updateNetNode(node.id, { initialTempC: Number(e.target.value) })}
        />
      </div>
      {node.kind === 'boundary' && (
        <PropEditor
          label="Prescribed temperature override"
          unit="°C"
          value={node.boundaryTempC}
          onChange={(v) => updateNetNode(node.id, { boundaryTempC: v })}
          allowNone
        />
      )}
      {node.kind === 'diffusion' && (
        <PropEditor
          label="m·cp (mass × specific heat)"
          unit="J/K"
          value={node.mcp}
          onChange={(v) => updateNetNode(node.id, { mcp: v })}
        />
      )}
      {node.kind !== 'boundary' && (
        <PropEditor
          label="Source (heater / dissipation / solar)"
          unit="W"
          value={node.source}
          onChange={(v) => updateNetNode(node.id, { source: v })}
          allowNone
        />
      )}
    </div>
  );
}

function ConductorEditor({ conductor }: { conductor: NetConductor }) {
  const { updateNetConductor, removeNetElement } = useThermalStore();
  const isRad = conductor.kind === 'radiative';
  return (
    <div className="p-2 rounded-lg bg-gray-800/50 border border-drone-primary/40 mb-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-semibold text-white">
          Conductor {conductor.id}{' '}
          <span className="text-gray-500 font-normal">
            {conductor.from} ⇄ {conductor.to}
          </span>
        </span>
        <button
          onClick={() => removeNetElement('conductor', conductor.id)}
          className="text-gray-500 hover:text-red-400 text-xs"
        >
          🗑
        </button>
      </div>
      <div className="mb-1.5">
        <label className={labelCls}>Kind</label>
        <select
          className={inputCls}
          value={conductor.kind}
          onChange={(e) =>
            updateNetConductor(conductor.id, { kind: e.target.value as 'linear' | 'radiative' })
          }
        >
          <option value="linear">Linear — conduction kA/L or convection hA</option>
          <option value="radiative">Radiative — σ·εFA·(T₁⁴−T₂⁴)</option>
        </select>
      </div>
      <PropEditor
        label={isRad ? 'εFA (emissivity × view factor × area)' : 'Conductance G'}
        unit={isRad ? 'm²' : 'W/K'}
        value={conductor.value}
        onChange={(v) => v && updateNetConductor(conductor.id, { value: v })}
      />
    </div>
  );
}

export function NetworkPanel() {
  const {
    network,
    networkResult,
    isSolving,
    solveNetwork,
    clearNetworkResult,
    selectedNetElement,
    selectNetElement,
    setNetwork,
  } = useThermalStore();

  const [mode, setMode] = useState<'steady' | 'transient'>('steady');
  const [durationS, setDurationS] = useState(600);
  const [timeStepS, setTimeStepS] = useState<number | ''>('');

  const selectedNode = useMemo(
    () =>
      selectedNetElement?.type === 'node'
        ? network.nodes.find((n) => n.id === selectedNetElement.id) ?? null
        : null,
    [selectedNetElement, network],
  );
  const selectedConductor = useMemo(
    () =>
      selectedNetElement?.type === 'conductor'
        ? network.conductors.find((c) => c.id === selectedNetElement.id) ?? null
        : null,
    [selectedNetElement, network],
  );

  const chartOption = useMemo(() => {
    if (!networkResult || networkResult.mode !== 'transient') return null;
    return {
      backgroundColor: 'transparent',
      grid: { left: 40, right: 8, top: 24, bottom: 22 },
      tooltip: { trigger: 'axis' },
      legend: {
        show: true,
        top: 0,
        textStyle: { color: '#9ca3af', fontSize: 9 },
        itemWidth: 10,
        itemHeight: 6,
      },
      xAxis: {
        type: 'value',
        name: 's',
        axisLabel: { color: '#6b7280', fontSize: 9 },
        splitLine: { lineStyle: { color: '#1f2937' } },
      },
      yAxis: {
        type: 'value',
        name: '°C',
        axisLabel: { color: '#6b7280', fontSize: 9 },
        splitLine: { lineStyle: { color: '#1f2937' } },
      },
      series: networkResult.nodeIds.map((id, i) => ({
        name: id,
        type: 'line',
        showSymbol: false,
        data: networkResult.times.map((t, k) => [t, networkResult.temps[i][k]]),
      })),
    };
  }, [networkResult]);

  if (network.nodes.length === 0) {
    return (
      <p className="text-[11px] text-gray-500">
        Use the <b>Node</b> tool to place computation points on the image (they sample
        the measured temperature), then connect them with the <b>Link</b> tool.
        Conductors model conduction/convection (Fourier: q = G·ΔT) or radiation
        exchange (q = σ·εFA·(T₁⁴−T₂⁴)); nodes can have mass (m·cp), sources, or be
        held as boundaries.
      </p>
    );
  }

  return (
    <div>
      {/* Solve controls */}
      <div className="flex items-center gap-1.5 mb-2 text-[11px]">
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as 'steady' | 'transient')}
          className="px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-white"
        >
          <option value="steady">Steady state</option>
          <option value="transient">Transient</option>
        </select>
        {mode === 'transient' && (
          <>
            <input
              type="number"
              min="1"
              step="any"
              value={durationS}
              onChange={(e) => setDurationS(Number(e.target.value))}
              className="w-16 px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-white"
              title="Duration (s)"
            />
            <span className="text-gray-500">s, dt</span>
            <input
              type="number"
              min="0.001"
              step="any"
              value={timeStepS}
              placeholder="auto"
              onChange={(e) => setTimeStepS(e.target.value === '' ? '' : Number(e.target.value))}
              className="w-14 px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-white"
              title="Time step (s), blank = auto"
            />
          </>
        )}
        <button
          onClick={() =>
            solveNetwork({
              mode,
              durationS: mode === 'transient' ? durationS : undefined,
              timeStepS: mode === 'transient' && timeStepS !== '' ? timeStepS : undefined,
            })
          }
          disabled={isSolving}
          className="flex-1 py-1 rounded bg-drone-primary hover:bg-drone-primary/80 text-white font-medium disabled:opacity-50"
        >
          {isSolving ? 'Solving…' : 'Solve'}
        </button>
      </div>

      <div className="text-[10px] text-gray-500 mb-2">
        {network.nodes.length} nodes · {network.conductors.length} conductors
        {networkResult && (
          <>
            {' '}
            · {networkResult.converged ? `converged (${networkResult.iterations} iter)` : 'NOT converged'}
            <button onClick={clearNetworkResult} className="ml-2 text-gray-500 hover:text-white">
              clear result
            </button>
          </>
        )}
        <button
          onClick={() => {
            if (window.confirm('Remove all nodes and conductors?')) {
              setNetwork({ nodes: [], conductors: [] });
              selectNetElement(null);
            }
          }}
          className="ml-2 text-gray-500 hover:text-red-400"
        >
          clear network
        </button>
      </div>

      {networkResult?.warning && (
        <p className="text-[10px] text-amber-400 mb-2">{networkResult.warning}</p>
      )}

      {/* Selected element editor */}
      {selectedNode && <NodeEditor node={selectedNode} />}
      {selectedConductor && <ConductorEditor conductor={selectedConductor} />}
      {!selectedNode && !selectedConductor && (
        <p className="text-[10px] text-gray-600 mb-2">
          Click a node or conductor in the image (Select tool) to edit its
          properties — kind, m·cp, sources, conductance, tables.
        </p>
      )}

      {/* Element lists */}
      <div className="space-y-0.5 mb-2">
        {network.nodes.map((n) => {
          const bal = networkResult?.balances.find((b) => b.id === n.id);
          return (
            <button
              key={n.id}
              onClick={() => selectNetElement({ type: 'node', id: n.id })}
              className={`w-full text-left px-1.5 py-1 rounded text-[10px] flex justify-between ${
                selectedNetElement?.type === 'node' && selectedNetElement.id === n.id
                  ? 'bg-drone-primary/20 text-white'
                  : 'text-gray-400 hover:bg-gray-800'
              }`}
            >
              <span>
                {n.kind === 'boundary' ? '⬛' : n.kind === 'arithmetic' ? '◯' : '⬤'}{' '}
                {n.label || n.id}
              </span>
              <span className="font-mono">
                {bal ? `${bal.tempC.toFixed(1)}°C` : `${n.initialTempC.toFixed(1)}°C`}
              </span>
            </button>
          );
        })}
        {network.conductors.map((c) => {
          const flow = networkResult?.flows.find((f) => f.id === c.id);
          return (
            <button
              key={c.id}
              onClick={() => selectNetElement({ type: 'conductor', id: c.id })}
              className={`w-full text-left px-1.5 py-1 rounded text-[10px] flex justify-between ${
                selectedNetElement?.type === 'conductor' && selectedNetElement.id === c.id
                  ? 'bg-drone-primary/20 text-white'
                  : 'text-gray-400 hover:bg-gray-800'
              }`}
            >
              <span>
                {c.kind === 'radiative' ? '〰' : '—'} {c.id}: {c.from}→{c.to}
              </span>
              {flow && (
                <span className="font-mono text-amber-300">
                  {flow.q >= 0 ? '' : '−'}
                  {formatWatts(Math.abs(flow.q))}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Surface heat balance */}
      {networkResult && (
        <div className="mb-2">
          <div className="text-[10px] font-semibold text-gray-400 mb-1">
            Surface heat balance (per node, + = inflow)
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[9px] text-gray-400">
              <thead>
                <tr className="text-gray-500 border-b border-gray-700">
                  <th className="text-left py-0.5">Node</th>
                  <th className="text-right">Cond/Conv</th>
                  <th className="text-right">Radiation</th>
                  <th className="text-right">Source</th>
                  <th className="text-right">Storage</th>
                </tr>
              </thead>
              <tbody>
                {networkResult.balances.map((b) => (
                  <tr key={b.id} className="border-b border-gray-800">
                    <td className="py-0.5 text-gray-300">{b.id}</td>
                    <td className="text-right font-mono">{formatWatts(b.linearInW)}</td>
                    <td className="text-right font-mono">{formatWatts(b.radiativeInW)}</td>
                    <td className="text-right font-mono">{formatWatts(b.sourceW)}</td>
                    <td className="text-right font-mono">{formatWatts(b.storageW)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Transient chart */}
      {chartOption && (
        <div className="h-44">
          <ReactECharts option={chartOption} style={{ height: '100%', width: '100%' }} notMerge />
        </div>
      )}
    </div>
  );
}
