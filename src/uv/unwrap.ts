import type { Mesh } from "../mesh/mesh";

export interface UnwrapOptions {
  /** Texture edge length in texels; UVs map texel (x, y) = (u * texSize, v * texSize). */
  texSize?: number;
  /** Minimum empty texels between any two charts, and between a chart and the border. */
  gutterTexels?: number;
  /** Rounds of area-correcting relaxation per chart. */
  relaxRounds?: number;
}

/**
 * Projection axes per cube face, indexed `axis * 2 + (negative ? 1 : 0)`:
 * +X, -X, +Y, -Y, +Z, -Z. A face's (u, v) is (p[a], p[b]) with e_a x e_b equal to the
 * face's outward axis, so a triangle wound CCW about its outward normal projects to
 * positive signed area cross(uv1 - uv0, uv2 - uv0) > 0. Its 2D cross is s * N[axis] > 0,
 * where N is the 3D triangle normal and s the face sign.
 */
const FACE_AXES: readonly (readonly [number, number])[] = [
  [1, 2],
  [2, 1],
  [2, 0],
  [0, 2],
  [0, 1],
  [1, 0],
];

const RELAX_DAMPING = 0.5;
const MAX_STEP_SCALE = 2;

/**
 * Generates per-corner UVs in `mesh.uvs` (6 floats per triangle, in [0,1]^2).
 *
 * - Charts: triangles grouped by the cube face their normal is closest to, then split into
 *   edge-connected components.
 * - Initial UVs: planar projection on the face plane (see FACE_AXES for orientation).
 * - Area correction: damped Jacobi relaxation toward per-triangle UV area proportional to 3D
 *   area. A chart's round is reverted (and the chart frozen) if it flips or degenerates a
 *   triangle, or increases the variance of log(UV area / 3D area).
 * - Packing: one common texel density, shelf-packed (tallest first) with integer-texel
 *   offsets and `gutterTexels` of empty texels between charts and at the border; the
 *   density is the largest found by binary search.
 *
 * Orientation convention: every UV triangle has positive signed area in the (u, v) frame,
 * i.e. (u1-u0)(v2-v0) - (u2-u0)(v1-v0) > 0. Since v points down in the image, triangles
 * appear clockwise (mirrored) when the texture is viewed as an image.
 */
export function unwrapMesh(mesh: Mesh, opts: UnwrapOptions = {}): void {
  const texSize = opts.texSize ?? 1024;
  const gutter = opts.gutterTexels ?? 4;
  const rounds = opts.relaxRounds ?? 10;
  const nt = mesh.triCount;
  mesh.uvs = new Float32Array(nt * 6);
  if (nt === 0) return;

  const { face, area3 } = classifyTriangles(mesh);
  const { chartOf, chartCount } = findCharts(mesh, face);
  const charts = buildCharts(mesh, face, chartOf, chartCount);
  for (let r = 0; r < rounds; r++) {
    if (!relaxRound(charts, area3)) break;
  }
  packCharts(mesh, charts, texSize, gutter);
}

/** Per triangle: cube face index (see FACE_AXES) and 3D area. */
function classifyTriangles(mesh: Mesh) {
  const p = mesh.positions,
    tris = mesh.tris,
    nt = mesh.triCount;
  const face = new Uint8Array(nt);
  const area3 = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = tris[t * 3] * 3,
      b = tris[t * 3 + 1] * 3,
      c = tris[t * 3 + 2] * 3;
    const e1x = p[b] - p[a],
      e1y = p[b + 1] - p[a + 1],
      e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a],
      e2y = p[c + 1] - p[a + 1],
      e2z = p[c + 2] - p[a + 2];
    const nx = e1y * e2z - e1z * e2y,
      ny = e1z * e2x - e1x * e2z,
      nz = e1x * e2y - e1y * e2x;
    const ax = Math.abs(nx),
      ay = Math.abs(ny),
      az = Math.abs(nz);
    if (ax >= ay && ax >= az) face[t] = nx >= 0 ? 0 : 1;
    else if (ay >= az) face[t] = ny >= 0 ? 2 : 3;
    else face[t] = nz >= 0 ? 4 : 5;
    area3[t] = 0.5 * Math.hypot(nx, ny, nz);
  }
  return { face, area3 };
}

