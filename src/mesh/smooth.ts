/** Options for `smoothPositions`, shared by Smooth and Subdivide Smooth. */
export interface SmoothOptions {
  /** Laplacian step per iteration, along the normal: 0 leaves the mesh as it is. */
  factor: number;
  iterations: number;
  /** Follow each step with Taubin's negative step, so the mesh does not shrink. */
  keepVolume: boolean;
}

export const SMOOTH_DEFAULTS: SmoothOptions = {
  factor: 0.5,
  iterations: 1,
  keepVolume: true,
};

/**
 * Smooths `positions` in place along the vertex normals with cotangent weights (Taubin λ/μ
 * when `keepVolume`). Vertices on edges seen by one triangle (boundary) or more than two
 * (non-manifold) stay fixed.
 */
export function smoothPositions(
  positions: Float32Array,
  tris: Uint32Array,
  opt: Partial<SmoothOptions> = {},
) {
  const { factor, iterations, keepVolume } = { ...SMOOTH_DEFAULTS, ...opt };
  if (!(factor > 0) || iterations < 1) return;
  const nv = positions.length / 3;
  const uses = new Map<number, number>();
  for (let t = 0; t < tris.length / 3; t++)
    for (let k = 0; k < 3; k++) {
      const a = tris[t * 3 + k],
        b = tris[t * 3 + ((k + 1) % 3)];
      const e = a < b ? a * nv + b : b * nv + a;
      uses.set(e, (uses.get(e) ?? 0) + 1);
    }
  const fixed = new Uint8Array(nv);
  for (const [e, n] of uses) if (n !== 2) fixed[Math.floor(e / nv)] = fixed[e % nv] = 1;

  // Taubin: the negative μ step undoes the λ step's shrinkage at low frequencies, using
  // μ = 1 / (k_PB − 1/λ) with pass-band k_PB = 0.1
  const mu = 1 / (0.1 - 1 / factor);
  for (let i = 0; i < iterations; i++) {
    laplacianStep(positions, tris, nv, fixed, factor);
    if (keepVolume) laplacianStep(positions, tris, nv, fixed, mu);
  }
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
