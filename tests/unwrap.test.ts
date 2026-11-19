import { describe, expect, it } from "vitest";
import { Mesh, PrimitiveParams, PrimitiveType } from "../src/mesh/mesh";
import { makePrimitive } from "../src/mesh/primitives";
import { unwrapMesh } from "../src/uv/unwrap";

function params(type: PrimitiveType, density: number) {
  const p = new PrimitiveParams();
  p.type = type;
  p.density = density;
  return p;
}

const allTypes = [
  PrimitiveType.CUBE,
  PrimitiveType.UV_SPHERE,
  PrimitiveType.ICOSPHERE,
  PrimitiveType.CAPSULE,
  PrimitiveType.TORUS,
];
const densities = [4, 12];
const TEX = 1024;
const GUTTER = 4;

/** Signed UV area (u1-u0)(v2-v0) - (u2-u0)(v1-v0), halved; the unwrapper makes it positive. */
function uvSignedArea(m: Mesh, t: number) {
  const q = m.uvs;
  const [u0, v0, u1, v1, u2, v2] = [
    q[t * 6],
    q[t * 6 + 1],
    q[t * 6 + 2],
    q[t * 6 + 3],
    q[t * 6 + 4],
    q[t * 6 + 5],
  ];
  return 0.5 * ((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0));
}

function area3(m: Mesh, t: number) {
  const p = m.positions;
  const [a, b, c] = [m.tris[t * 3] * 3, m.tris[t * 3 + 1] * 3, m.tris[t * 3 + 2] * 3];
  const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
  const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
  return (
    0.5 *
    Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0])
  );
}

function cornerUV(m: Mesh, t: number, vert: number): [number, number] {
  for (let k = 0; k < 3; k++) {
    if (m.tris[t * 3 + k] === vert) return [m.uvs[t * 6 + k * 2], m.uvs[t * 6 + k * 2 + 1]];
  }
  throw new Error("vertex not in triangle");
}

/** Charts recovered from the UVs alone: triangles sharing an edge whose UVs agree on both ends. */
function chartsFromUVs(m: Mesh) {
  const parent = Int32Array.from({ length: m.triCount }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let t = 0; t < m.triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = m.tris[t * 3 + k];
      const b = m.tris[t * 3 + ((k + 1) % 3)];
      for (let i = m.vertTriStart[a]; i < m.vertTriStart[a + 1]; i++) {
        const t2 = m.vertTris[i];
        if (t2 === t || ![0, 1, 2].some((j) => m.tris[t2 * 3 + j] === b)) continue;
        const [pa, pb, qa, qb] = [
          cornerUV(m, t, a),
          cornerUV(m, t, b),
          cornerUV(m, t2, a),
          cornerUV(m, t2, b),
        ];
        if (pa[0] === qa[0] && pa[1] === qa[1] && pb[0] === qb[0] && pb[1] === qb[1]) {
          parent[find(t2)] = find(t);
        }
      }
    }
  }
  const ids = new Map<number, number>();
  const chartOf = new Int32Array(m.triCount);
  for (let t = 0; t < m.triCount; t++) {
    const r = find(t);
    if (!ids.has(r)) ids.set(r, ids.size);
    chartOf[t] = ids.get(r)!;
  }
  return { chartOf, count: ids.size };
}

/** Strict (open-set) overlap of a triangle with an axis-aligned box, by separating axes. */
function triOverlapsBox(tri: number[], x0: number, y0: number, x1: number, y1: number) {
  const xs = [tri[0], tri[2], tri[4]];
  const ys = [tri[1], tri[3], tri[5]];
  if (Math.max(...xs) <= x0 || Math.min(...xs) >= x1) return false;
  if (Math.max(...ys) <= y0 || Math.min(...ys) >= y1) return false;
  const box = [x0, y0, x1, y0, x1, y1, x0, y1];
  for (let k = 0; k < 3; k++) {
    const nx = -(ys[(k + 1) % 3] - ys[k]);
    const ny = xs[(k + 1) % 3] - xs[k];
    let tMin = Infinity,
      tMax = -Infinity,
      bMin = Infinity,
      bMax = -Infinity;
    for (let j = 0; j < 3; j++) {
      const d = xs[j] * nx + ys[j] * ny;
      tMin = Math.min(tMin, d);
      tMax = Math.max(tMax, d);
    }
    for (let j = 0; j < 4; j++) {
      const d = box[j * 2] * nx + box[j * 2 + 1] * ny;
      bMin = Math.min(bMin, d);
      bMax = Math.max(bMax, d);
    }
    if (tMax <= bMin || bMax <= tMin) return false;
  }
  return true;
}

