//! Lumped-parameter thermal network solver (SINDA-style).
//!
//! Models heat flow between computation points (nodes) connected by
//! conductors, implementing the standard thermal-analysis formulation:
//!
//! - Heat conduction (Fourier's law) between nodes as linear conductors:
//!   `q = G·(Ti − Tj)` — the lumped form of `q = −k∇T` (G = kA/L, or hA for
//!   convection film conductors).
//! - Radiation exchange between surfaces as radiative conductors:
//!   `q = σ·(εFA)·(Ti⁴ − Tj⁴)` with temperatures in Kelvin.
//! - Transient heat diffusion in lumped form:
//!   `m·cp · dTi/dt = Σ_j q_ji + Q_i(t, T)` — the nodal form of
//!   `ρcp ∂T/∂t = ∇·(k∇T) + q'''`.
//! - Surface heat balance at every node: conduction, convection (linear
//!   conductor to a boundary), radiation and source (solar/heater/electrical)
//!   flows are reported per node so `Σ q_cond = q_conv + q_rad + q_solar` can
//!   be inspected directly.
//!
//! Node kinds: `diffusion` (has thermal mass m·cp), `arithmetic` (massless,
//! instantaneous balance), `boundary` (prescribed temperature, e.g. ambient).
//! m·cp, conductances, sources and boundary temperatures may be constant,
//! vary with time, or vary with temperature (piecewise-linear tables) — i.e.
//! "arbitrarily user modified".
//!
//! Solver: Newton iteration with radiative linearization
//! (`G_rad = σεFA·(Ti²+Tj²)(Ti+Tj)`) around a dense LU factorization;
//! backward Euler for transients (unconditionally stable, so stiff radiative
//! networks converge with large steps).

use serde::{Deserialize, Serialize};

/// Stefan–Boltzmann constant (W·m⁻²·K⁻⁴)
pub const SIGMA: f64 = 5.670374419e-8;
const KELVIN: f64 = 273.15;

/// A property value: constant, or piecewise-linear in time or temperature.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum PropValue {
    #[serde(rename_all = "camelCase")]
    Constant { value: f64 },
    /// Piecewise-linear vs. time in seconds. Clamped at the ends.
    #[serde(rename_all = "camelCase")]
    TimeTable { points: Vec<(f64, f64)> },
    /// Piecewise-linear vs. node temperature in °C. Clamped at the ends.
    /// For conductors the mean of the two endpoint temperatures is used.
    #[serde(rename_all = "camelCase")]
    TempTable { points: Vec<(f64, f64)> },
}

impl PropValue {
    /// Evaluate at time `t` (s) and temperature `temp_c` (°C).
    pub fn eval(&self, t: f64, temp_c: f64) -> f64 {
        match self {
            PropValue::Constant { value } => *value,
            PropValue::TimeTable { points } => interp(points, t),
            PropValue::TempTable { points } => interp(points, temp_c),
        }
    }
}

