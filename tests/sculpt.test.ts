import { describe, expect, it } from "vitest";
import { PrimitiveParams, PrimitiveType } from "../src/mesh/mesh";
import { makePrimitive } from "../src/mesh/primitives";
import { TriBVH } from "../src/mesh/bvh";
import { computeCurvature, updateCurvature } from "../src/mesh/curvature";
import { SculptBrush, sculptDab, updateAfterMove } from "../src/sculpt/sculpt";
import type { V3 } from "../src/sculpt/sculpt";

function sphere() {
  const p = new PrimitiveParams();
  p.type = PrimitiveType.UV_SPHERE;
  p.density = 16;
  return makePrimitive(p);
}

const radiusOf = (m: ReturnType<typeof sphere>, v: number) =>
  Math.hypot(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]);

describe("sculpt brushes", () => {
  it("draw pushes vertices outward inside the radius only", () => {
    const mesh = sphere();
    const bvh = new TriBVH(mesh);
    const before = Float32Array.from(mesh.positions);
    const orig = new Map<number, V3>();
    const center = [1, 0, 0];
    const moved = sculptDab(
      mesh,
      bvh,
      { center, radius: 0.4, strength: 0.2, hardness: 0.3, brush: SculptBrush.DRAW },
      orig,
    );
    expect(moved.length).toBeGreaterThan(3);
    for (let v = 0; v < mesh.vertCount; v++) {
      const d = Math.hypot(before[v * 3] - 1, before[v * 3 + 1], before[v * 3 + 2]);
      if (d >= 0.4) {
        expect(mesh.positions[v * 3]).toBe(before[v * 3]);
      } else if (d < 0.1) {
        expect(radiusOf(mesh, v)).toBeGreaterThan(1.05);
      }
    }
    // orig holds the starting positions of exactly the moved vertices
    for (const v of moved) expect(orig.get(v)![0]).toBe(before[v * 3]);
  });

  it("smooth flattens a spike", () => {
    const mesh = sphere();
    const bvh = new TriBVH(mesh);
    const orig = new Map<number, V3>();
    // the vertex nearest +x, pulled out to make a spike
    let tip = 0;
    for (let v = 0; v < mesh.vertCount; v++) if (mesh.positions[v * 3] > mesh.positions[tip * 3]) tip = v;
    mesh.positions[tip * 3] *= 1.5;
    updateAfterMove(mesh, [tip]);
    bvh.refit();
    const spike = radiusOf(mesh, tip);
    for (let i = 0; i < 5; i++) {
      sculptDab(
        mesh,
        bvh,
        { center: [1.2, 0, 0], radius: 0.6, strength: 0.5, hardness: 0.5, brush: SculptBrush.SMOOTH },
        orig,
      );
    }
    expect(radiusOf(mesh, tip)).toBeLessThan(spike - 0.2);
  });

  it("incremental normals and curvature (2-ring) match a full recompute", () => {
    const mesh = sphere();
    const bvh = new TriBVH(mesh);
    const field = computeCurvature(mesh);
    const moved = sculptDab(
      mesh,
      bvh,
      { center: [0, 1, 0.2], radius: 0.5, strength: 0.3, hardness: 0.2, brush: SculptBrush.DRAW },
      new Map(),
    );
    const ring2 = updateAfterMove(mesh, moved);
    updateCurvature(mesh, field, ring2);

    const normals = Float32Array.from(mesh.normals);
    mesh.computeNormals();
    const full = computeCurvature(mesh);
    for (let i = 0; i < normals.length; i++) expect(normals[i]).toBeCloseTo(mesh.normals[i], 6);
    for (let v = 0; v < mesh.vertCount; v++) {
      expect(field.H[v]).toBeCloseTo(full.H[v], 4);
      expect(field.k1[v]).toBeCloseTo(full.k1[v], 4);
    }
  });
});
