import { describe, expect, it } from "vitest";
import { Mesh, PrimitiveParams, PrimitiveType } from "../src/mesh/mesh";
import { makePrimitive } from "../src/mesh/primitives";
import { unwrapMesh } from "../src/uv/unwrap";
import { subdivideSmooth } from "../src/mesh/subdivide";

function sphere(density = 8) {
  const p = new PrimitiveParams();
  p.type = PrimitiveType.UV_SPHERE;
  p.density = density;
  const m = makePrimitive(p);
  unwrapMesh(m);
  return m;
}

function edgeCount(m: Mesh) {
  const s = new Set<number>();
  const nv = m.vertCount;
  for (let t = 0; t < m.triCount; t++)
    for (let k = 0; k < 3; k++) {
      const a = m.tris[t * 3 + k],
        b = m.tris[t * 3 + ((k + 1) % 3)];
      s.add(Math.min(a, b) * nv + Math.max(a, b));
    }
  return s.size;
}

/** Every directed edge appears once and has its twin: closed and consistently wound. */
function badEdges(m: Mesh) {
  const nv = m.vertCount;
  const directed = new Map<number, number>();
  for (let t = 0; t < m.triCount; t++)
    for (let k = 0; k < 3; k++) {
      const key = m.tris[t * 3 + k] * nv + m.tris[t * 3 + ((k + 1) % 3)];
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  let bad = 0;
  for (const [key, count] of directed) {
    if (count !== 1 || !directed.has((key % nv) * nv + Math.floor(key / nv))) bad++;
  }
  return bad;
}

/** Mean and spread of the vertices' distance from the origin. */
function radial(m: Mesh) {
  const r = Array.from({ length: m.vertCount }, (_, v) =>
    Math.hypot(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]),
  );
  const mean = r.reduce((x, y) => x + y, 0) / r.length;
  const sd = Math.sqrt(r.reduce((x, y) => x + (y - mean) ** 2, 0) / r.length);
  return { mean, sd };
}

describe("subdivideSmooth", () => {
  it("splits 1 to 4, stays closed and keeps the winding", () => {
    const m = sphere();
    const s = subdivideSmooth(m, { factor: 0 });
    expect(s.vertCount).toBe(m.vertCount + edgeCount(m));
    expect(s.triCount).toBe(m.triCount * 4);
    expect(badEdges(s)).toBe(0);
    expect(s.isAnalytic).toBe(false);
    // original vertices keep their index and, with factor 0, their position
    expect(Array.from(s.positions.subarray(0, m.positions.length))).toEqual(Array.from(m.positions));
  });

  it("keeps the UV layout: child corners are the parent's barycentric points", () => {
    const m = sphere();
    const s = subdivideSmooth(m);
    for (let t = 0; t < m.triCount; t++) {
      const P = (k: number) => [m.uvs[t * 6 + k * 2], m.uvs[t * 6 + k * 2 + 1]];
      const mid = (a: number, b: number) => [(P(a)[0] + P(b)[0]) / 2, (P(a)[1] + P(b)[1]) / 2];
      const want = [P(0), mid(0, 1), mid(2, 0), mid(0, 1), P(1), mid(1, 2), mid(2, 0), mid(1, 2), P(2)];
      for (let j = 0; j < 9; j++) {
        expect(s.uvs[t * 24 + j * 2]).toBeCloseTo(want[j][0], 6);
        expect(s.uvs[t * 24 + j * 2 + 1]).toBeCloseTo(want[j][1], 6);
      }
    }
  });

  it("averages the correction map onto midpoints", () => {
    const m = sphere();
    m.cAbs.fill(0.25);
    m.cRel.fill(2);
    const s = subdivideSmooth(m);
    expect(s.cAbs.every((x) => x === 0.25)).toBe(true);
    expect(s.cRel.every((x) => x === 2)).toBe(true);
  });

  it("smoothing rounds a sphere without shrinking it (Taubin)", () => {
    const m = sphere(12);
    const split = radial(subdivideSmooth(m, { factor: 0 }));
    const taubin = radial(subdivideSmooth(m, { factor: 0.5, iterations: 3 }));
    const plain = radial(subdivideSmooth(m, { factor: 0.5, iterations: 3, keepVolume: false }));
    expect(taubin.sd).toBeLessThan(split.sd);
    expect(Math.abs(taubin.mean - split.mean)).toBeLessThan(0.002);
    // without the μ step it shrinks
    expect(plain.mean).toBeLessThan(split.mean - 0.002);
  });

  it("moves vertices only along the normal: an irregular flat grid does not change", () => {
    const n = 5,
      pos: number[] = [],
      tris: number[] = [];
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.6;
    for (let y = 0; y <= n; y++)
      for (let x = 0; x <= n; x++) {
        const inner = x > 0 && y > 0 && x < n && y < n;
        pos.push(x + (inner ? rnd() : 0), y + (inner ? rnd() : 0), 0);
      }
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const a = y * (n + 1) + x;
        tris.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
      }
    const m = Mesh.fromArrays(pos, tris);
    const split = subdivideSmooth(m, { factor: 0 });
    const s = subdivideSmooth(m, { factor: 1, iterations: 3 });
    for (let i = 0; i < s.positions.length; i++) expect(s.positions[i]).toBeCloseTo(split.positions[i], 6);
  });

  it("stays finite on degenerate triangles", () => {
    // octahedron with one vertex moved onto an edge, so two triangles are collinear
    const pos = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
    const tris = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];
    pos.splice(12, 3, 0.5, 0.5, 0);
    const s = subdivideSmooth(Mesh.fromArrays(pos, tris), { factor: 0.5, iterations: 2 });
    expect(s.positions.every(Number.isFinite)).toBe(true);
  });
});
