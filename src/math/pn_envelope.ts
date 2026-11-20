/**
 * PN clip model, envelope form (docs/plans/pn-envelope.md). Line-for-line mirror of
 * pnEnvelope in pn.wgsl.
 *
 * The fragment keeps its pixel if some patch point p has
 *
 *   φ(p) = d(p) − r(p) < 0,   d = |P⊥(B − O)|,  r = painted width at p · pw
 *
 * which is the reference's union-of-balls test. pw is the fragment's pixel size, as in the
 * closest-point model this replaced (see the plan for why not pixelWorld(p)). With f = d² and the half-gradient
 * g = [P⊥B_u·q, P⊥B_v·q] and half-Hessian h = [P⊥B_a·P⊥B_b + B_ab·q] from pn.ts:
 *
 *   ∇d = g / d,   ∇²d = h / d − g gᵀ / d³
 *
 * ∇r is the map's bilinear gradient through the triangle's UV Jacobian; the Hessian of r is
 * ignored. The search is a decision: it stops at the first
 * φ < 0 inside a triangle.
 *
 * Which triangle holds such a point is the hard part: PN patches are only C0, so along a
 * grazing ray every shared edge can be its own local minimum. After the fragment's own
 * flat-walk search, the triangles within two shared-vertex rings (triRings) are tried in
 * turn, each from the ray's footprint clamped into it, skipping those out of reach: first by
 * a bounding sphere (one load on the GPU), then by the projected box of the control points.
 */
import { flatWalk, pnEval } from "./pn";
import type { PNMesh, PNPatch, Vec3 } from "./pn";

export interface PNEnvelopeMesh extends PNMesh {
  /** Candidate triangles for a flat-walk triangle (triRings order). */
  ring(tri: number): ArrayLike<number>;
  /** Bounding sphere of the patch's control points, and the largest corner wmax. */
  bound(tri: number): { c: Vec3; rad: number; wmax: number };
}

/** Radius at a patch point B = patch(tri)(u, v), and its derivatives in (u, v). */
export type RadiusFn = (tri: number, u: number, v: number, B: Vec3) => { r: number; ru: number; rv: number };

export interface EnvelopeOptions {
  /** Try the ring candidates after the fragment's own search. */
  ring: boolean;
  /** Newton iterations and edge hops per search. */
  maxIter: number;
  maxHops: number;
}

export const ENVELOPE_DEFAULTS: EnvelopeOptions = { ring: true, maxIter: 12, maxHops: 8 };

export interface EnvelopeResult {
  keep: boolean;
  tri: number;
  u: number;
  v: number;
  dist: number;
  r: number;
  /** Ray parameter of the point's projection onto the ray. */
  t: number;
  /** Newton iterations and searches, all starts together. */
  iters: number;
  searches: number;
}

/** Bounding sphere of a patch's control points: their centroid and largest distance. */
export function pnBound(patch: PNPatch): { c: Vec3; rad: number } {
  const c: Vec3 = [0, 0, 0];
  for (const p of patch) for (let i = 0; i < 3; i++) c[i] += p[i] / patch.length;
  let rad = 0;
  for (const p of patch) rad = Math.max(rad, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
  return { c, rad };
}

const HOP_SLACK = 0.02;
const INSIDE_EPS = 1e-6;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Barycentrics in `nb` of the point with weights `w` in `tri`, overshoot carried as depth. */
function carry(mesh: PNMesh, tri: number, nb: number, w: number[], k: number) {
  const ids = mesh.corners(tri);
  const nids = mesh.corners(nb);
  const nw = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const j = nids.indexOf(ids[i]);
    if (j >= 0) nw[j] = i === k ? 0 : w[i];
  }
  nw[nw.findIndex((_, j) => !ids.includes(nids[j]))] = -w[k];
  const s = nw[0] + nw[1] + nw[2];
  return { u: nw[1] / s, v: nw[2] / s };
}

