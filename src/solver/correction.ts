import type { Mesh } from "../mesh/mesh";
import { buildReferenceMesh } from "../render/reference/refmesh";

/**
 * Correction-map solver (milestone 8): per-vertex `c_abs` (world units) and `c_rel`
 * (extrusion multiplier) that make the faceted shell reach past the smooth contour plus the
 * line width, from every view.
 *
 * Sampling is by surface point: every butterfly-refined vertex p (on the smooth surface) is
 * tested under views v perpendicular to its normal n, so p is on the contour and n is the
 * silhouette's outward direction on screen. For each (p, v) the solver measures the shell's
 * exact projected extent along n at p's position along the contour: the extruded nearby
 * triangles are projected onto the (t, n) plane, t = v x n, and cut by the line t = 0.
 *
 * The shell must reach s beyond p, where s is the line width in world units. The solve runs
 * at unit width (extrusion s(1 + c_rel) + c_abs), which bounds every painted width because
 * `wmax` is a maximum over each vertex's triangles; painting never makes it stale.
 *
 *   s = 0      : the faceting deficit, assigned to c_abs, divided by the projection N.n
 *   s > 0      : the remaining deficit relative to s, assigned to c_rel (worst of a few s)
 *
 * Each deficit goes to the two vertices of the shell edge that defines the extent, as the
 * maximum over all samples, and a few rounds let the extremal edge move.
 */

export interface SolverOptions {
  /** Butterfly levels for the sample points (2 gives about 8 per base triangle). */
  levels: number;
  /** Views per point, spread over half a turn of the tangent circle. */
  views: number;
  rounds: number;
  /** Final multiplier on both maps. */
  safety: number;
  /** Floor on N.n when converting an extent deficit into extrusion. */
  minProj: number;
}

export const SOLVER_DEFAULTS: SolverOptions = { levels: 2, views: 8, rounds: 4, safety: 1.05, minProj: 0.2 };

export interface CorrectionResult {
  cAbs: Float32Array<ArrayBuffer>;
  cRel: Float32Array<ArrayBuffer>;
  /** Point-view pairs tested per pass. */
  samples: number;
  /** Mean base edge length, the solver's length scale. */
  edge: number;
  /** Worst remaining deficit after the solve, over widths 0..edge, relative to `edge`. */
  residual: number;
  /** Fraction of point-view pairs that still have a deficit above 1e-3 * edge. */
  failing: number;
  /** `residual` per verified width: 0, edge/4, edge/2 and edge. */
  residualByWidth: number[];
  ms: number;
}

type V3 = [number, number, number];

interface Extent {
  ext: number;
  a: number;
  b: number;
}