function ufFind(parent: Int32Array, x: number) {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]];
    x = parent[x];
  }
  return x;
}

/** Edge-connected components within each face group, numbered 0..chartCount-1. */
function findCharts(mesh: Mesh, face: Uint8Array) {
  const tris = mesh.tris,
    nt = mesh.triCount;
  const vtStart = mesh.vertTriStart,
    vt = mesh.vertTris;
  const parent = new Int32Array(nt);
  for (let t = 0; t < nt; t++) parent[t] = t;

  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const a = tris[t * 3 + k],
        b = tris[t * 3 + ((k + 1) % 3)];
      for (let i = vtStart[a]; i < vtStart[a + 1]; i++) {
        const t2 = vt[i];
        if (t2 <= t || face[t2] !== face[t]) continue;
        if (tris[t2 * 3] !== b && tris[t2 * 3 + 1] !== b && tris[t2 * 3 + 2] !== b) continue;
        const ra = ufFind(parent, t),
          rb = ufFind(parent, t2);
        if (ra !== rb) parent[rb] = ra;
      }
    }
  }

  const chartOf = new Int32Array(nt);
  const rootId = new Int32Array(nt).fill(-1);
  let chartCount = 0;
  for (let t = 0; t < nt; t++) {
    const r = ufFind(parent, t);
    if (rootId[r] < 0) rootId[r] = chartCount++;
    chartOf[t] = rootId[r];
  }
  return { chartOf, chartCount };
}

/**
 * Chart data in flat arrays. Chart vertices ("cv") are per (chart, mesh vertex) pairs, laid
 * out contiguously per chart; corners of a chart that share a mesh vertex share a cv.
 */
interface Charts {
  count: number;
  /** CSR chart -> triangles. */
  triStart: Uint32Array;
  tris: Uint32Array;
  /** Chart c owns cvs [cvStart[c], cvStart[c+1]). */
  cvStart: Uint32Array;
  /** Per mesh corner (t*3+k): its cv. */
  cornerCv: Uint32Array;
  u: Float64Array;
  v: Float64Array;
  /** Charts whose relaxation was reverted; they are not relaxed again. */
  frozen: Uint8Array;
}

function buildCharts(mesh: Mesh, face: Uint8Array, chartOf: Int32Array, count: number): Charts {
  const nt = mesh.triCount,
    tris = mesh.tris,
    p = mesh.positions;

  const triStart = new Uint32Array(count + 1);
  for (let t = 0; t < nt; t++) triStart[chartOf[t] + 1]++;
  for (let c = 0; c < count; c++) triStart[c + 1] += triStart[c];
  const fill = triStart.slice(0, count);
  const chartTris = new Uint32Array(nt);
  for (let t = 0; t < nt; t++) chartTris[fill[chartOf[t]]++] = t;

  const stamp = new Int32Array(mesh.vertCount).fill(-1);
  const local = new Uint32Array(mesh.vertCount);
  const cornerCv = new Uint32Array(nt * 3);
  const cvStart = new Uint32Array(count + 1);
  const cvMesh: number[] = [];
  for (let c = 0; c < count; c++) {
    cvStart[c] = cvMesh.length;
    for (let i = triStart[c]; i < triStart[c + 1]; i++) {
      const t = chartTris[i];
      for (let k = 0; k < 3; k++) {
        const vtx = tris[t * 3 + k];
        if (stamp[vtx] !== c) {
          stamp[vtx] = c;
          local[vtx] = cvMesh.length;
          cvMesh.push(vtx);
        }
        cornerCv[t * 3 + k] = local[vtx];
      }
    }
  }
  cvStart[count] = cvMesh.length;

  // planar projection; every corner of a chart's triangle uses the chart's face
  const u = new Float64Array(cvMesh.length);
  const v = new Float64Array(cvMesh.length);
  for (let c = 0; c < count; c++) {
    const [a, b] = FACE_AXES[face[chartTris[triStart[c]]]];
    for (let cv = cvStart[c]; cv < cvStart[c + 1]; cv++) {
      u[cv] = p[cvMesh[cv] * 3 + a];
      v[cv] = p[cvMesh[cv] * 3 + b];
    }
  }

  return {
    count,
    triStart,
    tris: chartTris,
    cvStart,
    cornerCv,
    u,
    v,
    frozen: new Uint8Array(count),
  };
}

