import { describe, expect, it } from "vitest";
import { Mesh, PrimitiveParams, PrimitiveType } from "../src/mesh/mesh";
import { makePrimitive } from "../src/mesh/primitives";
import { computeCurvature, expandRings, updateCurvature } from "../src/mesh/curvature";

function params(type: PrimitiveType, density: number, radius = 1, radius2 = 0.35) {
  const p = new PrimitiveParams();
  p.type = type;
  p.density = density;
  p.radius = radius;
  p.radius2 = radius2;
  return p;
}

function pos(m: Mesh, v: number): [number, number, number] {
  return [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]];
}

describe("curvature", () => {
  it("sphere: H = k1 = k2 = 1/R", () => {
    const R = 2;
    const m = makePrimitive(params(PrimitiveType.UV_SPHERE, 32, R));
    const c = computeCurvature(m);
    let maxErrH = 0,
      maxAniso = 0;
    for (let v = 0; v < m.vertCount; v++) {
      maxErrH = Math.max(maxErrH, Math.abs(c.H[v] * R - 1));
      maxAniso = Math.max(maxAniso, Math.abs(c.k1[v] - c.k2[v]) * R);
    }
    console.log(`sphere: max |H R - 1| = ${maxErrH.toFixed(4)}, max |k1-k2| R = ${maxAniso.toFixed(4)}`);
    expect(maxErrH).toBeLessThan(0.03);
    expect(maxAniso).toBeLessThan(0.05);
  });

  it("icosphere: H = 1/R", () => {
    const m = makePrimitive(params(PrimitiveType.ICOSPHERE, 32, 1));
    const c = computeCurvature(m);
    let maxErrH = 0;
    for (let v = 0; v < m.vertCount; v++) maxErrH = Math.max(maxErrH, Math.abs(c.H[v] - 1));
    console.log(`icosphere: max |H - 1| = ${maxErrH.toFixed(4)}`);
    expect(maxErrH).toBeLessThan(0.03);
  });

  it("capsule straight part: k1 = 1/r around, k2 = 0 along, H = 1/(2r)", () => {
    const prm = params(PrimitiveType.CAPSULE, 24);
    const m = makePrimitive(prm);
    const c = computeCurvature(m);
    const r = prm.radius * 0.5,
      h = prm.radius2 * 2;
    let count = 0,
      maxK1 = 0,
      maxK2 = 0,
      maxH = 0,
      maxDirY = 0;
    for (let v = 0; v < m.vertCount; v++) {
      const [, y] = pos(m, v);
      if (Math.abs(y) > h * 0.7) continue; // keep away from the cap junction
      count++;
      maxK1 = Math.max(maxK1, Math.abs(c.k1[v] * r - 1));
      maxK2 = Math.max(maxK2, Math.abs(c.k2[v] * r));
      maxH = Math.max(maxH, Math.abs(c.H[v] * 2 * r - 1));
      maxDirY = Math.max(maxDirY, Math.abs(c.dir1[v * 3 + 1]));
    }
    console.log(
      `capsule (${count} verts): max |k1 r - 1| = ${maxK1.toFixed(4)}, max |k2 r| = ${maxK2.toFixed(4)}, ` +
        `max |2Hr - 1| = ${maxH.toFixed(4)}, max |dir1.y| = ${maxDirY.toFixed(4)}`,
    );
    expect(count).toBeGreaterThan(50);
    expect(maxK1).toBeLessThan(0.03);
    expect(maxK2).toBeLessThan(0.03);
    expect(maxH).toBeLessThan(0.03);
    // the curved direction runs around the cylinder, not along its axis
    expect(maxDirY).toBeLessThan(0.05);
  });

  it("torus: matches the analytic H, positive outside, negative inside", () => {
    // radius2 = 0.6 makes the tube (0.45) wider than half the major radius (0.75), so the
    // inner equator is saddle-dominated and H < 0 there
    const prm = params(PrimitiveType.TORUS, 32, 1, 0.6);
    const m = makePrimitive(prm);
    const c = computeCurvature(m);
    const R = 0.75 * prm.radius,
      r = 0.75 * prm.radius2;
    let maxErr = 0,
      outer = 0,
      inner = 0;
    for (let v = 0; v < m.vertCount; v++) {
      const [x, y, z] = pos(m, v);
      const d = Math.hypot(x, z);
      const cosPhi = (d - R) / r;
      const Hexact = 0.5 * (1 / r + cosPhi / d);
      maxErr = Math.max(maxErr, Math.abs(c.H[v] - Hexact) / Math.abs(1 / r));
      if (Math.abs(y) < 1e-4) {
        if (d > R) {
          expect(c.H[v]).toBeGreaterThan(0);
          outer++;
        } else {
          expect(c.H[v]).toBeLessThan(0);
          inner++;
        }
      }
    }
    console.log(`torus: max |H - H_exact| / (1/r) = ${maxErr.toFixed(4)}`);
    expect(outer).toBeGreaterThan(0);
    expect(inner).toBeGreaterThan(0);
    expect(maxErr).toBeLessThan(0.03);
  });

  it("updateCurvature on the 2-ring matches a full recompute", () => {
    const m = makePrimitive(params(PrimitiveType.UV_SPHERE, 16));
    const field = computeCurvature(m);

    // deterministic pseudo-random displacement of a small patch
    const moved = [40, 41, 57, 58, 90];
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
    for (const v of moved) {
      for (let i = 0; i < 3; i++) m.positions[v * 3 + i] += 0.05 * rnd();
    }
    m.computeNormals(expandRings(m, moved, 1));
    const ring2 = expandRings(m, moved, 2);
    updateCurvature(m, field, ring2);

    const fresh = computeCurvature(m);
    let changed = 0;
    for (let v = 0; v < m.vertCount; v++) {
      expect(field.H[v]).toBe(fresh.H[v]);
      expect(field.k1[v]).toBe(fresh.k1[v]);
      expect(field.k2[v]).toBe(fresh.k2[v]);
      for (let i = 0; i < 3; i++) expect(field.dir1[v * 3 + i]).toBe(fresh.dir1[v * 3 + i]);
      if (Math.abs(fresh.H[v] - 1) > 1e-3) changed++;
    }
    // the perturbation really did change the curvature somewhere
    expect(changed).toBeGreaterThan(0);

    // and the 1-ring alone is not enough
    const stale = computeCurvature(makePrimitive(params(PrimitiveType.UV_SPHERE, 16)));
    updateCurvature(m, stale, expandRings(m, moved, 1));
    let diffs = 0;
    for (let v = 0; v < m.vertCount; v++) if (stale.H[v] !== fresh.H[v]) diffs++;
    expect(diffs).toBeGreaterThan(0);
  });
});