interface Point {
  tri: number;
  u: number;
  v: number;
  B: Vec3;
  e: ReturnType<typeof pnEval>;
  q: Vec3;
  d: number;
  r: number;
  ru: number;
  rv: number;
}

const inside = (p: Point) => p.u >= -INSIDE_EPS && p.v >= -INSIDE_EPS && p.u + p.v <= 1 + INSIDE_EPS;
const hit = (p: Point) => p.d < p.r && inside(p);

function searchFrom(
  mesh: PNMesh,
  radius: RadiusFn,
  O: Vec3,
  D: Vec3,
  start: { tri: number; u: number; v: number },
  opt: EnvelopeOptions,
): { best: Point; iters: number } {
  let { tri, u, v } = start;
  let patch: PNPatch = mesh.patch(tri);
  let hops = 0;
  let lambda = 1e-3;

  const at = (t: number, p: PNPatch, uu: number, vv: number): Point => {
    const e = pnEval(p, uu, vv);
    const rel = sub(e.B, O);
    const s = dot(rel, D);
    const q: Vec3 = [rel[0] - D[0] * s, rel[1] - D[1] * s, rel[2] - D[2] * s];
    const { r, ru, rv } = radius(t, uu, vv, e.B);
    return { tri: t, u: uu, v: vv, B: e.B, e, q, d: Math.sqrt(dot(q, q)), r, ru, rv };
  };

  let cur = at(tri, patch, u, v);
  let best = cur;
  if (hit(cur)) return { best: cur, iters: 0 };

  let iters = 0;
  for (let it = 0; it < opt.maxIter; it++) {
    iters++;
    const { e, q } = cur;
    const perp = (a: Vec3): Vec3 => {
      const s = dot(a, D);
      return [a[0] - D[0] * s, a[1] - D[1] * s, a[2] - D[2] * s];
    };
    const pu = perp(e.Bu),
      pv = perp(e.Bv);
    // ∇d and ∇²d from the half-gradient and half-Hessian of d²; d is never 0 here, since
    // d < r would already have stopped the search (unless the point lies outside its triangle)
    const d = Math.max(cur.d, 1e-9),
      d3 = d * d * d;
    const g0 = dot(pu, q),
      g1 = dot(pv, q);
    const huu = (dot(pu, pu) + dot(e.Buu, q)) / d - (g0 * g0) / d3;
    const huv = (dot(pu, pv) + dot(e.Buv, q)) / d - (g0 * g1) / d3;
    const hvv = (dot(pv, pv) + dot(e.Bvv, q)) / d - (g1 * g1) / d3;
    const gu = g0 / d - cur.ru,
      gv = g1 / d - cur.rv;

    let accepted = false;
    for (let tries = 0; tries < 6 && !accepted; tries++) {
      const damp = lambda * (Math.abs(huu) + Math.abs(hvv) + 1e-12);
      const a = huu + damp,
        c = hvv + damp;
      const det = a * c - huv * huv;
      // an indefinite system can point uphill; raise the damping until it is positive definite
      if (!(det > 1e-30) || a <= 0) {
        lambda *= 10;
        continue;
      }
      const trial = at(tri, patch, u - (c * gu - huv * gv) / det, v - (a * gv - huv * gu) / det);
      if (trial.d - trial.r < cur.d - cur.r) {
        u = trial.u;
        v = trial.v;
        cur = trial;
        lambda = Math.max(lambda * 0.3, 1e-6);
        accepted = true;
      } else {
        lambda *= 10;
      }
    }
    if (!accepted) break;

    // leaving the triangle: hop across the crossed edge, or clamp when out of hops
    const w = [1 - u - v, u, v];
    const k = w[0] < w[1] ? (w[0] < w[2] ? 0 : 2) : w[1] < w[2] ? 1 : 2;
    if (w[k] < -HOP_SLACK) {
      const nb = hops < opt.maxHops ? mesh.neighbour(tri, k) : -1;
      if (nb >= 0) {
        ({ u, v } = carry(mesh, tri, nb, w, k));
        tri = nb;
        patch = mesh.patch(tri);
        hops++;
      } else {
        const cw = w.map((x) => Math.max(0, x));
        const s = cw[0] + cw[1] + cw[2];
        u = cw[1] / s;
        v = cw[2] / s;
      }
      cur = at(tri, patch, u, v);
    }

    if (cur.d - cur.r < best.d - best.r) best = cur;
    if (hit(cur)) return { best: cur, iters };
  }
  return { best, iters };
}

