import { describe, expect, it } from "vitest";
import { PrimitiveParams, PrimitiveType } from "../src/mesh/mesh";
import { makePrimitive } from "../src/mesh/primitives";
import { buildReferenceMesh, referenceLevels, REF_MAX_TRIS } from "../src/render/reference/refmesh";

describe("reference mesh", () => {
  it("uses up to 3 butterfly levels, capped by the triangle budget", () => {
    expect(referenceLevels(100)).toBe(3);
    expect(referenceLevels(REF_MAX_TRIS / 16)).toBe(2);
    expect(referenceLevels(REF_MAX_TRIS)).toBe(0);
  });

  it("projects an analytic sphere onto the true surface, with kmax near 1/R", () => {
    const p = new PrimitiveParams();
    p.type = PrimitiveType.UV_SPHERE;
    p.density = 8;
    const src = makePrimitive(p);
    const ref = buildReferenceMesh(src);
    expect(ref.levels).toBe(3);
    expect(ref.mesh.triCount).toBe(src.triCount * 64);
    const pos = ref.mesh.positions;
    for (let i = 0; i < pos.length; i += 3) {
      expect(Math.hypot(pos[i], pos[i + 1], pos[i + 2])).toBeCloseTo(p.radius, 5);
    }
    const k = Array.from(ref.kmax).sort((a, b) => a - b);
    expect(k[Math.floor(k.length / 2)]).toBeCloseTo(1 / p.radius, 1);
    expect(ref.mesh.uvs.length).toBe(ref.mesh.triCount * 6);
  });

  it("keeps the cube's original vertices (butterfly interpolates)", () => {
    const p = new PrimitiveParams();
    p.type = PrimitiveType.CUBE;
    p.density = 4;
    const src = makePrimitive(p);
    const ref = buildReferenceMesh(src);
    for (let i = 0; i < src.positions.length; i++) {
      expect(ref.mesh.positions[i]).toBeCloseTo(src.positions[i], 6);
    }
  });
});
