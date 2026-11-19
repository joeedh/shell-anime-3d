import { describe, expect, it } from "vitest";
import { Mesh, PrimitiveParams, PrimitiveType } from "../src/mesh/mesh";
import { makePrimitive } from "../src/mesh/primitives";
import { butterflySubdivide } from "../src/mesh/butterfly";

function params(type: PrimitiveType, density: number, radius = 1) {
  const p = new PrimitiveParams();
  p.type = type;
  p.density = density;
  p.radius = radius;
  return p;
}

/** Every directed edge appears once and has its twin: closed and consistently wound. */
function checkClosedManifold(tris: Uint32Array, nv: number) {
  const directed = new Map<number, number>();
  for (let t = 0; t < tris.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const key = tris[t * 3 + k] * nv + tris[t * 3 + ((k + 1) % 3)];
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const [key, count] of directed) {
    const a = Math.floor(key / nv),
      b = key % nv;
    if (count !== 1 || !directed.has(b * nv + a)) bad++;
  }
  expect(bad).toBe(0);
}

/** Radial error stats of points with index >= `from`. */
function radialStats(p: ArrayLike<number>, from: number, R: number) {
  let max = 0,
    sum = 0,
    n = 0;
  for (let v = from; v < p.length / 3; v++) {
    const e = Math.hypot(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]) - R;
    max = Math.max(max, Math.abs(e));
    sum += e;
    n++;
  }
  return { max, mean: sum / n };
}

/** Radial error of plain edge midpoints of the input mesh (what linear subdivision gives). */
function midpointStats(m: Mesh, R: number) {
  const mids: number[] = [];
  const p = m.positions;
  for (let t = 0; t < m.triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = m.tris[t * 3 + k],
        b = m.tris[t * 3 + ((k + 1) % 3)];
      if (a > b) continue;
      for (let i = 0; i < 3; i++) mids.push((p[a * 3 + i] + p[b * 3 + i]) / 2);
    }
  }
  return radialStats(mids, 0, R);
}

/** Gives each corner a distinct UV so interpolation can be checked. */
function scrambleUvs(m: Mesh) {
  for (let i = 0; i < m.uvs.length; i++) m.uvs[i] = Math.fround(Math.sin(i * 12.9898) * 0.5 + 0.5);
}

describe("butterfly subdivision", () => {
  it("keeps the original vertices exactly and multiplies triangles by 4 per level", () => {
    const m = makePrimitive(params(PrimitiveType.UV_SPHERE, 8));
    for (let levels = 0; levels <= 3; levels++) {
      const r = butterflySubdivide(m, levels);
      expect(r.tris.length).toBe(m.tris.length * 4 ** levels);
      expect(r.uvs.length).toBe(r.tris.length * 2);
      expect(r.parentTri.length).toBe(r.tris.length / 3);
      for (let i = 0; i < m.positions.length; i++) expect(r.positions[i]).toBe(m.positions[i]);
    }
  });

  it("produces a closed, consistently wound mesh", () => {
    for (const type of [PrimitiveType.UV_SPHERE, PrimitiveType.ICOSPHERE, PrimitiveType.TORUS]) {
      const r = butterflySubdivide(makePrimitive(params(type, 8)), 2);
      checkClosedManifold(r.tris, r.positions.length / 3);
    }
  });

  it("stays on the sphere far better than midpoints, without shrinking", () => {
    // UV sphere at density 16: its poles have valence 32 and the first ring valence 5, the
    // worst case for butterfly, so its error peaks there
    for (const [type, density] of [
      [PrimitiveType.ICOSPHERE, 8],
      [PrimitiveType.UV_SPHERE, 16],
    ] as const) {
      const R = 1.5;
      const m = makePrimitive(params(type, density, R));
      const mid = midpointStats(m, R);
      const r1 = butterflySubdivide(m, 1);
      const b1 = radialStats(r1.positions, m.vertCount, R);
      const r3 = butterflySubdivide(m, 3);
      const b3 = radialStats(r3.positions, m.vertCount, R);
      console.log(
        `type ${type}: midpoint max ${mid.max.toFixed(5)} mean ${mid.mean.toFixed(5)}; ` +
          `butterfly L1 max ${b1.max.toFixed(5)} mean ${b1.mean.toFixed(5)}; ` +
          `L3 max ${b3.max.toFixed(5)} mean ${b3.mean.toFixed(5)}`,
      );
      expect(b1.max).toBeLessThan(mid.max * 0.25);
      expect(b3.max).toBeLessThan(mid.max * 0.25);
      // Loop-style shrinkage would make the mean error a sizeable negative fraction of the sag
      expect(Math.abs(b1.mean)).toBeLessThan(Math.abs(mid.mean) * 0.1);
      expect(Math.abs(b3.mean)).toBeLessThan(Math.abs(mid.mean) * 0.1);
    }
  });

  it("interpolates UVs linearly inside each parent triangle", () => {
    const m = makePrimitive(params(PrimitiveType.ICOSPHERE, 8));
    scrambleUvs(m);
    const r = butterflySubdivide(m, 3);
    let maxOut = 0,
      maxDyadic = 0;
    for (let t = 0; t < r.tris.length / 3; t++) {
      const p = r.parentTri[t];
      const [ax, ay, bx, by, cx, cy] = Array.from(m.uvs.subarray(p * 6, p * 6 + 6));
      const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      for (let k = 0; k < 3; k++) {
        const x = r.uvs[t * 6 + k * 2],
          y = r.uvs[t * 6 + k * 2 + 1];
        const l1 = ((x - ax) * (cy - ay) - (cx - ax) * (y - ay)) / det;
        const l2 = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / det;
        const l0 = 1 - l1 - l2;
        maxOut = Math.max(maxOut, -l0, -l1, -l2);
        // linear subdivision only ever produces dyadic barycentrics: multiples of 1/8 at level 3
        for (const l of [l1, l2]) maxDyadic = Math.max(maxDyadic, Math.abs(l * 8 - Math.round(l * 8)));
      }
    }
    expect(maxOut).toBeLessThan(1e-4);
    expect(maxDyadic).toBeLessThan(1e-3);

    // corners of the first child keep the parent's corner UV exactly
    for (let t = 0; t < m.triCount; t++) {
      expect(r.uvs[t * 64 * 6]).toBe(m.uvs[t * 6]);
      expect(r.uvs[t * 64 * 6 + 1]).toBe(m.uvs[t * 6 + 1]);
    }
  });

  it("falls back to midpoints on an open mesh without crashing", () => {
    const m = Mesh.fromArrays([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 1, 2, 0, 2, 3]);
    const r = butterflySubdivide(m, 2);
    expect(r.tris.length).toBe(m.tris.length * 16);
    for (let i = 0; i < r.positions.length; i++) {
      expect(Number.isFinite(r.positions[i])).toBe(true);
      if (i % 3 === 2) expect(r.positions[i]).toBe(0);
    }
  });

  it("subdivides ~20k triangles three levels quickly", () => {
    const m = makePrimitive(params(PrimitiveType.UV_SPHERE, 72));
    expect(m.triCount).toBeGreaterThan(19000);
    butterflySubdivide(m, 1); // warm-up
    const t0 = performance.now();
    const r = butterflySubdivide(m, 3);
    const ms = performance.now() - t0;
    console.log(
      `butterfly: ${m.triCount} tris x3 levels -> ${r.tris.length / 3} tris in ${ms.toFixed(0)} ms`,
    );
    expect(ms).toBeLessThan(1500);
  });
});