/**
 * Lower bound of the distance from the ray to a patch: the patch lies in its control points'
 * convex hull, so its projection along D lies in their projected bounding box.
 */
function boxDistance(patch: PNPatch, O: Vec3, e1: Vec3, e2: Vec3) {
  let lo1 = Infinity,
    hi1 = -Infinity,
    lo2 = Infinity,
    hi2 = -Infinity;
  for (const p of patch) {
    const rel = sub(p, O);
    const x = dot(rel, e1),
      y = dot(rel, e2);
    lo1 = Math.min(lo1, x);
    hi1 = Math.max(hi1, x);
    lo2 = Math.min(lo2, y);
    hi2 = Math.max(hi2, y);
  }
  return Math.hypot(Math.max(lo1, 0, -hi1), Math.max(lo2, 0, -hi2));
}

/**
 * Decides whether the fragment of shell triangle `fragTri` on the ray O + tD, with pixel size
 * `pw`, is inside the width envelope of the patch union. `radius` must use the same pw.
 */
export function pnEnvelope(
  mesh: PNEnvelopeMesh,
  radius: RadiusFn,
  pw: number,
  fragTri: number,
  O: Vec3,
  D: Vec3,
  opt: EnvelopeOptions = ENVELOPE_DEFAULTS,
): EnvelopeResult {
  const result = (p: Point, keep: boolean, iters: number, searches: number): EnvelopeResult => ({
    keep,
    tri: p.tri,
    u: p.u,
    v: p.v,
    dist: p.d,
    r: p.r,
    t: dot(sub(p.B, O), D),
    iters,
    searches,
  });

  const first = flatWalk(mesh, fragTri, O, D);
  const own = searchFrom(mesh, radius, O, D, first, opt);
  let best = own.best;
  let iters = own.iters;
  let searches = 1;
  if (hit(best)) return result(best, true, iters, searches);
  if (!opt.ring) return result(best, false, iters, searches);

  // basis of the plane perpendicular to D, for the projected bounding boxes
  const a: Vec3 = Math.abs(D[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const ad = dot(a, D);
  const ax: Vec3 = [a[0] - D[0] * ad, a[1] - D[1] * ad, a[2] - D[2] * ad];
  const al = Math.hypot(ax[0], ax[1], ax[2]);
  const e1: Vec3 = [ax[0] / al, ax[1] / al, ax[2] / al];
  const e2: Vec3 = [D[1] * e1[2] - D[2] * e1[1], D[2] * e1[0] - D[0] * e1[2], D[0] * e1[1] - D[1] * e1[0]];

  // a triangle alone: the flat walk then only clamps the footprint into it
  const alone: PNMesh = { ...mesh, neighbour: () => -1 };
  const ring = mesh.ring(first.tri);
  for (let i = 0; i < ring.length; i++) {
    const t = ring[i];
    const b = mesh.bound(t);
    const rel = sub(b.c, O);
    const s = dot(rel, D);
    const dc = Math.hypot(rel[0] - D[0] * s, rel[1] - D[1] * s, rel[2] - D[2] * s);
    const reach = b.wmax * pw;
    if (dc - b.rad >= reach) continue;
    if (boxDistance(mesh.patch(t), O, e1, e2) >= reach) continue;
    const res = searchFrom(mesh, radius, O, D, flatWalk(alone, t, O, D), opt);
    iters += res.iters;
    searches++;
    if (hit(res.best)) return result(res.best, true, iters, searches);
    if (res.best.d - res.best.r < best.d - best.r) best = res.best;
  }
  return result(best, false, iters, searches);
}
