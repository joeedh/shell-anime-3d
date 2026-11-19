/**
 * Clip model 1: the osculating algebraic sphere (TS mirror of shell.wgsl, line for line).
 *
 * Each vertex defines the sphere through P with normal N and mean curvature H in APSS form
 * (Guennebaud & Gross 2007):
 *
 *   s(x) = u0 + u·x + u4|x|²,  u4 = H/2,  u = N − H·P,  u0 = (H/2)|P|² − N·P.
 *
 * s(P) = 0 and ∇s(P) = N, and as H → 0 it degenerates smoothly to the tangent plane. The
 * five coefficients are interpolated across the shell triangle; on a sphere every vertex
 * gives the same sphere, so the interpolated one is exact. For u4 ≠ 0:
 *
 *   center C = −u / (2·u4),  R² = |C|² − u0/u4.
 *
 * A fragment is kept if its ray passes within r of that sphere, i.e. dist(ray, C) < R + r
 * (rays that pierce the sphere are kept too; the base surface's depth hides them).
 */

export type Vec3 = [number, number, number];
export type SphereCoeffs = [number, number, number, number, number]; // u0, ux, uy, uz, u4

/** |u4| below this is treated as a plane; measured f32-safe in view space (plan, round 2). */
export const SPHERE_EPS = 5e-5;

export function algebraicSphere(P: Vec3, N: Vec3, H: number): SphereCoeffs {
  const pp = P[0] * P[0] + P[1] * P[1] + P[2] * P[2];
  const np = N[0] * P[0] + N[1] * P[1] + N[2] * P[2];
  return [0.5 * H * pp - np, N[0] - H * P[0], N[1] - H * P[1], N[2] - H * P[2], 0.5 * H];
}

export function lerpCoeffs(a: SphereCoeffs, b: SphereCoeffs, c: SphereCoeffs, w: Vec3): SphereCoeffs {
  const out: SphereCoeffs = [0, 0, 0, 0, 0];
  for (let i = 0; i < 5; i++) out[i] = a[i] * w[0] + b[i] * w[1] + c[i] * w[2];
  return out;
}

export interface ClipResult {
  keep: boolean;
  /** Ray parameter of the exit from the offset surface, when the model defines one. */
  exitT?: number;
}

/** O + tD is the view ray (D unit length); r is the offset radius in the same units. */
export function sphereClip(s: SphereCoeffs, O: Vec3, D: Vec3, r: number): ClipResult {
  const u4 = s[4];
  if (Math.abs(u4) <= SPHERE_EPS) {
    // tangent plane: any non-parallel ray crosses it, so keep (base depth hides it)
    return { keep: true };
  }
  const C: Vec3 = [-s[1] / (2 * u4), -s[2] / (2 * u4), -s[3] / (2 * u4)];
  const R = Math.sqrt(Math.max(0, C[0] * C[0] + C[1] * C[1] + C[2] * C[2] - s[0] / u4));

  const oc: Vec3 = [C[0] - O[0], C[1] - O[1], C[2] - O[2]];
  const tc = oc[0] * D[0] + oc[1] * D[1] + oc[2] * D[2];
  const d2 = Math.max(0, oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - tc * tc);
  const Ro = R + r;
  if (d2 >= Ro * Ro) {
    return { keep: false };
  }
  return { keep: true, exitT: tc + Math.sqrt(Ro * Ro - d2) };
}
