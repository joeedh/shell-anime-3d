import { describe, expect, it } from "vitest";
import { Mesh, PrimitiveParams, PrimitiveType } from "../src/mesh/mesh";
import { makePrimitive } from "../src/mesh/primitives";
import { triNeighbours } from "../src/mesh/adjacency";
import { TriBVH } from "../src/mesh/bvh";
import { pnClosest, pnControlPoints, pnEval } from "../src/math/pn";
import type { PNMesh, PNPatch, Vec3 } from "../src/math/pn";

const vtx = (a: Float32Array, i: number): Vec3 => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];

function pnMesh(mesh: Mesh): PNMesh {
  const nb = triNeighbours(mesh);
  const cache = new Map<number, PNPatch>();
  const corners = (t: number): [number, number, number] => [
    mesh.tris[t * 3],
    mesh.tris[t * 3 + 1],
    mesh.tris[t * 3 + 2],
  ];
  return {
    corners,
    neighbour: (t, k) => nb[t * 3 + k],
    positions: (t) => corners(t).map((v) => vtx(mesh.positions, v)) as [Vec3, Vec3, Vec3],
    patch(t) {
      let p = cache.get(t);
      if (!p) {
        const ids = corners(t);
        p = pnControlPoints(
          ids.map((v) => vtx(mesh.positions, v)),
          ids.map((v) => vtx(mesh.normals, v)),
        );
        cache.set(t, p);
      }
      return p;
    },
  };
}

function sphere(density: number) {
  const p = new PrimitiveParams();
  p.type = PrimitiveType.UV_SPHERE;
  p.density = density;
  return makePrimitive(p);
}

/** The shell's back face hit by a ray: what the GPU's front-culled inverted hull draws. */
function shellFragment(mesh: Mesh, shellBVH: TriBVH, shell: Mesh, O: Vec3, D: Vec3) {
  // cast from far behind, backwards: the nearest hit is the ray's exit from the shell
  const far: Vec3 = [O[0] + D[0] * 20, O[1] + D[1] * 20, O[2] + D[2] * 20];
  const hit = shellBVH.raycast(far, [-D[0], -D[1], -D[2]]);
  if (!hit) return undefined;
  void mesh;
  void shell;
  return { tri: hit.tri, u: hit.u, v: hit.v };
}

function extrude(mesh: Mesh, e: number) {
  const s = Mesh.fromArrays(mesh.positions, mesh.tris);
  for (let i = 0; i < s.positions.length; i++) s.positions[i] += mesh.normals[i] * e;
  return s;
}

describe("PN patches", () => {
  it("interpolate the corners and their normals' tangent planes", () => {
    const P: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const N = P.map((p) => p.map((x) => x) as Vec3);
    const b = pnControlPoints(P, N);
    expect(pnEval(b, 0, 0).B).toEqual(P[0]);
    expect(pnEval(b, 1, 0).B).toEqual(P[1]);
    const e = pnEval(b, 0, 0);
    // tangents at a corner are perpendicular to that corner's normal
    expect(Math.abs(e.Bu[0] * N[0][0] + e.Bu[1] * N[0][1] + e.Bu[2] * N[0][2])).toBeLessThan(1e-9);
  });

  it("derivatives match finite differences", () => {
    const b = pnControlPoints(
      [
        [1, 0.1, 0],
        [0, 1, 0.2],
        [0.1, 0, 1],
      ],
      [
        [0.9, 0.1, 0.1],
        [0.1, 0.95, 0.2],
        [0.2, 0.1, 0.95],
      ],
    );
    const h = 1e-5;
    const [u, v] = [0.3, 0.25];
    const e = pnEval(b, u, v);
    const fu = pnEval(b, u + h, v),
      fv = pnEval(b, u, v + h);
    for (let k = 0; k < 3; k++) {
      expect((fu.B[k] - e.B[k]) / h).toBeCloseTo(e.Bu[k], 3);
      expect((fv.B[k] - e.B[k]) / h).toBeCloseTo(e.Bv[k], 3);
      expect((fu.Bu[k] - e.Bu[k]) / h).toBeCloseTo(e.Buu[k], 3);
      expect((fv.Bu[k] - e.Bu[k]) / h).toBeCloseTo(e.Buv[k], 3);
      expect((fv.Bv[k] - e.Bv[k]) / h).toBeCloseTo(e.Bvv[k], 3);
    }
  });

  /** Fraction of rays in (or beyond) the true line band that the model classifies wrongly. */
  function bandErrors(density: number, eOverR: number, r: number) {
    const mesh = sphere(density);
    const shell = extrude(mesh, eOverR * r);
    const bvh = new TriBVH(shell);
    const pm = pnMesh(mesh);
    let wrong = 0,
      total = 0;
    const D: Vec3 = [0, 0, -1];
    for (let a = 0; a < 40; a++) {
      const ang = 0.05 + (a / 40) * 1.2;
      for (const frac of [0.1, 0.3, 0.5, 0.7, 0.9, 1.1, 1.3]) {
        const rad = 1 + frac * r;
        const O: Vec3 = [rad * Math.cos(ang), rad * Math.sin(ang), 5];
        const frag = shellFragment(mesh, bvh, shell, O, D);
        if (!frag) continue;
        const res = pnClosest(pm, frag.tri, frag.u, frag.v, O, D);
        // true distance from this ray to the unit sphere
        const truth = Math.hypot(O[0], O[1]) - 1 < r;
        total++;
        if (res.dist < r !== truth) wrong++;
      }
    }
    return { wrong, total };
  }

  // Without walking, e = 6r at 128 segments misclassified 42/280 rays (15%); a Newton-only
  // walk needed 64 iterations to get near 2%. The flat projected pre-walk gets 0/280.
  for (const [density, k] of [
    [32, 2],
    [64, 2],
    [128, 2],
    [128, 4],
    [64, 6],
  ] as const) {
    it(`finds the contour from the shell fragment (${density * 2} segments, e = ${k}r)`, () => {
      const { wrong, total } = bandErrors(density, k, 0.005);
      expect(total).toBe(280);
      expect(wrong).toBeLessThanOrEqual(2);
    });
  }
});