function uvArea(ch: Charts, t: number) {
  const i0 = ch.cornerCv[t * 3],
    i1 = ch.cornerCv[t * 3 + 1],
    i2 = ch.cornerCv[t * 3 + 2];
  const { u, v } = ch;
  return 0.5 * ((u[i1] - u[i0]) * (v[i2] - v[i0]) - (u[i2] - u[i0]) * (v[i1] - v[i0]));
}

/**
 * Variance of log(UV area / 3D area) over a chart's non-degenerate triangles, or NaN if a
 * triangle is flipped or collapsed (UV area below 1e-6 of its share of the chart area).
 */
function chartDistortion(ch: Charts, c: number, area3: Float64Array) {
  let sumUV = 0,
    sum3 = 0;
  for (let i = ch.triStart[c]; i < ch.triStart[c + 1]; i++) {
    const t = ch.tris[i];
    sumUV += uvArea(ch, t);
    sum3 += area3[t];
  }
  let n = 0,
    mean = 0,
    m2 = 0;
  for (let i = ch.triStart[c]; i < ch.triStart[c + 1]; i++) {
    const t = ch.tris[i];
    if (area3[t] <= 0) continue;
    const a = uvArea(ch, t);
    if (!(a > 1e-6 * area3[t] * (sumUV / sum3))) return NaN;
    const x = Math.log(a / area3[t]);
    n++;
    const d = x - mean;
    mean += d / n;
    m2 += d * (x - mean);
  }
  return n > 0 ? m2 / n : 0;
}

/** One damped Jacobi round over all unfrozen charts; returns false once every chart is frozen. */
function relaxRound(ch: Charts, area3: Float64Array): boolean {
  const { u, v, cornerCv } = ch;
  const ncv = u.length;
  const oldU = u.slice(),
    oldV = v.slice();
  const accU = new Float64Array(ncv),
    accV = new Float64Array(ncv),
    cnt = new Uint32Array(ncv);
  const before = new Float64Array(ch.count);
  let active = 0;

  for (let c = 0; c < ch.count; c++) {
    if (ch.frozen[c]) continue;
    before[c] = chartDistortion(ch, c, area3);
    let sumUV = 0,
      sum3 = 0;
    for (let i = ch.triStart[c]; i < ch.triStart[c + 1]; i++) {
      sumUV += uvArea(ch, ch.tris[i]);
      sum3 += area3[ch.tris[i]];
    }
    if (!(sum3 > 0 && sumUV > 0) || !(before[c] > 0)) {
      ch.frozen[c] = 1;
      continue;
    }
    active++;
    const ratio = sumUV / sum3;

    for (let i = ch.triStart[c]; i < ch.triStart[c + 1]; i++) {
      const t = ch.tris[i];
      const cur = uvArea(ch, t);
      if (!(cur > 0) || !(area3[t] > 0)) continue;
      let s = Math.sqrt((area3[t] * ratio) / cur);
      s = Math.min(MAX_STEP_SCALE, Math.max(1 / MAX_STEP_SCALE, s));
      const i0 = cornerCv[t * 3],
        i1 = cornerCv[t * 3 + 1],
        i2 = cornerCv[t * 3 + 2];
      const cu = (u[i0] + u[i1] + u[i2]) / 3,
        cv = (v[i0] + v[i1] + v[i2]) / 3;
      for (const j of [i0, i1, i2]) {
        accU[j] += cu + s * (u[j] - cu);
        accV[j] += cv + s * (v[j] - cv);
        cnt[j]++;
      }
    }
  }
  if (active === 0) return false;

  for (let j = 0; j < ncv; j++) {
    if (cnt[j] === 0) continue;
    u[j] += RELAX_DAMPING * (accU[j] / cnt[j] - u[j]);
    v[j] += RELAX_DAMPING * (accV[j] / cnt[j] - v[j]);
  }

  // NaN (a flip) and "no better" both fail the comparison and revert the chart
  for (let c = 0; c < ch.count; c++) {
    if (ch.frozen[c]) continue;
    const after = chartDistortion(ch, c, area3);
    if (!(after < before[c])) {
      for (let j = ch.cvStart[c]; j < ch.cvStart[c + 1]; j++) {
        u[j] = oldU[j];
        v[j] = oldV[j];
      }
      ch.frozen[c] = 1;
    }
  }
  return true;
}