function texelTri(m: Mesh, t: number, tex: number) {
  return Array.from(m.uvs.subarray(t * 6, t * 6 + 6), (x) => x * tex);
}

/**
 * Conservatively rasterizes each chart into texels (shrunk by `eps` to absorb float32 noise),
 * then requires no texel to be touched by two charts and no other chart within `gutter` texels.
 */
function checkChartSeparation(m: Mesh, chartOf: Int32Array, tex: number, gutter: number) {
  const eps = 1e-3;
  const owner = new Int32Array(tex * tex).fill(-1);
  for (let t = 0; t < m.triCount; t++) {
    const tri = texelTri(m, t, tex);
    const xs = [tri[0], tri[2], tri[4]];
    const ys = [tri[1], tri[3], tri[5]];
    const cx0 = Math.max(0, Math.floor(Math.min(...xs)));
    const cx1 = Math.min(tex - 1, Math.floor(Math.max(...xs)));
    const cy0 = Math.max(0, Math.floor(Math.min(...ys)));
    const cy1 = Math.min(tex - 1, Math.floor(Math.max(...ys)));
    for (let y = cy0; y <= cy1; y++) {
      for (let x = cx0; x <= cx1; x++) {
        if (!triOverlapsBox(tri, x + eps, y + eps, x + 1 - eps, y + 1 - eps)) continue;
        const o = owner[y * tex + x];
        if (o >= 0 && o !== chartOf[t]) {
          throw new Error(`charts ${o} and ${chartOf[t]} share texel (${x}, ${y})`);
        }
        owner[y * tex + x] = chartOf[t];
      }
    }
  }
  for (let y = 0; y < tex; y++) {
    for (let x = 0; x < tex; x++) {
      const o = owner[y * tex + x];
      if (o < 0) continue;
      for (let dy = -gutter; dy <= gutter; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= tex) continue;
        for (let dx = -gutter; dx <= gutter; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= tex) continue;
          const o2 = owner[yy * tex + xx];
          if (o2 >= 0 && o2 !== o) {
            throw new Error(`charts ${o} and ${o2} within gutter at (${x}, ${y}) / (${xx}, ${yy})`);
          }
        }
      }
    }
  }
}

/** No texel center may lie strictly inside two UV triangles (catches folds within a chart too). */
function checkNoTriangleOverlap(m: Mesh, tex: number) {
  const hits = new Uint8Array(tex * tex);
  for (let t = 0; t < m.triCount; t++) {
    const [x0, y0, x1, y1, x2, y2] = texelTri(m, t, tex);
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    for (let y = Math.floor(Math.min(y0, y1, y2)); y <= Math.ceil(Math.max(y0, y1, y2)); y++) {
      for (let x = Math.floor(Math.min(x0, x1, x2)); x <= Math.ceil(Math.max(x0, x1, x2)); x++) {
        const px = x + 0.5,
          py = y + 0.5;
        const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
        const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 > 1e-6 && w1 > 1e-6 && w2 > 1e-6) {
          if (hits[y * tex + x]) throw new Error(`texel (${x}, ${y}) covered twice`);
          hits[y * tex + x] = 1;
        }
      }
    }
  }
}

/** Per chart: standard deviation of log(UV area / 3D area) over non-degenerate triangles. */
function chartLogAreaStddev(m: Mesh, chartOf: Int32Array, count: number) {
  const n = new Float64Array(count),
    s = new Float64Array(count),
    s2 = new Float64Array(count);
  for (let t = 0; t < m.triCount; t++) {
    const a3 = area3(m, t);
    if (a3 <= 1e-12) continue;
    const x = Math.log(uvSignedArea(m, t) / a3);
    const c = chartOf[t];
    n[c]++;
    s[c] += x;
    s2[c] += x * x;
  }
  return Array.from({ length: count }, (_, c) => {
    if (n[c] === 0) return 0;
    const mean = s[c] / n[c];
    return Math.sqrt(Math.max(0, s2[c] / n[c] - mean * mean));
  });
}

