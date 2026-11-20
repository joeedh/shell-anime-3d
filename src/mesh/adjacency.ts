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

/**
 * Per-triangle candidate lists for the PN envelope search: the triangles within `rings`
 * shared-vertex steps of each triangle, in BFS order (nearest ring first), the triangle
 * itself excluded, at most `cap` per list. Packed GPU-style: entries 0..nt are offsets into
 * the same array (absolute indices), followed by the concatenated lists.
 */
export function triRings(mesh: Mesh, rings = 2, cap = 48): Uint32Array {
  const nt = mesh.triCount;
  const tris = mesh.tris;
  const vertTris: number[][] = Array.from({ length: mesh.vertCount }, () => []);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) vertTris[tris[t * 3 + k]].push(t);

  const lists: number[][] = [];
  let total = 0;
  const seen = new Int32Array(nt).fill(-1);
  for (let t = 0; t < nt; t++) {
    const list: number[] = [];
    seen[t] = t;
    let front = [t];
    for (let step = 0; step < rings && list.length < cap; step++) {
      const next: number[] = [];
      for (const f of front)
        for (let k = 0; k < 3; k++)
          for (const nb of vertTris[tris[f * 3 + k]])
            if (seen[nb] !== t) {
              seen[nb] = t;
              next.push(nb);
            }
      for (const nb of next) if (list.length < cap) list.push(nb);
      front = next;
    }
    lists.push(list);
    total += list.length;
  }
  const out = new Uint32Array(nt + 1 + total);
  let at = nt + 1;
  for (let t = 0; t < nt; t++) {
    out[t] = at;
    out.set(lists[t], at);
    at += lists[t].length;
  }
  out[nt] = at;
  return out;
}
