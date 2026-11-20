/**
 * Clip model 2: PN-triangle patches (Vlachos et al. 2001), TS mirror of pn.wgsl.
 *
 * Each triangle's cubic Bézier patch, in barycentrics (w0, w1, w2) = (1-u-v, u, v):
 *
 *   B = b300 w0³ + b030 w1³ + b003 w2³ + 3 b210 w0²w1 + 3 b120 w0 w1² + 3 b201 w0²w2
 *     + 3 b021 w1²w2 + 3 b102 w0 w2² + 3 b012 w1 w2² + 6 b111 w0 w1 w2
 *
 * The fragment finds the patch point closest to its view ray by minimising
 *
 *   f(u,v) = |q|²,  q = P⊥(B(u,v) − O),  P⊥ = I − D Dᵀ
 *
 * with full-Hessian Newton and Levenberg–Marquardt damping (Gauss–Newton alone is singular
 * at the contour, where N·D = 0). With ∂ = ∂/∂u or ∂/∂v:
 *
 *   ∇f = 2 [P⊥B_u · q, P⊥B_v · q],   ∇²f = 2 [P⊥B_a · P⊥B_b + B_ab · q]
 *
 * When a step leaves the triangle the walk hops to the neighbour across the crossed edge,
 * because the fragment's own triangle is often several edges behind the contour.
 *
 * The shell pass no longer uses pnClosest: it tests the width envelope instead
 * (pn_envelope.ts). pnClosest stays for tests and for the harness's comparison row.
 */

export type Vec3 = [number, number, number];

/** Control point order: b300 b030 b003 b210 b120 b021 b012 b102 b201 b111. */
export type PNPatch = Vec3[];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (...vs: Vec3[]): Vec3 =>
  vs.reduce((acc, v) => [acc[0] + v[0], acc[1] + v[1], acc[2] + v[2]], [0, 0, 0]);

export function pnControlPoints(P: Vec3[], N: Vec3[]): PNPatch {
  // edge point: (2 Pi + Pj − w_ij Ni) / 3 with w_ij = (Pj − Pi)·Ni
  const edge = (i: number, j: number) =>
    scale(sub(add(scale(P[i], 2), P[j]), scale(N[i], dot(sub(P[j], P[i]), N[i]))), 1 / 3);
  const b210 = edge(0, 1),
    b120 = edge(1, 0),
    b021 = edge(1, 2),
    b012 = edge(2, 1),
    b102 = edge(2, 0),
    b201 = edge(0, 2);
  const E = scale(add(b210, b120, b021, b012, b102, b201), 1 / 6);
  const V = scale(add(P[0], P[1], P[2]), 1 / 3);
  const b111 = add(E, scale(sub(E, V), 0.5));
  return [P[0], P[1], P[2], b210, b120, b021, b012, b102, b201, b111];
}

export interface PNEval {
  B: Vec3;
  Bu: Vec3;
  Bv: Vec3;
  Buu: Vec3;
  Buv: Vec3;
  Bvv: Vec3;
}

