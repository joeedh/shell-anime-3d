import { describe, expect, it } from "vitest";
import { PrimitiveParams, PrimitiveType } from "../src/mesh/mesh";
import { makePrimitive } from "../src/mesh/primitives";
import { solveCorrection } from "../src/solver/correction";

function prim(type: number, density: number) {
  const p = new PrimitiveParams();
  p.type = type as PrimitiveParams["type"];
  p.density = density;
  return makePrimitive(p);
}

describe("correction-map solver", () => {
  for (const [name, type, density] of [
    ["uv sphere", PrimitiveType.UV_SPHERE, 12],
    ["torus", PrimitiveType.TORUS, 10],
    ["capsule", PrimitiveType.CAPSULE, 8],
    ["cube", PrimitiveType.CUBE, 6],
  ] as const) {
    it(`closes the shell's reach deficit on a ${name}`, () => {
      const mesh = prim(type, density);
      const before = solveCorrection(mesh, { rounds: 0, safety: 1 });
      const after = solveCorrection(mesh);
      // the unsolved shell falls short somewhere (faceting), the solved one does not
      expect(before.residual).toBeGreaterThan(1e-3);
      expect(after.residual).toBeLessThan(1e-3);
      expect(after.failing).toBe(0);
      for (const x of after.cAbs) expect(Number.isFinite(x) && x >= 0).toBe(true);
      for (const x of after.cRel) expect(Number.isFinite(x) && x >= 0).toBe(true);
    });
  }

  it("matches the sphere's faceting depth in size", () => {
    const mesh = prim(PrimitiveType.UV_SPHERE, 16);
    const res = solveCorrection(mesh);
    // a 32-segment ring sags R(1 - cos(pi/32)) ~ 4.8e-3 at an edge midpoint; faces sag more
    const sorted = Array.from(res.cAbs).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(median).toBeGreaterThan(2e-3);
    expect(median).toBeLessThan(3e-2);
  });
});
