import { describe, expect, it } from "vitest";
import { PrimitiveParams, PrimitiveType } from "../src/mesh/mesh";
import { makePrimitive } from "../src/mesh/primitives";
import { TriBVH } from "../src/mesh/bvh";
import { fromHalf, toHalf } from "../src/math/half";

describe("TriBVH", () => {
  const params = new PrimitiveParams();
  params.type = PrimitiveType.ICOSPHERE;
  params.density = 32;
  const mesh = makePrimitive(params);
  const bvh = new TriBVH(mesh);

  it("raycasts a sphere at roughly radius distance", () => {
    for (const dir of [
      [0, 0, -1],
      [0.3, -0.2, -0.9],
      [-1, 0, 0],
    ]) {
      const l = Math.hypot(dir[0], dir[1], dir[2]);
      const d = dir.map((x) => x / l);
      const origin = d.map((x) => -x * 5);
      const hit = bvh.raycast(origin, d);
      expect(hit).toBeDefined();
      expect(hit!.t).toBeGreaterThan(3.9);
      expect(hit!.t).toBeLessThan(4.01);
    }
  });

  it("misses when the ray passes outside", () => {
    expect(bvh.raycast([0, 2, 5], [0, 0, -1])).toBeUndefined();
  });

  it("sphere query finds every triangle with a vertex inside the sphere", () => {
    const center = [0.2, 0.9, 0.3];
    const radius = 0.4;
    const found = new Set<number>();
    bvh.querySphere(center, radius, (t) => found.add(t));
    for (let t = 0; t < mesh.triCount; t++) {
      for (let k = 0; k < 3; k++) {
        const v = mesh.tris[t * 3 + k];
        const d = Math.hypot(
          mesh.positions[v * 3] - center[0],
          mesh.positions[v * 3 + 1] - center[1],
          mesh.positions[v * 3 + 2] - center[2],
        );
        if (d < radius) expect(found.has(t)).toBe(true);
      }
    }
  });

  it("refit follows moved vertices", () => {
    const m2 = makePrimitive(params);
    const b2 = new TriBVH(m2);
    for (let i = 0; i < m2.positions.length; i++) m2.positions[i] *= 2;
    b2.refit();
    const hit = b2.raycast([0, 0, 5], [0, 0, -1]);
    expect(hit!.t).toBeLessThan(3.01);
  });
});

describe("half floats", () => {
  it("round-trips representable values and rounds others", () => {
    for (const x of [0, 1, -2, 0.5, 3, 1024, 65504, 2 ** -14, 2 ** -20]) {
      expect(fromHalf(toHalf(x))).toBe(x);
    }
    expect(fromHalf(toHalf(0.1))).toBeCloseTo(0.1, 3);
    expect(fromHalf(toHalf(1e6))).toBe(Infinity);
  });
});