/** Position and first/second derivatives in (u, v); valid outside the triangle too. */
export function pnEval(b: PNPatch, u: number, v: number): PNEval {
  const w0 = 1 - u - v,
    w1 = u,
    w2 = v;
  const [b300, b030, b003, b210, b120, b021, b012, b102, b201, b111] = b;
  const lin = (terms: [Vec3, number][]) => add(...terms.map(([p, s]) => scale(p, s)));

  const B = lin([
    [b300, w0 * w0 * w0],
    [b030, w1 * w1 * w1],
    [b003, w2 * w2 * w2],
    [b210, 3 * w0 * w0 * w1],
    [b120, 3 * w0 * w1 * w1],
    [b201, 3 * w0 * w0 * w2],
    [b021, 3 * w1 * w1 * w2],
    [b102, 3 * w0 * w2 * w2],
    [b012, 3 * w1 * w2 * w2],
    [b111, 6 * w0 * w1 * w2],
  ]);
  // partials in w0, w1, w2
  const B0 = lin([
    [b300, 3 * w0 * w0],
    [b210, 6 * w0 * w1],
    [b120, 3 * w1 * w1],
    [b201, 6 * w0 * w2],
    [b102, 3 * w2 * w2],
    [b111, 6 * w1 * w2],
  ]);
  const B1 = lin([
    [b030, 3 * w1 * w1],
    [b210, 3 * w0 * w0],
    [b120, 6 * w0 * w1],
    [b021, 6 * w1 * w2],
    [b012, 3 * w2 * w2],
    [b111, 6 * w0 * w2],
  ]);
  const B2 = lin([
    [b003, 3 * w2 * w2],
    [b201, 3 * w0 * w0],
    [b021, 3 * w1 * w1],
    [b102, 6 * w0 * w2],
    [b012, 6 * w1 * w2],
    [b111, 6 * w0 * w1],
  ]);
  const B00 = lin([
    [b300, 6 * w0],
    [b210, 6 * w1],
    [b201, 6 * w2],
  ]);
  const B11 = lin([
    [b030, 6 * w1],
    [b120, 6 * w0],
    [b021, 6 * w2],
  ]);
  const B22 = lin([
    [b003, 6 * w2],
    [b102, 6 * w0],
    [b012, 6 * w1],
  ]);
  const B01 = lin([
    [b210, 6 * w0],
    [b120, 6 * w1],
    [b111, 6 * w2],
  ]);
  const B02 = lin([
    [b201, 6 * w0],
    [b102, 6 * w2],
    [b111, 6 * w1],
  ]);
  const B12 = lin([
    [b021, 6 * w1],
    [b012, 6 * w2],
    [b111, 6 * w0],
  ]);

  // w0 = 1 - u - v, w1 = u, w2 = v
  return {
    B,
    Bu: sub(B1, B0),
    Bv: sub(B2, B0),
    Buu: add(B11, scale(B01, -2), B00),
    Bvv: add(B22, scale(B02, -2), B00),
    Buv: add(B12, scale(B01, -1), scale(B02, -1), B00),
  };
}

/** Mesh access the walk needs: a patch per triangle and the neighbour across each edge. */
export interface PNMesh {
  patch(tri: number): PNPatch;
  /** Corner positions of the flat triangle, for the cheap pre-walk. */
  positions(tri: number): [Vec3, Vec3, Vec3];
  /** Vertex indices of a triangle's corners. */
  corners(tri: number): [number, number, number];
  /** Neighbour across the edge opposite `corner` (corner 0 -> edge 1-2), or -1. */
  neighbour(tri: number, corner: number): number;
}

export interface PNClosest {
  tri: number;
  u: number;
  v: number;
  dist: number;
  point: Vec3;
  /** Ray parameter of the closest point's projection onto the ray. */
  t: number;
}

const MAX_ITER = 12;
const MAX_HOPS = 8;
const HOP_SLACK = 0.02;

const MAX_FLAT_HOPS = 64;

/**
 * Walks the flat mesh toward the ray's footprint in projection along D: hop across the edge
 * with the most negative projected barycentric until the footprint is inside, or until the
 * walk turns back on itself (it is straddling the contour edge). Returns the triangle and
 * the clamped barycentrics to start Newton from.
 */
