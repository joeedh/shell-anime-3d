import { Mesh } from "./mesh";
import { smoothPositions } from "./smooth";
import type { SmoothOptions } from "./smooth";

/**
 * Splits every triangle 1→4 at its edge midpoints, then smooths along the vertex normals
 * with cotangent weights (`smoothPositions`; factor 0 keeps the plain split). Original
 * vertices keep their indices; each edge's midpoint is shared by both of its triangles. Corner UVs are interpolated within each parent triangle, so the UV layout
 * (and with it the paint) is unchanged. cAbs/cRel are averaged onto the midpoints.
 * Boundary vertices stay fixed. Returns a new mesh with derived data built.
 */
export function subdivideSmooth(src: Mesh, opt: Partial<SmoothOptions> = {}): Mesh {
  const nv = src.vertCount,
    nt = src.triCount,
    tris = src.tris;

  // one midpoint vertex per undirected edge
  const edgeVert = new Map<number, number>();
  const ends: number[] = [];
  const key = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  const mids = new Uint32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const a = tris[t * 3 + k],
        b = tris[t * 3 + ((k + 1) % 3)];
      const e = key(a, b);
      let m = edgeVert.get(e);
      if (m === undefined) {
        m = nv + ends.length / 2;
        edgeVert.set(e, m);
        ends.push(a, b);
      }
      mids[t * 3 + k] = m;
    }
  }
  const ne = ends.length / 2;
  const total = nv + ne;

  const pos = new Float32Array(total * 3);
  pos.set(src.positions);
  const cAbs = new Float32Array(total);
  const cRel = new Float32Array(total);
  cAbs.set(src.cAbs);
  cRel.set(src.cRel);
  for (let i = 0; i < ne; i++) {
    const a = ends[i * 2],
      b = ends[i * 2 + 1],
      m = nv + i;
    for (let c = 0; c < 3; c++) pos[m * 3 + c] = (src.positions[a * 3 + c] + src.positions[b * 3 + c]) * 0.5;
    cAbs[m] = (src.cAbs[a] + src.cAbs[b]) * 0.5;
    cRel[m] = (src.cRel[a] + src.cRel[b]) * 0.5;
  }

  // children: three corner triangles, then the middle one; mids[k] sits on edge (k, k+1)
  const out = new Uint32Array(nt * 12);
  const uvs = new Float32Array(nt * 24);
  const suv = src.uvs;
  for (let t = 0; t < nt; t++) {
    const [a, b, c] = [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]];
    const [ab, bc, ca] = [mids[t * 3], mids[t * 3 + 1], mids[t * 3 + 2]];
    out.set([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca], t * 12);

    // corner UVs as barycentric weights of the parent's corners
    const W = [
      [1, 0, 0],
      [0.5, 0.5, 0],
      [0.5, 0, 0.5],
      [0.5, 0.5, 0],
      [0, 1, 0],
      [0, 0.5, 0.5],
      [0.5, 0, 0.5],
      [0, 0.5, 0.5],
      [0, 0, 1],
      [0.5, 0.5, 0],
      [0, 0.5, 0.5],
      [0.5, 0, 0.5],
    ];
    for (let j = 0; j < 12; j++) {
      const w = W[j];
      for (let c2 = 0; c2 < 2; c2++) {
        uvs[t * 24 + j * 2 + c2] =
          w[0] * suv[t * 6 + c2] + w[1] * suv[t * 6 + 2 + c2] + w[2] * suv[t * 6 + 4 + c2];
      }
    }
  }

  const mesh = new Mesh();
  mesh.positions = pos;
  mesh.tris = out;
  mesh.uvs = uvs;
  mesh.cAbs = cAbs;
  mesh.cRel = cRel;
  mesh.primitive = src.primitive.copy();
  mesh.isAnalytic = false;
  smoothPositions(mesh.positions, mesh.tris, opt);
  mesh.rebuildDerived();
  return mesh;
}