describe("unwrapMesh", () => {
  for (const type of allTypes) {
    for (const density of densities) {
      describe(`type ${type}, density ${density}`, () => {
        const m = makePrimitive(params(type, density));
        unwrapMesh(m);
        const { chartOf, count } = chartsFromUVs(m);

        it("keeps every UV inside the border gutter", () => {
          expect(m.uvs.length).toBe(m.triCount * 6);
          const lo = GUTTER / TEX - 1e-6;
          const hi = 1 - GUTTER / TEX + 1e-6;
          expect(Math.min(...m.uvs)).toBeGreaterThanOrEqual(lo);
          expect(Math.max(...m.uvs)).toBeLessThanOrEqual(hi);
        });

        it("has no flipped or degenerate UV triangles (positive signed area)", () => {
          let minArea = Infinity;
          for (let t = 0; t < m.triCount; t++) minArea = Math.min(minArea, uvSignedArea(m, t) * TEX * TEX);
          expect(minArea, "smallest UV triangle area in texels").toBeGreaterThan(1e-4);
        });

        it("keeps charts apart by at least the gutter, and never overlaps triangles", () => {
          expect(count).toBeGreaterThanOrEqual(6);
          checkChartSeparation(m, chartOf, TEX, GUTTER);
          checkNoTriangleOverlap(m, TEX);
        });

        it("does not make area distortion worse when relaxing", () => {
          const raw = makePrimitive(params(type, density));
          unwrapMesh(raw, { relaxRounds: 0 });
          const before = chartLogAreaStddev(raw, chartOf, count);
          const after = chartLogAreaStddev(m, chartOf, count);
          const worse = after.flatMap((a, c) =>
            a > before[c] + 1e-4 ? [`chart ${c}: ${before[c]} -> ${a}`] : [],
          );
          expect(worse).toEqual([]);
        });
      });
    }
  }

  it("cube at density 2 has exactly 6 charts", () => {
    const m = makePrimitive(params(PrimitiveType.CUBE, 2));
    unwrapMesh(m);
    const { count } = chartsFromUVs(m);
    expect(count).toBe(6);
  });

  it("relaxation measurably reduces distortion on curved shapes", () => {
    for (const type of [PrimitiveType.UV_SPHERE, PrimitiveType.ICOSPHERE, PrimitiveType.TORUS]) {
      const relaxed = makePrimitive(params(type, 16));
      unwrapMesh(relaxed);
      const raw = makePrimitive(params(type, 16));
      unwrapMesh(raw, { relaxRounds: 0 });
      const { chartOf, count } = chartsFromUVs(relaxed);
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      const before = sum(chartLogAreaStddev(raw, chartOf, count));
      const after = sum(chartLogAreaStddev(relaxed, chartOf, count));
      expect(after, `type ${type}`).toBeLessThan(before * 0.9);
    }
  });

  it("honours texSize and gutterTexels", () => {
    const m = makePrimitive(params(PrimitiveType.TORUS, 8));
    unwrapMesh(m, { texSize: 256, gutterTexels: 8 });
    const { chartOf } = chartsFromUVs(m);
    expect(Math.min(...m.uvs)).toBeGreaterThanOrEqual(8 / 256 - 1e-6);
    expect(Math.max(...m.uvs)).toBeLessThanOrEqual(1 - 8 / 256 + 1e-6);
    checkChartSeparation(m, chartOf, 256, 8);
  });

  it("unwraps ~100k triangles quickly", () => {
    const m = makePrimitive(params(PrimitiveType.UV_SPHERE, 160));
    expect(m.triCount).toBeGreaterThan(90_000);
    const t0 = performance.now();
    unwrapMesh(m);
    const ms = performance.now() - t0;
    console.log(`unwrap ${m.triCount} tris: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(2000);
  });
});