export function solveCorrection(mesh: Mesh, options: Partial<SolverOptions> = {}): CorrectionResult {
  const opt = { ...SOLVER_DEFAULTS, ...options };
  const t0 = performance.now();
  const nv = mesh.vertCount;
  const P = mesh.positions;
  const N = mesh.normals;

  const ref = buildReferenceMesh(mesh, { levels: opt.levels, curvature: false });
  const rp = ref.mesh.positions;
  const rn = ref.mesh.normals;

  // base triangle per refined vertex, and each base triangle's neighbourhood (triangles
  // touching its corners), where the extent is searched
  const refParent = new Int32Array(ref.mesh.vertCount).fill(-1);
  for (let t = 0; t < ref.mesh.triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const v = ref.mesh.tris[t * 3 + k];
      if (refParent[v] < 0) refParent[v] = ref.parentTri[t];
    }
  }
  const hood = new Map<number, Int32Array>();
  const neighbourhood = (t: number) => {
    let h = hood.get(t);
    if (!h) {
      const set = new Set<number>();
      for (let k = 0; k < 3; k++) {
        const v = mesh.tris[t * 3 + k];
        for (let i = mesh.vertTriStart[v]; i < mesh.vertTriStart[v + 1]; i++) set.add(mesh.vertTris[i]);
      }
      h = Int32Array.from(set);
      hood.set(t, h);
    }
    return h;
  };

  let edgeSum = 0;
  for (let t = 0; t < mesh.triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = mesh.tris[t * 3 + k] * 3,
        b = mesh.tris[t * 3 + ((k + 1) % 3)] * 3;
      edgeSum += Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]);
    }
  }
  const edge = edgeSum / Math.max(1, mesh.triCount * 3);

  // per view: tangent-to-contour t and outward n, precomputed per sample
  const samples: { p: V3; n: V3; ts: V3[]; tri: number }[] = [];
  for (let v = 0; v < ref.mesh.vertCount; v++) {
    if (refParent[v] < 0) continue;
    const n: V3 = [rn[v * 3], rn[v * 3 + 1], rn[v * 3 + 2]];
    const a: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const b1 = normalize(sub(a, scale(n, dot(a, n))));
    const b2 = cross(n, b1);
    const ts: V3[] = [];
    for (let k = 0; k < opt.views; k++) {
      const ang = (Math.PI * k) / opt.views;
      // t = v x n with v = cos b1 + sin b2: t stays in the tangent plane, a quarter turn on
      ts.push(add(scale(b1, -Math.sin(ang)), scale(b2, Math.cos(ang))));
    }
    samples.push({ p: [rp[v * 3], rp[v * 3 + 1], rp[v * 3 + 2]], n, ts, tri: refParent[v] });
  }

  const cAbs = new Float64Array(nv);
  const cRel = new Float64Array(nv);
  const X = new Float64Array(nv * 3);
  const placeShell = (s: number) => {
    for (let v = 0; v < nv; v++) {
      const e = s * (1 + cRel[v]) + cAbs[v];
      X[v * 3] = P[v * 3] + N[v * 3] * e;
      X[v * 3 + 1] = P[v * 3 + 1] + N[v * 3 + 1] * e;
      X[v * 3 + 2] = P[v * 3 + 2] + N[v * 3 + 2] * e;
    }
  };

  const ext: Extent = { ext: 0, a: -1, b: -1 };
  const dt = [0, 0, 0],
    dn = [0, 0, 0],
    ids = [0, 0, 0];
  // the shell's extent along n where it crosses the line t = 0 through p
  const extent = (p: V3, t: V3, n: V3, tri: number) => {
    ext.ext = -Infinity;
    ext.a = ext.b = -1;
    for (const ft of neighbourhood(tri)) {
      for (let k = 0; k < 3; k++) {
        const v = mesh.tris[ft * 3 + k];
        ids[k] = v;
        const x = X[v * 3] - p[0],
          y = X[v * 3 + 1] - p[1],
          z = X[v * 3 + 2] - p[2];
        dt[k] = x * t[0] + y * t[1] + z * t[2];
        dn[k] = x * n[0] + y * n[1] + z * n[2];
      }
      for (let k = 0; k < 3; k++) {
        const j = (k + 1) % 3;
        const ta = dt[k],
          tb = dt[j];
        if ((ta > 0 && tb > 0) || (ta < 0 && tb < 0)) continue;
        const lam = ta === tb ? 0 : ta / (ta - tb);
        const c = ta === tb ? Math.max(dn[k], dn[j]) : dn[k] + lam * (dn[j] - dn[k]);
        if (c > ext.ext) {
          ext.ext = c;
          ext.a = ids[k];
          ext.b = ids[j];
        }
      }
    }
    return ext;
  };

  const proj = (v: number, n: V3) =>
    Math.max(opt.minProj, N[v * 3] * n[0] + N[v * 3 + 1] * n[1] + N[v * 3 + 2] * n[2]);

  // one pass at width s: returns the per-vertex increase each deficit asks for
  const pass = (s: number, into: Float64Array, toRel: boolean) => {
    placeShell(s);
    let worst = 0;
    for (const sm of samples) {
      for (const t of sm.ts) {
        const e = extent(sm.p, t, sm.n, sm.tri);
        if (e.a < 0) continue;
        const deficit = s - e.ext;
        if (deficit <= 1e-7 * edge) continue;
        worst = Math.max(worst, deficit);
        for (const v of [e.a, e.b]) {
          const need = toRel ? deficit / (s * proj(v, sm.n)) : deficit / proj(v, sm.n);
          if (need > into[v]) into[v] = need;
        }
      }
    }
    return worst;
  };

  // c_rel takes the largest need over several widths: the deficit is not linear in s where
  // the extrusion is a sizeable fraction of a concave radius (the torus's inner ring)
  const relWidths = [0.25 * edge, 0.5 * edge, edge];
  const inc = new Float64Array(nv);
  for (let r = 0; r < opt.rounds; r++) {
    inc.fill(0);
    if (pass(0, inc, false) === 0) break;
    for (let v = 0; v < nv; v++) cAbs[v] += inc[v];
  }
  for (let r = 0; r < opt.rounds; r++) {
    inc.fill(0);
    let worst = 0;
    for (const s of relWidths) worst = Math.max(worst, pass(s, inc, true));
    if (worst === 0) break;
    for (let v = 0; v < nv; v++) cRel[v] += inc[v];
  }
  for (let v = 0; v < nv; v++) {
    cAbs[v] *= opt.safety;
    cRel[v] *= opt.safety;
  }

  // verify over a range of widths
  let residual = 0,
    failing = 0;
  const widths = [0, 0.25 * edge, 0.5 * edge, edge];
  const residualByWidth: number[] = [];
  for (const s of widths) {
    placeShell(s);
    residualByWidth.push(0);
    for (const sm of samples) {
      for (const t of sm.ts) {
        const e = extent(sm.p, t, sm.n, sm.tri);
        const deficit = s - e.ext;
        if (deficit > 1e-3 * edge) failing++;
        residual = Math.max(residual, deficit / edge);
        residualByWidth[residualByWidth.length - 1] = Math.max(residualByWidth.at(-1)!, deficit / edge);
      }
    }
  }

  const finite = (a: Float64Array): Float32Array<ArrayBuffer> =>
    Float32Array.from(a, (x) => (Number.isFinite(x) ? Math.max(0, x) : 0));
  const count = samples.length * opt.views;
  return {
    cAbs: finite(cAbs),
    cRel: finite(cRel),
    samples: count,
    edge,
    residual: Math.max(0, residual),
    failing: failing / (count * widths.length),
    residualByWidth,
    ms: performance.now() - t0,
  };
}

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: V3, s: number): V3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function dot(a: V3, b: V3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