export function flatWalk(mesh: PNMesh, tri: number, O: Vec3, D: Vec3): { tri: number; u: number; v: number } {
  // orthonormal basis of the plane perpendicular to D
  const a: Vec3 = Math.abs(D[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const ax = sub(a, scale(D, dot(a, D)));
  const al = Math.hypot(ax[0], ax[1], ax[2]);
  const e1 = scale(ax, 1 / al);
  const e2: Vec3 = [D[1] * e1[2] - D[2] * e1[1], D[2] * e1[0] - D[0] * e1[2], D[0] * e1[1] - D[1] * e1[0]];

  let prev = -1;
  let w = [1 / 3, 1 / 3, 1 / 3];
  for (let hop = 0; hop < MAX_FLAT_HOPS; hop++) {
    const P = mesh.positions(tri).map((p) => {
      const d = sub(p, O);
      return [dot(d, e1), dot(d, e2)];
    });
    // 2D barycentrics of the origin (the ray's footprint) in the projected triangle
    const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[1][1] - P[0][1]) * (P[2][0] - P[0][0]);
    if (Math.abs(area) < 1e-20) break;
    const b0 = (P[1][0] * P[2][1] - P[1][1] * P[2][0]) / area;
    const b1 = (P[2][0] * P[0][1] - P[2][1] * P[0][0]) / area;
    w = [b0, b1, 1 - b0 - b1];
    const k = w[0] < w[1] ? (w[0] < w[2] ? 0 : 2) : w[1] < w[2] ? 1 : 2;
    if (w[k] >= 0) break;
    const nb = mesh.neighbour(tri, k);
    if (nb < 0 || nb === prev) break;
    prev = tri;
    tri = nb;
  }
  const cw = w.map((x) => Math.max(0, x));
  const sum = cw[0] + cw[1] + cw[2] || 1;
  return { tri, u: cw[1] / sum, v: cw[2] / sum };
}

/** Closest point on the patch union to the ray O + tD, starting at (tri, u, v). */
export function pnClosest(mesh: PNMesh, tri: number, u: number, v: number, O: Vec3, D: Vec3): PNClosest {
  const perp = (a: Vec3): Vec3 => sub(a, scale(D, dot(a, D)));
  ({ tri, u, v } = flatWalk(mesh, tri, O, D));
  let patch = mesh.patch(tri);
  let lambda = 1e-3;
  let hops = 0;

  const evalAt = (uu: number, vv: number) => {
    const e = pnEval(patch, uu, vv);
    const q = perp(sub(e.B, O));
    return { e, q, f: dot(q, q) };
  };

  let cur = evalAt(u, v);
  let best = { tri, u, v, f: cur.f, B: cur.e.B };

  for (let it = 0; it < MAX_ITER; it++) {
    const { e, q } = cur;
    const pu = perp(e.Bu),
      pv = perp(e.Bv);
    const gu = dot(pu, q),
      gv = dot(pv, q);
    const huu = dot(pu, pu) + dot(e.Buu, q);
    const huv = dot(pu, pv) + dot(e.Buv, q);
    const hvv = dot(pv, pv) + dot(e.Bvv, q);

    // LM: (H + λ·diag-scale·I) δ = −g, raising λ until the step decreases f
    let accepted = false;
    for (let tries = 0; tries < 6 && !accepted; tries++) {
      const damp = lambda * (Math.abs(huu) + Math.abs(hvv) + 1e-12);
      const a = huu + damp,
        b = huv,
        c = hvv + damp;
      const det = a * c - b * b;
      if (!(Math.abs(det) > 1e-30)) {
        lambda *= 10;
        continue;
      }
      const du = -(c * gu - b * gv) / det;
      const dv = -(a * gv - b * gu) / det;
      const nu = u + du,
        nv = v + dv;
      const trial = evalAt(nu, nv);
      if (trial.f < cur.f) {
        u = nu;
        v = nv;
        cur = trial;
        lambda = Math.max(lambda * 0.3, 1e-6);
        accepted = true;
      } else {
        lambda *= 10;
      }
    }
    if (!accepted) break;

    // leaving the triangle: hop across the crossed edge to the neighbour's patch; with no
    // neighbour or no hops left, clamp back onto this triangle rather than extrapolate
    const w = [1 - u - v, u, v];
    const minIdx = w[0] < w[1] ? (w[0] < w[2] ? 0 : 2) : w[1] < w[2] ? 1 : 2;
    if (w[minIdx] < -HOP_SLACK) {
      const cw = w.map((x) => Math.max(0, x));
      const s = cw[0] + cw[1] + cw[2];
      const nb = hops < MAX_HOPS ? mesh.neighbour(tri, minIdx) : -1;
      if (nb >= 0) {
        // carry the step over the edge: shared corners keep their weights and the
        // overshoot becomes depth into the neighbour (exact for congruent triangles)
        const ids = mesh.corners(tri);
        const nids = mesh.corners(nb);
        const nw = [0, 0, 0];
        for (let k = 0; k < 3; k++) {
          const j = nids.indexOf(ids[k]);
          if (j >= 0) nw[j] = k === minIdx ? 0 : w[k];
        }
        nw[nw.findIndex((_, j) => !ids.includes(nids[j]))] = -w[minIdx];
        const ns = nw[0] + nw[1] + nw[2];
        for (let j = 0; j < 3; j++) nw[j] /= ns;
        tri = nb;
        patch = mesh.patch(tri);
        u = nw[1];
        v = nw[2];
        hops++;
        void s;
      } else {
        u = cw[1] / s;
        v = cw[2] / s;
      }
      cur = evalAt(u, v);
    }

    if (cur.f < best.f) {
      best = { tri, u, v, f: cur.f, B: cur.e.B };
    }
  }

  return {
    tri: best.tri,
    u: best.u,
    v: best.v,
    dist: Math.sqrt(best.f),
    point: best.B,
    t: dot(sub(best.B, O), D),
  };
}
