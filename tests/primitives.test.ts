import { describe, expect, it } from "vitest";
import { Mesh, PrimitiveParams, PrimitiveType } from "../src/mesh/mesh";
import { makePrimitive, projectToAnalytic } from "../src/mesh/primitives";

function params(type: PrimitiveType, density = 8) {
  const p = new PrimitiveParams();
  p.type = type;
  p.density = density;
  return p;
}

/** Every directed edge must appear once, and its reverse once: closed, consistently wound. */
function checkClosedManifold(m: Mesh) {
  const directed = new Map<string, number>();
  for (let t = 0; t < m.triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = m.tris[t * 3 + k];
      const b = m.tris[t * 3 + ((k + 1) % 3)];
      const key = `${a},${b}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of directed) {
    expect(count, `directed edge ${key} repeated`).toBe(1);
    const [a, b] = key.split(",");
    expect(directed.has(`${b},${a}`), `edge ${key} has no twin`).toBe(true);
  }
}

function signedVolume(m: Mesh) {
  const p = m.positions;
  let vol = 0;
  for (let t = 0; t < m.triCount; t++) {
    const [a, b, c] = [m.tris[t * 3], m.tris[t * 3 + 1], m.tris[t * 3 + 2]];
    vol +=
      (p[a * 3] * (p[b * 3 + 1] * p[c * 3 + 2] - p[b * 3 + 2] * p[c * 3 + 1]) -
        p[a * 3 + 1] * (p[b * 3] * p[c * 3 + 2] - p[b * 3 + 2] * p[c * 3]) +
        p[a * 3 + 2] * (p[b * 3] * p[c * 3 + 1] - p[b * 3 + 1] * p[c * 3])) /
      6;
  }
  return vol;
}

const allTypes = [
  PrimitiveType.CUBE,
  PrimitiveType.UV_SPHERE,
  PrimitiveType.ICOSPHERE,
  PrimitiveType.CAPSULE,
  PrimitiveType.TORUS,
];

describe("primitives", () => {
  for (const type of allTypes) {
    it(`type ${type} is closed, outward-wound, with outward normals`, () => {
      const m = makePrimitive(params(type));
      expect(m.triCount).toBeGreaterThan(0);
      checkClosedManifold(m);
      expect(signedVolume(m)).toBeGreaterThan(0);

      // normals point away from the centroid for these star-shaped (or torus) shapes
      if (type !== PrimitiveType.TORUS) {
        let outward = 0;
        for (let v = 0; v < m.vertCount; v++) {
          const d =
            m.positions[v * 3] * m.normals[v * 3] +
            m.positions[v * 3 + 1] * m.normals[v * 3 + 1] +
            m.positions[v * 3 + 2] * m.normals[v * 3 + 2];
          if (d > 0) outward++;
        }
        expect(outward).toBe(m.vertCount);
      }
    });
  }

  it("density changes resolution", () => {
    const a = makePrimitive(params(PrimitiveType.UV_SPHERE, 4));
    const b = makePrimitive(params(PrimitiveType.UV_SPHERE, 16));
    expect(b.triCount).toBeGreaterThan(a.triCount * 4);
  });

  it("analytic projection is idempotent on the generated vertices", () => {
    for (const type of [PrimitiveType.UV_SPHERE, PrimitiveType.CAPSULE, PrimitiveType.TORUS]) {
      const prm = params(type);
      const m = makePrimitive(prm);
      for (let v = 0; v < m.vertCount; v++) {
        const p: [number, number, number] = [
          m.positions[v * 3],
          m.positions[v * 3 + 1],
          m.positions[v * 3 + 2],
        ];
        const q = projectToAnalytic(prm, p);
        expect(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])).toBeLessThan(1e-5);
      }
    }
  });
});
