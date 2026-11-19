import type { Mesh } from "../mesh/mesh";
import type { TriBVH } from "../mesh/bvh";
import { expandRings } from "../mesh/curvature";

export type V3 = [number, number, number];

export const SculptBrush = { DRAW: 0, SMOOTH: 1 } as const;
export type SculptBrush = (typeof SculptBrush)[keyof typeof SculptBrush];

export interface SculptDab {
  center: ArrayLike<number>;
  radius: number;
  /** Draw: displacement as a fraction of the radius. Smooth: blend toward the centroid. */
  strength: number;
  /** Fraction of the radius with full strength before the falloff starts. */
  hardness: number;
  brush: SculptBrush;
  /** Draw only: push inward instead of outward. */
  invert?: boolean;
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Brush weight at distance d: 1 inside `hardness * radius`, easing to 0 at the radius. */
export function sculptFalloff(d: number, radius: number, hardness: number) {
  return 1 - smoothstep(Math.min(hardness, 0.999), 1, d / radius);
}

/**
 * Applies one dab and returns the vertices it moved. The first time a vertex moves in a
 * stroke, its starting position goes into `orig` (for undo).
 */
export function sculptDab(mesh: Mesh, bvh: TriBVH, dab: SculptDab, orig: Map<number, V3>): number[] {
  const p = mesh.positions;
  const c = dab.center;
  const inside = new Map<number, number>();
  bvh.querySphere(c, dab.radius, (t) => {
    for (let k = 0; k < 3; k++) {
      const v = mesh.tris[t * 3 + k];
      if (inside.has(v)) continue;
      const d = Math.hypot(p[v * 3] - c[0], p[v * 3 + 1] - c[1], p[v * 3 + 2] - c[2]);
      if (d < dab.radius) inside.set(v, sculptFalloff(d, dab.radius, dab.hardness));
    }
  });
  if (!inside.size) return [];

  const moved: number[] = [];
  const record = (v: number) => {
    if (!orig.has(v)) orig.set(v, [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]]);
    moved.push(v);
  };

  if (dab.brush === SculptBrush.DRAW) {
    const n = [0, 0, 0];
    for (const [v, f] of inside) {
      for (let a = 0; a < 3; a++) n[a] += mesh.normals[v * 3 + a] * f;
    }
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l === 0) return [];
    const amount = ((dab.invert ? -1 : 1) * dab.strength * dab.radius) / l;
    for (const [v, f] of inside) {
      if (f <= 0) continue;
      record(v);
      for (let a = 0; a < 3; a++) p[v * 3 + a] += n[a] * amount * f;
    }
  } else {
    // centroids from the positions before this dab, so the result is order-independent
    const targets: [number, V3, number][] = [];
    for (const [v, f] of inside) {
      const s = mesh.vertNbrStart[v],
        e = mesh.vertNbrStart[v + 1];
      if (f <= 0 || e === s) continue;
      const cen: V3 = [0, 0, 0];
      for (let i = s; i < e; i++) {
        const u = mesh.vertNbrs[i];
        for (let a = 0; a < 3; a++) cen[a] += p[u * 3 + a];
      }
      for (let a = 0; a < 3; a++) cen[a] /= e - s;
      targets.push([v, cen, Math.min(1, dab.strength * f)]);
    }
    for (const [v, cen, w] of targets) {
      record(v);
      for (let a = 0; a < 3; a++) p[v * 3 + a] += (cen[a] - p[v * 3 + a]) * w;
    }
  }
  return moved;
}

/**
 * Brings derived data up to date after vertices moved: normals out to the 1-ring. Returns
 * the 2-ring, which is where curvature (and PN patches) must be recomputed, since a face's
 * curvature tensor depends on its corners' normals.
 */
export function updateAfterMove(mesh: Mesh, moved: Iterable<number>): Set<number> {
  mesh.computeNormals(expandRings(mesh, moved, 1));
  return expandRings(mesh, moved, 2);
}
