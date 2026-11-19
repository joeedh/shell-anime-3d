import { describe, expect, it } from "vitest";
import { PrimitiveParams, PrimitiveType } from "../src/mesh/mesh";
import { makePrimitive } from "../src/mesh/primitives";
import { computeCurvature } from "../src/mesh/curvature";
import { algebraicSphere, lerpCoeffs, sphereClip } from "../src/math/clip_sphere";
import type { SphereCoeffs, Vec3 } from "../src/math/clip_sphere";

function vtx(arr: Float32Array, i: number): Vec3 {
  return [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];
}

describe("osculating algebraic sphere", () => {
  it("passes through P with gradient N", () => {
    const P: Vec3 = [0.3, -0.2, 0.9];
    const N: Vec3 = [0, 0.6, 0.8];
    const s = algebraicSphere(P, N, 1.7);
    const val = s[0] + s[1] * P[0] + s[2] * P[1] + s[3] * P[2] + s[4] * (P[0] ** 2 + P[1] ** 2 + P[2] ** 2);
    expect(val).toBeCloseTo(0, 10);
    for (let k = 0; k < 3; k++) {
      expect(s[1 + k] + 2 * s[4] * P[k]).toBeCloseTo(N[k], 10);
    }
  });

  it("is exact for analytic N and H on a faceted sphere", () => {
    // vertex data from the true sphere: interpolating anywhere gives the same sphere
    const R = 1.3;
    const pts: Vec3[] = [
      [R, 0, 0],
      [0, R, 0],
      [0, 0, R],
    ];
    const cs = pts.map((p) => algebraicSphere(p, [p[0] / R, p[1] / R, p[2] / R], 1 / R));
    const s = lerpCoeffs(cs[0], cs[1], cs[2], [0.2, 0.5, 0.3]);
    // ray along -z at lateral distance R + 0.9r is kept, R + 1.1r is rejected
    const r = 0.01;
    expect(sphereClip(s, [R + 0.9 * r, 0, 5], [0, 0, -1], r).keep).toBe(true);
    expect(sphereClip(s, [R + 1.1 * r, 0, 5], [0, 0, -1], r).keep).toBe(false);
  });

  it("degenerates to keep-everything on flat regions", () => {
    const s = algebraicSphere([0, 0, 0], [0, 0, 1], 0);
    expect(sphereClip(s, [3, 0, 5], [0, 0, -1], 0.01).keep).toBe(true);
  });

  /** Worst silhouette error over contour-adjacent triangles, ortho view down -z. */
  function silhouetteError(density: number) {
    const p = new PrimitiveParams();
    p.type = PrimitiveType.UV_SPHERE;
    p.density = density;
    const mesh = makePrimitive(p);
    const curv = computeCurvature(mesh);
    let worst = 0;
    for (let t = 0; t < mesh.triCount; t++) {
      const ids = [0, 1, 2].map((k) => mesh.tris[t * 3 + k]);
      const ns = ids.map((v) => vtx(mesh.normals, v));
      if (ns.some((n) => Math.abs(n[2]) > 0.3 || Math.abs(n[1]) > 0.8)) continue;
      const cs = ids.map((v) => algebraicSphere(vtx(mesh.positions, v), vtx(mesh.normals, v), curv.H[v]));
      const s: SphereCoeffs = lerpCoeffs(cs[0], cs[1], cs[2], [1 / 3, 1 / 3, 1 / 3]);
      const C = [-s[1] / (2 * s[4]), -s[2] / (2 * s[4])];
      const R = Math.sqrt(C[0] ** 2 + C[1] ** 2 + (s[3] / (2 * s[4])) ** 2 - s[0] / s[4]);
      // silhouette distance from the z axis, in the direction of this triangle
      const c = ids.map((v) => vtx(mesh.positions, v)).reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0]);
      const l = Math.hypot(c[0], c[1]);
      const dir = [c[0] / l, c[1] / l];
      const along = C[0] * dir[0] + C[1] * dir[1];
      const perp2 = C[0] ** 2 + C[1] ** 2 - along * along;
      worst = Math.max(worst, Math.abs(along + Math.sqrt(R * R - perp2) - 1));
    }
    return worst;
  }

  it("with estimated N and H, the silhouette error stays under an eighth of a pixel", () => {
    // N comes from angle-weighted vertex normals and H from the curvature estimator;
    // neither is exact on a split-quad UV sphere. Errors are in units of the radius.
    // measured ~1.3e-4 at every density from 16 up (a noise floor, not O(h^2));
    // 5e-4 on a 250 px sphere is an eighth of a pixel
    for (const density of [16, 32, 64]) {
      expect(silhouetteError(density)).toBeLessThan(5e-4);
    }
  });
});
