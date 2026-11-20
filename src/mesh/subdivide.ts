import { Mesh } from "./mesh";

export interface SubdivideSmoothOptions {
  /** Laplacian step per iteration, along the normal: 0 keeps the plain midpoint split. */
  factor: number;
  iterations: number;
  /** Follow each step with Taubin's negative step, so the mesh does not shrink. */
  keepVolume: boolean;
}

export const SUBDIVIDE_SMOOTH_DEFAULTS: SubdivideSmoothOptions = {
  factor: 0.5,
  iterations: 1,
  keepVolume: true,
};

/**
 * Splits every triangle 1→4 at its edge midpoints, then smooths along the vertex normals
 * with cotangent weights (Taubin λ/μ by default, so it does not shrink). Original vertices keep their indices; each edge's midpoint is shared by both of
 * its triangles. Corner UVs are interpolated within each parent triangle, so the UV layout
 * (and with it the paint) is unchanged. cAbs/cRel are averaged onto the midpoints.
 * Boundary vertices stay fixed. Returns a new mesh with derived data built.
 */
export function subdivideSmooth(src: Mesh, opt: Partial<SubdivideSmoothOptions> = {}): Mesh {
  const { factor, iterations, keepVolume } = { ...SUBDIVIDE_SMOOTH_DEFAULTS, ...opt };
  const nv = src.vertCount,
    nt = src.triCount,
    tris = src.tris;

  // one midpoint vertex per undirected edge; boundary edges are seen once
  const edgeVert = new Map<number, number>();
  const edgeUses = new Map<number, number>();
  const ends: number[] = [];
  const key = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  const mids = new Uint32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const a = tris[t * 3 + k],
        b = tris[t * 3 + ((k + 1) % 3)];
      const e = key(a, b);
      let m = edgeVert.get(e);
      if (m === undefined) {
        m = nv + ends.length / 2;
        edgeVert.set(e, m);
        ends.push(a, b);
      }
      edgeUses.set(e, (edgeUses.get(e) ?? 0) + 1);
      mids[t * 3 + k] = m;
    }
  }
  const ne = ends.length / 2;
  const total = nv + ne;

  const pos = new Float32Array(total * 3);
  pos.set(src.positions);
  const cAbs = new Float32Array(total);
  const cRel = new Float32Array(total);
  cAbs.set(src.cAbs);
  cRel.set(src.cRel);
  for (let i = 0; i < ne; i++) {
    const a = ends[i * 2],
      b = ends[i * 2 + 1],
      m = nv + i;
    for (let c = 0; c < 3; c++) pos[m * 3 + c] = (src.positions[a * 3 + c] + src.positions[b * 3 + c]) * 0.5;
    cAbs[m] = (src.cAbs[a] + src.cAbs[b]) * 0.5;
    cRel[m] = (src.cRel[a] + src.cRel[b]) * 0.5;
  }

  // children: three corner triangles, then the middle one; mids[k] sits on edge (k, k+1)
  const out = new Uint32Array(nt * 12);
  const uvs = new Float32Array(nt * 24);
  const suv = src.uvs;
  for (let t = 0; t < nt; t++) {
    const [a, b, c] = [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]];
    const [ab, bc, ca] = [mids[t * 3], mids[t * 3 + 1], mids[t * 3 + 2]];
    out.set([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca], t * 12);

    // corner UVs as barycentric weights of the parent's corners
    const W = [
      [1, 0, 0],
      [0.5, 0.5, 0],
      [0.5, 0, 0.5],
      [0.5, 0.5, 0],
      [0, 1, 0],
      [0, 0.5, 0.5],
      [0.5, 0, 0.5],
      [0, 0.5, 0.5],
      [0, 0, 1],
      [0.5, 0.5, 0],
      [0, 0.5, 0.5],
      [0.5, 0, 0.5],
    ];
    for (let j = 0; j < 12; j++) {
      const w = W[j];
      for (let c2 = 0; c2 < 2; c2++) {
        uvs[t * 24 + j * 2 + c2] =
          w[0] * suv[t * 6 + c2] + w[1] * suv[t * 6 + 2 + c2] + w[2] * suv[t * 6 + 4 + c2];
      }
    }
  }

  // edges seen by one triangle (boundary) or more than two (non-manifold) keep their vertices fixed
  const boundary = new Uint8Array(total);
  for (const [e, uses] of edgeUses) {
    if (uses !== 2) {
      const m = edgeVert.get(e)!;
      boundary[ends[(m - nv) * 2]] = boundary[ends[(m - nv) * 2 + 1]] = boundary[m] = 1;
    }
  }

  const mesh = new Mesh();
  mesh.positions = pos;
  mesh.tris = out;
  mesh.uvs = uvs;
  mesh.cAbs = cAbs;
  mesh.cRel = cRel;
  mesh.primitive = src.primitive.copy();
  mesh.isAnalytic = false;
  // Taubin: the negative μ step undoes the λ step's shrinkage at low frequencies, using
  // μ = 1 / (k_PB − 1/λ) with pass-band k_PB = 0.1
  const mu = 1 / (0.1 - 1 / factor);
  for (let i = 0; i < iterations && factor > 0; i++) {
    laplacianStep(mesh.positions, mesh.tris, total, boundary, factor);
    if (keepVolume) laplacianStep(mesh.positions, mesh.tris, total, boundary, mu);
  }
  mesh.rebuildDerived();
  return mesh;
}