interface Layout {
  x: Int32Array;
  y: Int32Array;
}

/** Shelf-packs charts at `scale` texels per UV unit; null if they don't fit. */
function shelfPack(
  order: Uint32Array,
  w: Float64Array,
  h: Float64Array,
  scale: number,
  texSize: number,
  gutter: number,
): Layout | null {
  const n = order.length;
  const x = new Int32Array(n),
    y = new Int32Array(n);
  const limit = texSize - gutter;
  let cx = gutter,
    cy = gutter,
    shelfH = -1;
  for (const c of order) {
    const cw = Math.ceil(w[c] * scale),
      chH = Math.ceil(h[c] * scale);
    if (shelfH < 0) shelfH = chH;
    if (cx + cw > limit) {
      cy += shelfH + gutter;
      cx = gutter;
      shelfH = chH;
    }
    if (cx + cw > limit || cy + chH > limit) return null;
    x[c] = cx;
    y[c] = cy;
    cx += cw + gutter;
  }
  return { x, y };
}

function packCharts(mesh: Mesh, ch: Charts, texSize: number, gutter: number) {
  const n = ch.count;
  const minU = new Float64Array(n),
    minV = new Float64Array(n),
    w = new Float64Array(n),
    h = new Float64Array(n);
  let maxDim = 0,
    sumArea = 0;
  for (let c = 0; c < n; c++) {
    let u0 = Infinity,
      v0 = Infinity,
      u1 = -Infinity,
      v1 = -Infinity;
    for (let j = ch.cvStart[c]; j < ch.cvStart[c + 1]; j++) {
      u0 = Math.min(u0, ch.u[j]);
      u1 = Math.max(u1, ch.u[j]);
      v0 = Math.min(v0, ch.v[j]);
      v1 = Math.max(v1, ch.v[j]);
    }
    minU[c] = u0;
    minV[c] = v0;
    w[c] = u1 - u0;
    h[c] = v1 - v0;
    maxDim = Math.max(maxDim, w[c], h[c]);
    sumArea += w[c] * h[c];
  }

  const order = Uint32Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => h[b] - h[a] || w[b] - w[a]);

  const avail = texSize - 2 * gutter;
  if (avail <= 0) throw new Error(`unwrapMesh: gutter ${gutter} leaves no room in ${texSize}^2`);
  let hi = maxDim > 0 ? avail / maxDim : 1;
  if (sumArea > 0) hi = Math.min(hi, avail / Math.sqrt(sumArea));
  let best = shelfPack(order, w, h, hi, texSize, gutter);
  let bestScale = hi;
  if (!best) {
    let lo = 0;
    for (let iter = 0; iter < 40; iter++) {
      const mid = (lo + hi) / 2;
      const layout = shelfPack(order, w, h, mid, texSize, gutter);
      if (layout) {
        best = layout;
        bestScale = mid;
        lo = mid;
      } else {
        hi = mid;
      }
    }
  }
  if (!best) throw new Error(`unwrapMesh: ${n} charts do not fit in ${texSize}^2 with gutter ${gutter}`);

  const uvs = mesh.uvs;
  const inv = 1 / texSize;
  for (let c = 0; c < n; c++) {
    for (let i = ch.triStart[c]; i < ch.triStart[c + 1]; i++) {
      const t = ch.tris[i];
      for (let k = 0; k < 3; k++) {
        const j = ch.cornerCv[t * 3 + k];
        uvs[t * 6 + k * 2] = (best.x[c] + (ch.u[j] - minU[c]) * bestScale) * inv;
        uvs[t * 6 + k * 2 + 1] = (best.y[c] + (ch.v[j] - minV[c]) * bestScale) * inv;
      }
    }
  }
}