fn interp(points: &[(f64, f64)], x: f64) -> f64 {
    if points.is_empty() {
        return 0.0;
    }
    if points.len() == 1 || x <= points[0].0 {
        return points[0].1;
    }
    let last = points[points.len() - 1];
    if x >= last.0 {
        return last.1;
    }
    for w in points.windows(2) {
        let (x0, y0) = w[0];
        let (x1, y1) = w[1];
        if x >= x0 && x <= x1 {
            let f = if x1 > x0 { (x - x0) / (x1 - x0) } else { 0.0 };
            return y0 + (y1 - y0) * f;
        }
    }
    last.1
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    /// Node with thermal mass (m·cp > 0).
    Diffusion,
    /// Massless node — instantaneous heat balance.
    Arithmetic,
    /// Prescribed-temperature node (e.g. ambient). May vary with time.
    Boundary,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NetworkNode {
    pub id: String,
    #[serde(default)]
    pub label: String,
    /// Position on the thermal image (pixel coordinates) — UI only.
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    pub kind: NodeKind,
    /// Initial temperature (diffusion/arithmetic) or prescribed temperature
    /// fallback (boundary), in °C.
    pub initial_temp_c: f64,
    /// m·cp in J/K (diffusion nodes). May vary with time or temperature.
    #[serde(default)]
    pub mcp: Option<PropValue>,
    /// Applied source in W (heater, electrical dissipation, solar/environmental
    /// backloading…). May vary with time or temperature.
    #[serde(default)]
    pub source: Option<PropValue>,
    /// Prescribed temperature (°C) for boundary nodes; falls back to
    /// `initial_temp_c` when absent.
    #[serde(default)]
    pub boundary_temp_c: Option<PropValue>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ConductorKind {
    /// Linear conductor `q = G·(Ti − Tj)` — conduction (kA/L) or convection (hA).
    Linear,
    /// Radiative conductor `q = σ·(εFA)·(Ti⁴ − Tj⁴)` (T in Kelvin);
    /// `value` is the εFA product in m².
    Radiative,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Conductor {
    pub id: String,
    #[serde(default)]
    pub label: String,
    pub from: String,
    pub to: String,
    pub kind: ConductorKind,
    /// Linear: G in W/K. Radiative: εFA in m². May vary with time/temperature.
    pub value: PropValue,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThermalNetwork {
    pub nodes: Vec<NetworkNode>,
    pub conductors: Vec<Conductor>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SolveOptions {
    /// "steady" or "transient"
    pub mode: String,
    /// Transient duration in seconds.
    #[serde(default)]
    pub duration_s: Option<f64>,
    /// Transient time step in seconds (auto when absent).
    #[serde(default)]
    pub time_step_s: Option<f64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConductorFlow {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: ConductorKind,
    /// Heat flow in W, positive from `from` → `to`.
    pub q: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NodeBalance {
    pub id: String,
    /// Net inflow through linear conductors (W).
    pub linear_in_w: f64,
    /// Net inflow through radiative conductors (W).
    pub radiative_in_w: f64,
    /// Applied source (W).
    pub source_w: f64,
    /// Energy storage rate m·cp·dT/dt (W); ~0 at steady state.
    pub storage_w: f64,
    /// Final temperature (°C).
    pub temp_c: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SolveResult {
    pub mode: String,
    pub converged: bool,
    pub iterations: u32,
    pub node_ids: Vec<String>,
    /// Sampled times (s). Single entry `[0]` for steady solves.
    pub times: Vec<f64>,
    /// temps[node_index][time_index] in °C.
    pub temps: Vec<Vec<f64>>,
    /// Heat flows at the final state.
    pub flows: Vec<ConductorFlow>,
    /// Per-node surface heat balance at the final state.
    pub balances: Vec<NodeBalance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

const MAX_NODES: usize = 400;
const MAX_NEWTON_ITERS: u32 = 200;
const NEWTON_TOL_K: f64 = 1e-6;
const MAX_TIME_STEPS: usize = 200_000;
const MAX_SAMPLES: usize = 400;

struct Prepared<'a> {
    net: &'a ThermalNetwork,
    /// Index into `net.nodes` for every node id.
    unknowns: Vec<usize>,
    /// unknown index by node index (usize::MAX for boundaries).
    unknown_of: Vec<usize>,
    /// (from_idx, to_idx) per conductor.
    ends: Vec<(usize, usize)>,
}

fn prepare(net: &ThermalNetwork) -> Result<Prepared<'_>, String> {
    if net.nodes.is_empty() {
        return Err("Network has no nodes".into());
    }
    if net.nodes.len() > MAX_NODES {
        return Err(format!("Network exceeds {MAX_NODES} nodes"));
    }
    let idx_of = |id: &str| net.nodes.iter().position(|n| n.id == id);
    {
        let mut seen = std::collections::HashSet::new();
        for n in &net.nodes {
            if !seen.insert(n.id.as_str()) {
                return Err(format!("Duplicate node id '{}'", n.id));
            }
        }
    }
    let mut ends = Vec::with_capacity(net.conductors.len());
    for c in &net.conductors {
        let a = idx_of(&c.from).ok_or_else(|| format!("Conductor '{}': unknown node '{}'", c.id, c.from))?;
        let b = idx_of(&c.to).ok_or_else(|| format!("Conductor '{}': unknown node '{}'", c.id, c.to))?;
        if a == b {
            return Err(format!("Conductor '{}' connects node '{}' to itself", c.id, c.from));
        }
        ends.push((a, b));
    }
    let mut unknowns = Vec::new();
    let mut unknown_of = vec![usize::MAX; net.nodes.len()];
    for (i, n) in net.nodes.iter().enumerate() {
        if n.kind != NodeKind::Boundary {
            // A solved node with no conductors has an indeterminate
            // temperature — reject it with a clear message up front.
            if !ends.iter().any(|&(a, b)| a == i || b == i) {
                return Err(format!("Node '{}' has no conductors attached", n.id));
            }
            unknown_of[i] = unknowns.len();
            unknowns.push(i);
        }
    }
    if unknowns.is_empty() {
        return Err("Network has no non-boundary nodes to solve".into());
    }
    Ok(Prepared { net, unknowns, unknown_of, ends })
}

/// Solve `A·x = b` in place with partial pivoting. `a` is row-major n×n.
fn lu_solve(a: &mut [f64], b: &mut [f64], n: usize) -> Result<(), String> {
    for col in 0..n {
        // Pivot
        let mut piv = col;
        let mut max = a[col * n + col].abs();
        for r in (col + 1)..n {
            let v = a[r * n + col].abs();
            if v > max {
                max = v;
                piv = r;
            }
        }
        if max < 1e-300 {
            return Err("Singular system — check for nodes without any conductor".into());
        }
        if piv != col {
            for k in 0..n {
                a.swap(col * n + k, piv * n + k);
            }
            b.swap(col, piv);
        }
        let d = a[col * n + col];
        for r in (col + 1)..n {
            let f = a[r * n + col] / d;
            if f == 0.0 {
                continue;
            }
            a[r * n + col] = 0.0;
            for k in (col + 1)..n {
                a[r * n + k] -= f * a[col * n + k];
            }
            b[r] -= f * b[col];
        }
    }
    for r in (0..n).rev() {
        let mut acc = b[r];
        for k in (r + 1)..n {
            acc -= a[r * n + k] * b[k];
        }
        b[r] = acc / a[r * n + r];
    }
    Ok(())
}

/// Largest temperature update applied in one Newton iteration (K). Limits
/// overshoot on strongly nonlinear (radiative, source-driven) networks.
const MAX_NEWTON_STEP_K: f64 = 150.0;
/// Residual norm (W) below which the balance is considered satisfied.
const NEWTON_TOL_W: f64 = 1e-9;

/// Numeric derivative of a temp-table property w.r.t. temperature (0 for
/// constant / time-table properties).
fn eval_temp_deriv(p: &PropValue, temp_c: f64) -> f64 {
    match p {
        PropValue::TempTable { points } => {
            let h = 0.05;
            (interp(points, temp_c + h) - interp(points, temp_c - h)) / (2.0 * h)
        }
        _ => 0.0,
    }
}

/// Build the residual F (and optionally the Jacobian) of the nodal balance
/// at time `t`: F_i = C/dt·(Ti − Ti_prev) − Σ q_in_i − Q_i (driven to 0).
/// Temperature-dependent sources and conductances contribute their d/dT
/// terms to the Jacobian so steep tables converge instead of limit-cycling.
fn build_system(
    p: &Prepared,
    t: f64,
    temps_k: &[f64],
    cap_over_dt: &[f64],
    prev_k: &[f64],
    resid: &mut [f64],
    mut jac: Option<&mut [f64]>,
) {
    let n = p.unknowns.len();
    resid.iter_mut().for_each(|v| *v = 0.0);
    if let Some(j) = jac.as_deref_mut() {
        j.iter_mut().for_each(|v| *v = 0.0);
    }

    for (ui, &ni) in p.unknowns.iter().enumerate() {
        let c_dt = cap_over_dt[ui];
        resid[ui] += c_dt * (temps_k[ni] - prev_k[ni]);
        if let Some(j) = jac.as_deref_mut() {
            j[ui * n + ui] += c_dt;
        }
        if let Some(src) = &p.net.nodes[ni].source {
            let temp_c = temps_k[ni] - KELVIN;
            resid[ui] -= src.eval(t, temp_c);
            if let Some(j) = jac.as_deref_mut() {
                // ∂F/∂T = −dQ/dT
                j[ui * n + ui] -= eval_temp_deriv(src, temp_c);
            }
        }
    }

    for (ci, c) in p.net.conductors.iter().enumerate() {
        let (i, j_n) = p.ends[ci];
        let (ti, tj) = (temps_k[i], temps_k[j_n]);
        let mean_c = (ti + tj) / 2.0 - KELVIN;
        let raw = c.value.eval(t, mean_c);
        let value = raw.max(0.0);
        // Table derivative w.r.t. the mean temperature (each endpoint sees ½).
        let dval = if raw > 0.0 { eval_temp_deriv(&c.value, mean_c) } else { 0.0 };
        let (ui, uj) = (p.unknown_of[i], p.unknown_of[j_n]);

        // q = flow from i → j; a = ∂q/∂Ti, b = ∂q/∂Tj
        let (q_ij, a, b) = match c.kind {
            ConductorKind::Linear => {
                let dt_ij = ti - tj;
                (
                    value * dt_ij,
                    value + 0.5 * dval * dt_ij,
                    -value + 0.5 * dval * dt_ij,
                )
            }
            ConductorKind::Radiative => {
                let pot = ti.powi(4) - tj.powi(4);
                (
                    SIGMA * value * pot,
                    SIGMA * (4.0 * value * ti.powi(3) + 0.5 * dval * pot),
                    SIGMA * (-4.0 * value * tj.powi(3) + 0.5 * dval * pot),
                )
            }
        };

        if ui != usize::MAX {
            resid[ui] += q_ij;
            if let Some(jm) = jac.as_deref_mut() {
                jm[ui * n + ui] += a;
                if uj != usize::MAX {
                    jm[ui * n + uj] += b;
                }
            }
        }
        if uj != usize::MAX {
            resid[uj] -= q_ij;
            if let Some(jm) = jac.as_deref_mut() {
                jm[uj * n + uj] -= b;
                if ui != usize::MAX {
                    jm[uj * n + ui] -= a;
                }
            }
        }
    }
}

fn max_abs(v: &[f64]) -> f64 {
    v.iter().fold(0.0f64, |m, x| m.max(x.abs()))
}

/// One Newton solve of the (possibly capacitive) balance at time `t`, with a
/// backtracking line search on the residual norm for global robustness.
/// `temps_k` holds all node temps (Kelvin) and is updated in place with the
/// converged result. `cap_over_dt[ui]` is C/dt per unknown (0 for steady and
/// arithmetic nodes); `prev_k` the previous-step temperatures.
fn newton_solve(
    p: &Prepared,
    t: f64,
    temps_k: &mut [f64],
    cap_over_dt: &[f64],
    prev_k: &[f64],
) -> Result<u32, String> {
    let n = p.unknowns.len();
    let mut jac = vec![0.0f64; n * n];
    let mut resid = vec![0.0f64; n];
    let mut trial_resid = vec![0.0f64; n];
    let mut backup = vec![0.0f64; n];

    for iter in 1..=MAX_NEWTON_ITERS {
        build_system(p, t, temps_k, cap_over_dt, prev_k, &mut resid, Some(&mut jac));
        let norm0 = max_abs(&resid);
        if norm0 < NEWTON_TOL_W {
            return Ok(iter);
        }

        // Solve J·d = −F
        let mut delta: Vec<f64> = resid.iter().map(|r| -r).collect();
        let mut jac_work = jac.clone();
        lu_solve(&mut jac_work, &mut delta, n)?;

        let max_d = max_abs(&delta);
        if !max_d.is_finite() {
            return Err("Solver diverged (non-finite temperature)".into());
        }
        // Limit the raw step to keep the quartic terms from overshooting
        let scale = if max_d > MAX_NEWTON_STEP_K {
            MAX_NEWTON_STEP_K / max_d
        } else {
            1.0
        };

        // Backtracking line search: accept the largest step that reduces |F|
        for (ui, &ni) in p.unknowns.iter().enumerate() {
            backup[ui] = temps_k[ni];
        }
        let mut lambda = 1.0f64;
        let mut best_norm = f64::INFINITY;
        for _ in 0..10 {
            for (ui, &ni) in p.unknowns.iter().enumerate() {
                temps_k[ni] = (backup[ui] + lambda * scale * delta[ui]).max(1.0);
            }
            build_system(p, t, temps_k, cap_over_dt, prev_k, &mut trial_resid, None);
            best_norm = max_abs(&trial_resid);
            if best_norm < norm0 {
                break;
            }
            lambda *= 0.5;
        }
        // (If no λ improved, the smallest step is kept — progress next round.)

        if max_d < NEWTON_TOL_K || best_norm < NEWTON_TOL_W {
            return Ok(iter);
        }
    }
    Err(format!(
        "Newton iteration did not converge within {MAX_NEWTON_ITERS} iterations"
    ))
}

fn boundary_temp_k(node: &NetworkNode, t: f64) -> f64 {
    match &node.boundary_temp_c {
        Some(p) => p.eval(t, node.initial_temp_c) + KELVIN,
        None => node.initial_temp_c + KELVIN,
    }
}

/// Compute final per-conductor flows and per-node balances (units W, temps K).
fn finalize(
    p: &Prepared,
    t: f64,
    temps_k: &[f64],
    storage_w: &[f64],
) -> (Vec<ConductorFlow>, Vec<NodeBalance>) {
    let mut flows = Vec::with_capacity(p.net.conductors.len());
    let mut linear_in = vec![0.0f64; p.net.nodes.len()];
    let mut rad_in = vec![0.0f64; p.net.nodes.len()];

    for (ci, c) in p.net.conductors.iter().enumerate() {
        let (i, j) = p.ends[ci];
        let mean_c = (temps_k[i] + temps_k[j]) / 2.0 - KELVIN;
        let value = c.value.eval(t, mean_c);
        let q = match c.kind {
            ConductorKind::Linear => value.max(0.0) * (temps_k[i] - temps_k[j]),
            ConductorKind::Radiative => {
                value.max(0.0) * SIGMA * (temps_k[i].powi(4) - temps_k[j].powi(4))
            }
        };
        match c.kind {
            ConductorKind::Linear => {
                linear_in[i] -= q;
                linear_in[j] += q;
            }
            ConductorKind::Radiative => {
                rad_in[i] -= q;
                rad_in[j] += q;
            }
        }
        flows.push(ConductorFlow {
            id: c.id.clone(),
            from: c.from.clone(),
            to: c.to.clone(),
            kind: c.kind.clone(),
            q,
        });
    }

    let balances = p
        .net
        .nodes
        .iter()
        .enumerate()
        .map(|(i, node)| NodeBalance {
            id: node.id.clone(),
            linear_in_w: linear_in[i],
            radiative_in_w: rad_in[i],
            source_w: node
                .source
                .as_ref()
                .map(|s| s.eval(t, temps_k[i] - KELVIN))
                .unwrap_or(0.0),
            storage_w: storage_w[i],
            temp_c: temps_k[i] - KELVIN,
        })
        .collect();

    (flows, balances)
}

/// Solve the network. All exchange with the caller is in °C / seconds / W.
pub fn solve(net: &ThermalNetwork, opts: &SolveOptions) -> Result<SolveResult, String> {
    let p = prepare(net)?;
    let node_ids: Vec<String> = net.nodes.iter().map(|n| n.id.clone()).collect();

    // Initial state (Kelvin)
    let mut temps_k: Vec<f64> = net
        .nodes
        .iter()
        .map(|n| match n.kind {
            NodeKind::Boundary => boundary_temp_k(n, 0.0),
            _ => n.initial_temp_c + KELVIN,
        })
        .collect();
    for t in &temps_k {
        if *t <= 0.0 {
            return Err("Temperatures below 0 K are not physical — check initial/boundary values".into());
        }
    }

    if opts.mode == "steady" {
        let cap_over_dt = vec![0.0f64; p.unknowns.len()];
        let prev_k = temps_k.clone();
        let iters = newton_solve(&p, 0.0, &mut temps_k, &cap_over_dt, &prev_k)?;
        let storage = vec![0.0f64; net.nodes.len()];
        let (flows, balances) = finalize(&p, 0.0, &temps_k, &storage);
        return Ok(SolveResult {
            mode: "steady".into(),
            converged: true,
            iterations: iters,
            node_ids,
            times: vec![0.0],
            temps: net
                .nodes
                .iter()
                .enumerate()
                .map(|(i, _)| vec![temps_k[i] - KELVIN])
                .collect(),
            flows,
            balances,
            warning: None,
        });
    }

    // ---- Transient ----
    let duration = opts.duration_s.unwrap_or(600.0);
    if !(duration > 0.0) || !duration.is_finite() {
        return Err("Transient duration must be positive".into());
    }
    let dt = opts
        .time_step_s
        .filter(|v| *v > 0.0 && v.is_finite())
        .unwrap_or(duration / 200.0);
    let steps = (duration / dt).ceil() as usize;
    if steps > MAX_TIME_STEPS {
        return Err(format!(
            "Too many time steps ({steps} > {MAX_TIME_STEPS}) — increase the time step"
        ));
    }
    // Diffusion nodes need positive mCp for a well-posed transient.
    for &ni in &p.unknowns {
        let node = &net.nodes[ni];
        if node.kind == NodeKind::Diffusion {
            let mcp0 = node
                .mcp
                .as_ref()
                .map(|m| m.eval(0.0, node.initial_temp_c))
                .unwrap_or(0.0);
            if mcp0 <= 0.0 {
                return Err(format!(
                    "Diffusion node '{}' needs a positive m·cp for transient solves (or make it arithmetic)",
                    node.id
                ));
            }
        }
    }

    // Settle arithmetic (massless) nodes at t=0 so the first sample reflects
    // an actual balance instead of the user's initial guesses. Diffusion and
    // boundary nodes hold their initial temperatures for this pre-solve.
    let arith: Vec<usize> = net
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.kind == NodeKind::Arithmetic)
        .map(|(i, _)| i)
        .collect();
    if !arith.is_empty() {
        let mut unknown_of0 = vec![usize::MAX; net.nodes.len()];
        for (k, &ni) in arith.iter().enumerate() {
            unknown_of0[ni] = k;
        }
        let p0 = Prepared {
            net,
            unknowns: arith.clone(),
            unknown_of: unknown_of0,
            ends: p.ends.clone(),
        };
        let zeros = vec![0.0f64; arith.len()];
        let prev0 = temps_k.clone();
        newton_solve(&p0, 0.0, &mut temps_k, &zeros, &prev0)
            .map_err(|e| format!("Initial balance of massless nodes failed: {e}"))?;
    }

    let sample_every = (steps / MAX_SAMPLES).max(1);
    let mut times = vec![0.0f64];
    let mut temps_series: Vec<Vec<f64>> = net
        .nodes
        .iter()
        .enumerate()
        .map(|(i, _)| vec![temps_k[i] - KELVIN])
        .collect();

    let mut total_iters = 0u32;
    let mut warning: Option<String> = None;
    let mut prev_k = temps_k.clone();
    let mut last_storage = vec![0.0f64; net.nodes.len()];
    // Time of the last successfully converged step — flows/balances and the
    // final sample must all describe this state, never a failed iterate.
    let mut t_prev = 0.0f64;

    'march: for step in 1..=steps {
        let t = (step as f64 * dt).min(duration);
        let dt_eff = t - (step - 1) as f64 * dt;
        if dt_eff <= 0.0 {
            break;
        }

        // Prescribed boundary temperatures at t
        for (i, n) in net.nodes.iter().enumerate() {
            if n.kind == NodeKind::Boundary {
                let bt = boundary_temp_k(n, t);
                if bt <= 0.0 {
                    warning = Some(format!(
                        "Stopped at t={t:.1}s: boundary '{}' temperature table went below 0 K",
                        n.id
                    ));
                    temps_k.copy_from_slice(&prev_k);
                    break 'march;
                }
                temps_k[i] = bt;
            }
        }

        // C/dt per unknown, evaluated at previous temperatures. A table that
        // drives m·cp non-positive mid-run is an error, not something to clamp.
        let mut cap_over_dt = vec![0.0f64; p.unknowns.len()];
        for (ui, &ni) in p.unknowns.iter().enumerate() {
            let node = &net.nodes[ni];
            if node.kind == NodeKind::Diffusion {
                let mcp = node
                    .mcp
                    .as_ref()
                    .map(|m| m.eval(t, prev_k[ni] - KELVIN))
                    .unwrap_or(0.0);
                if mcp <= 0.0 {
                    warning = Some(format!(
                        "Stopped at t={t:.1}s: node '{}' m·cp table went non-positive",
                        node.id
                    ));
                    temps_k.copy_from_slice(&prev_k);
                    break 'march;
                }
                cap_over_dt[ui] = mcp / dt_eff;
            }
        }

        match newton_solve(&p, t, &mut temps_k, &cap_over_dt, &prev_k) {
            Ok(iters) => total_iters += iters,
            Err(e) => {
                warning = Some(format!("Stopped at t={t:.1}s: {e}"));
                // Roll back to the last converged state so the reported
                // flows/balances/final sample are real numbers, not a
                // half-diverged iterate.
                temps_k.copy_from_slice(&prev_k);
                break;
            }
        }

        t_prev = t;
        for (ui, &ni) in p.unknowns.iter().enumerate() {
            last_storage[ni] = cap_over_dt[ui] * (temps_k[ni] - prev_k[ni]);
        }
        prev_k.copy_from_slice(&temps_k);

        if step % sample_every == 0 || step == steps {
            times.push(t);
            for (i, series) in temps_series.iter_mut().enumerate() {
                series.push(temps_k[i] - KELVIN);
            }
        }
    }

    // On early termination, make sure the series ends at the state we report.
    if warning.is_some() && times.last().copied() != Some(t_prev) {
        times.push(t_prev);
        for (i, series) in temps_series.iter_mut().enumerate() {
            series.push(temps_k[i] - KELVIN);
        }
    }

    let t_final = if warning.is_some() { t_prev } else { *times.last().unwrap_or(&0.0) };
    let (flows, balances) = finalize(&p, t_final, &temps_k, &last_storage);
    Ok(SolveResult {
        mode: "transient".into(),
        converged: warning.is_none(),
        iterations: total_iters,
        node_ids,
        times,
        temps: temps_series,
        flows,
        balances,
        warning,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn constant(v: f64) -> PropValue {
        PropValue::Constant { value: v }
    }

    fn node(id: &str, kind: NodeKind, t0: f64) -> NetworkNode {
        NetworkNode {
            id: id.into(),
            label: String::new(),
            x: 0.0,
            y: 0.0,
            kind,
            initial_temp_c: t0,
            mcp: None,
            source: None,
            boundary_temp_c: None,
        }
    }

    fn cond(id: &str, from: &str, to: &str, kind: ConductorKind, v: f64) -> Conductor {
        Conductor {
            id: id.into(),
            label: String::new(),
            from: from.into(),
            to: to.into(),
            kind,
            value: constant(v),
        }
    }

    #[test]
    fn steady_conduction_with_source() {
        // Boundary 100 °C — G=2 W/K — node with 50 W source → T = 125 °C
        let mut n2 = node("n2", NodeKind::Arithmetic, 20.0);
        n2.source = Some(constant(50.0));
        let net = ThermalNetwork {
            nodes: vec![node("b", NodeKind::Boundary, 100.0), n2],
            conductors: vec![cond("g", "b", "n2", ConductorKind::Linear, 2.0)],
        };
        let r = solve(&net, &SolveOptions { mode: "steady".into(), duration_s: None, time_step_s: None }).unwrap();
        let t2 = r.balances.iter().find(|b| b.id == "n2").unwrap().temp_c;
        assert!((t2 - 125.0).abs() < 1e-6, "T2 = {t2}");
        // Flow from boundary into node = -50 W (i.e. 50 W flows node → boundary)
        let q = r.flows[0].q;
        assert!((q + 50.0).abs() < 1e-6, "q = {q}");
    }

    #[test]
    fn arithmetic_node_weighted_average() {
        // 0 °C —G1=1— X —G2=3— 100 °C → X = 75 °C
        let net = ThermalNetwork {
            nodes: vec![
                node("a", NodeKind::Boundary, 0.0),
                node("x", NodeKind::Arithmetic, 50.0),
                node("b", NodeKind::Boundary, 100.0),
            ],
            conductors: vec![
                cond("g1", "a", "x", ConductorKind::Linear, 1.0),
                cond("g2", "x", "b", ConductorKind::Linear, 3.0),
            ],
        };
        let r = solve(&net, &SolveOptions { mode: "steady".into(), duration_s: None, time_step_s: None }).unwrap();
        let tx = r.balances.iter().find(|b| b.id == "x").unwrap().temp_c;
        assert!((tx - 75.0).abs() < 1e-6, "Tx = {tx}");
    }

    #[test]
    fn rc_transient_decay() {
        // mCp = 100 J/K, G = 10 W/K to 0 °C boundary, T0 = 100 °C, τ = 10 s.
        // T(30 s) = 100·e⁻³ ≈ 4.9787 °C (backward Euler slightly overdamps).
        let mut hot = node("hot", NodeKind::Diffusion, 100.0);
        hot.mcp = Some(constant(100.0));
        let net = ThermalNetwork {
            nodes: vec![hot, node("amb", NodeKind::Boundary, 0.0)],
            conductors: vec![cond("g", "hot", "amb", ConductorKind::Linear, 10.0)],
        };
        let r = solve(
            &net,
            &SolveOptions { mode: "transient".into(), duration_s: Some(30.0), time_step_s: Some(0.01) },
        )
        .unwrap();
        assert!(r.converged);
        let series = &r.temps[0];
        let t_final = *series.last().unwrap();
        let analytic = 100.0 * (-3.0f64).exp();
        assert!(
            (t_final - analytic).abs() < 0.1,
            "T(30) = {t_final}, analytic {analytic}"
        );
    }

    #[test]
    fn radiative_equilibrium() {
        // Node with 10 W source radiating (εFA = 1e-3 m²) to 300 K space:
        // T = (300⁴ + Q/(σ·εFA))^(1/4)
        let mut hot = node("hot", NodeKind::Arithmetic, 20.0);
        hot.source = Some(constant(10.0));
        let net = ThermalNetwork {
            nodes: vec![hot, node("space", NodeKind::Boundary, 300.0 - 273.15)],
            conductors: vec![cond("r", "hot", "space", ConductorKind::Radiative, 1e-3)],
        };
        let r = solve(&net, &SolveOptions { mode: "steady".into(), duration_s: None, time_step_s: None }).unwrap();
        let t_hot_k = r.balances.iter().find(|b| b.id == "hot").unwrap().temp_c + 273.15;
        let expected_k = (300.0f64.powi(4) + 10.0 / (SIGMA * 1e-3)).powf(0.25);
        assert!(
            (t_hot_k - expected_k).abs() < 0.01,
            "T = {t_hot_k} K, expected {expected_k} K"
        );
        // Balance check: radiative outflow ≈ source
        let bal = r.balances.iter().find(|b| b.id == "hot").unwrap();
        assert!((bal.radiative_in_w + bal.source_w).abs() < 1e-6);
    }

    #[test]
    fn time_varying_boundary_and_table_interp() {
        assert_eq!(interp(&[(0.0, 1.0), (10.0, 3.0)], 5.0), 2.0);
        assert_eq!(interp(&[(0.0, 1.0), (10.0, 3.0)], -5.0), 1.0);
        assert_eq!(interp(&[(0.0, 1.0), (10.0, 3.0)], 20.0), 3.0);

        // Boundary ramps 0→100 °C over 100 s; small mCp tracks it closely.
        let mut nb = node("amb", NodeKind::Boundary, 0.0);
        nb.boundary_temp_c = Some(PropValue::TimeTable { points: vec![(0.0, 0.0), (100.0, 100.0)] });
        let mut m = node("m", NodeKind::Diffusion, 0.0);
        m.mcp = Some(constant(1.0));
        let net = ThermalNetwork {
            nodes: vec![m, nb],
            conductors: vec![cond("g", "m", "amb", ConductorKind::Linear, 10.0)],
        };
        let r = solve(
            &net,
            &SolveOptions { mode: "transient".into(), duration_s: Some(100.0), time_step_s: Some(0.05) },
        )
        .unwrap();
        let t_final = *r.temps[0].last().unwrap();
        // Lag ≈ rate·τ = 1 °C/s · 0.1 s = 0.1 °C
        assert!((t_final - 99.9).abs() < 0.05, "T = {t_final}");
    }

    #[test]
    fn temperature_varying_conductance() {
        // G doubles from 1 → 2 W/K between 0 and 100 °C (mean temp 50 → G=1.5):
        // boundaries 0 / 100, arithmetic node in the middle with equal tables
        // stays at 50 by symmetry; check solve converges and flow uses G(50)=1.5.
        let g_table = PropValue::TempTable { points: vec![(0.0, 1.0), (100.0, 2.0)] };
        let net = ThermalNetwork {
            nodes: vec![
                node("a", NodeKind::Boundary, 0.0),
                node("x", NodeKind::Arithmetic, 20.0),
                node("b", NodeKind::Boundary, 100.0),
            ],
            conductors: vec![
                Conductor { id: "g1".into(), label: String::new(), from: "a".into(), to: "x".into(), kind: ConductorKind::Linear, value: g_table.clone() },
                Conductor { id: "g2".into(), label: String::new(), from: "x".into(), to: "b".into(), kind: ConductorKind::Linear, value: g_table },
            ],
        };
        let r = solve(&net, &SolveOptions { mode: "steady".into(), duration_s: None, time_step_s: None }).unwrap();
        let tx = r.balances.iter().find(|b| b.id == "x").unwrap().temp_c;
        // Self-consistent solution with G evaluated at each leg's mean temp:
        // G1 = 1 + T/200, G2 = 1.5 + T/200; balance −T·G1 + (100−T)·G2 = 0
        // → T² + 200T − 15000 = 0 → T = (−200 + √100000)/2 ≈ 58.1139
        let analytic = (-200.0 + 100000.0f64.sqrt()) / 2.0;
        assert!((tx - analytic).abs() < 1e-3, "Tx = {tx}, analytic {analytic}");
    }

    #[test]
    fn steep_thermostat_source_converges() {
        // Thermostat: 500 W below 20 °C ramping to 0 W at 20.5 °C
        // (dQ/dT = −1000 W/K) with G = 1 W/K to a 0 °C boundary.
        // Analytic equilibrium inside the band: 1001·T = 20500.
        // Regression: frozen-Jacobian iteration limit-cycles forever here.
        let mut x = node("x", NodeKind::Arithmetic, 0.0);
        x.source = Some(PropValue::TempTable { points: vec![(20.0, 500.0), (20.5, 0.0)] });
        let net = ThermalNetwork {
            nodes: vec![x, node("amb", NodeKind::Boundary, 0.0)],
            conductors: vec![cond("g", "x", "amb", ConductorKind::Linear, 1.0)],
        };
        let r = solve(&net, &SolveOptions { mode: "steady".into(), duration_s: None, time_step_s: None }).unwrap();
        let tx = r.balances.iter().find(|b| b.id == "x").unwrap().temp_c;
        let analytic = 20500.0 / 1001.0;
        assert!((tx - analytic).abs() < 1e-3, "T = {tx}, analytic {analytic}");
    }

    #[test]
    fn transient_stops_cleanly_on_bad_mcp_table() {
        // m·cp table goes non-positive at t ≈ 45 s: the solve must stop with a
        // warning, and the reported final state must be the last CONVERGED
        // step — series, balances and flows all describing the same instant.
        let mut m = node("m", NodeKind::Diffusion, 50.0);
        m.mcp = Some(PropValue::TimeTable { points: vec![(0.0, 100.0), (50.0, -10.0)] });
        let net = ThermalNetwork {
            nodes: vec![m, node("amb", NodeKind::Boundary, 0.0)],
            conductors: vec![cond("g", "m", "amb", ConductorKind::Linear, 5.0)],
        };
        let r = solve(
            &net,
            &SolveOptions { mode: "transient".into(), duration_s: Some(100.0), time_step_s: Some(1.0) },
        )
        .unwrap();
        assert!(!r.converged);
        assert!(r.warning.is_some());
        let last_t = *r.times.last().unwrap();
        assert!(last_t < 100.0, "stopped early, got t = {last_t}");
        let m_bal = r.balances.iter().find(|b| b.id == "m").unwrap();
        assert!(m_bal.temp_c > -100.0 && m_bal.temp_c < 60.0, "T = {}", m_bal.temp_c);
        // Final sample must equal the state the balances describe
        assert!((r.temps[0].last().unwrap() - m_bal.temp_c).abs() < 1e-9);
    }

    #[test]
    fn transient_t0_settles_arithmetic_nodes() {
        // Arithmetic node between 0 and 100 °C boundaries with a wild initial
        // guess: the t=0 sample must already be the balanced 50 °C, not 500.
        let net = ThermalNetwork {
            nodes: vec![
                node("a", NodeKind::Boundary, 0.0),
                node("x", NodeKind::Arithmetic, 500.0),
                node("b", NodeKind::Boundary, 100.0),
            ],
            conductors: vec![
                cond("g1", "a", "x", ConductorKind::Linear, 1.0),
                cond("g2", "x", "b", ConductorKind::Linear, 1.0),
            ],
        };
        let r = solve(
            &net,
            &SolveOptions { mode: "transient".into(), duration_s: Some(10.0), time_step_s: Some(1.0) },
        )
        .unwrap();
        assert!((r.temps[1][0] - 50.0).abs() < 1e-3, "t=0 sample = {}", r.temps[1][0]);
    }

    #[test]
    fn rejects_bad_networks() {
        // No nodes
        assert!(solve(&ThermalNetwork { nodes: vec![], conductors: vec![] },
            &SolveOptions { mode: "steady".into(), duration_s: None, time_step_s: None }).is_err());
        // Unknown conductor endpoint
        let net = ThermalNetwork {
            nodes: vec![node("a", NodeKind::Arithmetic, 0.0)],
            conductors: vec![cond("g", "a", "missing", ConductorKind::Linear, 1.0)],
        };
        assert!(solve(&net, &SolveOptions { mode: "steady".into(), duration_s: None, time_step_s: None }).is_err());
        // Isolated node → singular
        let net = ThermalNetwork {
            nodes: vec![node("a", NodeKind::Arithmetic, 0.0), node("b", NodeKind::Boundary, 10.0)],
            conductors: vec![],
        };
        assert!(solve(&net, &SolveOptions { mode: "steady".into(), duration_s: None, time_step_s: None }).is_err());
    }
}
