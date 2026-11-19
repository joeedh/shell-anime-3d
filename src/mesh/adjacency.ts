import type { Mesh } from "./mesh";

/**
 * Triangle edge neighbours: entry t*3+k is the triangle across the edge opposite corner k
 * (corners k+1, k+2), or -1 on a boundary or non-manifold edge.
 */
export function triNeighbours(mesh: Mesh): Int32Array {
  const nt = mesh.triCount;
  const tris = mesh.tris;
  const out = new Int32Array(nt * 3).fill(-1);
  const edges = new Map<number, number>();
  const nv = mesh.vertCount;

  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const a = tris[t * 3 + ((k + 1) % 3)];
      const b = tris[t * 3 + ((k + 2) % 3)];
      // the twin edge runs b -> a
      const twin = edges.get(b * nv + a);
      if (twin !== undefined) {
        out[t * 3 + k] = twin >> 2;
        out[(twin >> 2) * 3 + (twin & 3)] = t;
        edges.delete(b * nv + a);
      } else {
        edges.set(a * nv + b, (t << 2) | k);
      }
    }
  }
  return out;
}