/**
 * One Jacobi step p ← p + f · ((L(p) − p) · n) n, where L(p) = Σ wᵢ pᵢ / Σ wᵢ over the 1-ring
 * with cotangent weights wᵢ = ½(cot α + cot β), and n is the area-weighted vertex normal.
 *
 * Only the normal component is applied, so vertices do not slide across the surface (and
 * the paint, which rides on the UVs, does not slide with them). Weights are not clamped:
 * per triangle the two cots at v's far corners sum to sin θ_v / (sin θ_j sin θ_k) > 0, so
 * Σ wᵢ > 0 on any non-degenerate fan. Near-collinear corners have their cot capped, and a
 * vertex whose sum is still not positive and finite falls back to uniform weights.
 */
function laplacianStep(p: Float32Array, tris: Uint32Array, nv: number, fixed: Uint8Array, f: number) {
  const COT_MAX = 1e3;
  const sum = new Float64Array(nv * 3);
  const wsum = new Float64Array(nv);
  const usum = new Float64Array(nv * 3);
  const ucount = new Float64Array(nv);
  const nrm = new Float64Array(nv * 3);
  const add = (i: number, j: number, w: number) => {
    for (let c = 0; c < 3; c++) {
      sum[i * 3 + c] += w * p[j * 3 + c];
      usum[i * 3 + c] += p[j * 3 + c];
    }
    wsum[i] += w;
    ucount[i] += 1;
  };

  for (let t = 0; t < tris.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      // the angle at corner o is opposite edge (i, j)
      const o = tris[t * 3 + k],
        i = tris[t * 3 + ((k + 1) % 3)],
        j = tris[t * 3 + ((k + 2) % 3)];
      const ux = p[i * 3] - p[o * 3],
        uy = p[i * 3 + 1] - p[o * 3 + 1],
        uz = p[i * 3 + 2] - p[o * 3 + 2];
      const vx = p[j * 3] - p[o * 3],
        vy = p[j * 3 + 1] - p[o * 3 + 1],
        vz = p[j * 3 + 2] - p[o * 3 + 2];
      const cx = uy * vz - uz * vy,
        cy = uz * vx - ux * vz,
        cz = ux * vy - uy * vx;
      const dot = ux * vx + uy * vy + uz * vz;
      const cross = Math.hypot(cx, cy, cz);
      const cot = cross > 0 ? Math.max(-COT_MAX, Math.min(COT_MAX, dot / cross)) : 0;
      add(i, j, 0.5 * cot);
      add(j, i, 0.5 * cot);
      // area-weighted normal: the triangle's cross product, added once at each corner
      nrm[o * 3] += cx;
      nrm[o * 3 + 1] += cy;
      nrm[o * 3 + 2] += cz;
    }
  }

  const next = p.slice();
  for (let v = 0; v < nv; v++) {
    if (fixed[v] || ucount[v] === 0) continue;
    const nl = Math.hypot(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);
    if (!(nl > 0)) continue;
    const useCot = wsum[v] > 1e-9 && Number.isFinite(wsum[v]);
    let along = 0;
    for (let c = 0; c < 3; c++) {
      const mean = useCot ? sum[v * 3 + c] / wsum[v] : usum[v * 3 + c] / ucount[v];
      along += (mean - p[v * 3 + c]) * (nrm[v * 3 + c] / nl);
    }
    if (!Number.isFinite(along)) continue;
    for (let c = 0; c < 3; c++) next[v * 3 + c] = p[v * 3 + c] + f * along * (nrm[v * 3 + c] / nl);
  }
  p.set(next);
}
