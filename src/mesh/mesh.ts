import * as nstructjs from "nstructjs";

/** Which generator built the mesh; analytic ones let the reference project onto the true surface. */
export const PrimitiveType = {
  CUBE: 0,
  UV_SPHERE: 1,
  ICOSPHERE: 2,
  CAPSULE: 3,
  TORUS: 4,
} as const;
export type PrimitiveType = (typeof PrimitiveType)[keyof typeof PrimitiveType];

export class PrimitiveParams {
  type: PrimitiveType = PrimitiveType.UV_SPHERE;
  /** Resolution knob; each generator maps it to its own segment counts. */
  density = 16;
  radius = 1;
  /** Torus tube radius, or half-length of the capsule straight part. */
  radius2 = 0.35;

  copy() {
    return Object.assign(new PrimitiveParams(), this);
  }

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  sa3d.PrimitiveParams {
    type    : int;
    density : int;
    radius  : float;
    radius2 : float;
  }`,
  );

  loadSTRUCT(reader: (obj: this) => void) {
    reader(this);
  }
}

/**
 * Triangle mesh with UVs on corners (so seams need no vertex splitting).
 * Saved: positions, triangles, UVs, the correction map and the primitive it came from.
 * Everything else is derived; call `rebuildDerived()` after loading or editing topology.
 */
export class Mesh {
  positions = new Float32Array(0);
  tris = new Uint32Array(0);
  /** Per corner: 6 floats per triangle. */
  uvs = new Float32Array(0);
  /** Correction map: world-space margin per vertex. */
  cAbs = new Float32Array(0);
  /** Correction map: relative extrusion multiplier per vertex. */
  cRel = new Float32Array(0);
  primitive = new PrimitiveParams();
  /** True for an unsculpted analytic primitive (sphere, cylinder, torus). */
  isAnalytic = false;
  /** Bumped on any geometry change, so GPU buffers and caches know to refresh. */
  geomVersion = 0;

  // derived
  normals = new Float32Array(0);
  /** CSR vertex -> incident triangles. */
  vertTriStart = new Uint32Array(0);
  vertTris = new Uint32Array(0);
  /** CSR vertex -> neighbouring vertices (1-ring). */
  vertNbrStart = new Uint32Array(0);
  vertNbrs = new Uint32Array(0);

  get vertCount() {
    return this.positions.length / 3;
  }

  get triCount() {
    return this.tris.length / 3;
  }

  static fromArrays(positions: ArrayLike<number>, tris: ArrayLike<number>) {
    const m = new Mesh();
    m.positions = Float32Array.from(positions);
    m.tris = Uint32Array.from(tris);
    m.uvs = new Float32Array(m.tris.length * 2);
    m.cAbs = new Float32Array(m.vertCount);
    m.cRel = new Float32Array(m.vertCount);
    m.rebuildDerived();
    return m;
  }

  rebuildDerived() {
    this.buildAdjacency();
    this.computeNormals();
    this.geomVersion++;
  }

  buildAdjacency() {
    const nv = this.vertCount,
      nt = this.triCount,
      tris = this.tris;

    const start = new Uint32Array(nv + 1);
    for (let i = 0; i < tris.length; i++) start[tris[i] + 1]++;
    for (let i = 0; i < nv; i++) start[i + 1] += start[i];

    const fill = start.slice(0, nv);
    const vt = new Uint32Array(tris.length);
    for (let t = 0; t < nt; t++) {
      for (let k = 0; k < 3; k++) vt[fill[tris[t * 3 + k]]++] = t;
    }
    this.vertTriStart = start;
    this.vertTris = vt;

    // 1-ring: unique other vertices of incident triangles
    const nbrStart = new Uint32Array(nv + 1);
    const nbrLists: number[][] = new Array(nv);
    for (let v = 0; v < nv; v++) {
      const set = new Set<number>();
      for (let i = start[v]; i < start[v + 1]; i++) {
        const t = vt[i];
        for (let k = 0; k < 3; k++) {
          const w = tris[t * 3 + k];
          if (w !== v) set.add(w);
        }
      }
      nbrLists[v] = [...set];
      nbrStart[v + 1] = nbrStart[v] + set.size;
    }
    const nbrs = new Uint32Array(nbrStart[nv]);
    for (let v = 0; v < nv; v++) nbrs.set(nbrLists[v], nbrStart[v]);
    this.vertNbrStart = nbrStart;
    this.vertNbrs = nbrs;
  }

  /** Angle-weighted vertex normals; optionally only for the given vertices. */
  computeNormals(verts?: Iterable<number>) {
    const p = this.positions,
      tris = this.tris;
    if (this.normals.length !== p.length) {
      this.normals = new Float32Array(p.length);
      verts = undefined;
    }
    const n = this.normals;
    const list = verts ?? Array.from({ length: this.vertCount }, (_, i) => i);

    for (const v of list) {
      let nx = 0,
        ny = 0,
        nz = 0;
      for (let i = this.vertTriStart[v]; i < this.vertTriStart[v + 1]; i++) {
        const t = this.vertTris[i];
        const a = tris[t * 3],
          b = tris[t * 3 + 1],
          c = tris[t * 3 + 2];
        // corner order so (v, o1, o2) keeps the triangle's winding
        const [o1, o2] = v === a ? [b, c] : v === b ? [c, a] : [a, b];
        const e1x = p[o1 * 3] - p[v * 3],
          e1y = p[o1 * 3 + 1] - p[v * 3 + 1],
          e1z = p[o1 * 3 + 2] - p[v * 3 + 2];
        const e2x = p[o2 * 3] - p[v * 3],
          e2y = p[o2 * 3 + 1] - p[v * 3 + 1],
          e2z = p[o2 * 3 + 2] - p[v * 3 + 2];
        const cx = e1y * e2z - e1z * e2y,
          cy = e1z * e2x - e1x * e2z,
          cz = e1x * e2y - e1y * e2x;
        const cl = Math.hypot(cx, cy, cz);
        if (cl === 0) continue;
        const l1 = Math.hypot(e1x, e1y, e1z),
          l2 = Math.hypot(e2x, e2y, e2z);
        const ang = Math.acos(Math.min(1, Math.max(-1, (e1x * e2x + e1y * e2y + e1z * e2z) / (l1 * l2))));
        nx += (cx / cl) * ang;
        ny += (cy / cl) * ang;
        nz += (cz / cl) * ang;
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      n[v * 3] = nx / l;
      n[v * 3 + 1] = ny / l;
      n[v * 3 + 2] = nz / l;
    }
  }

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  sa3d.Mesh {
    positions  : arraybuffer(float);
    tris       : arraybuffer(uint);
    uvs        : arraybuffer(float);
    cAbs       : arraybuffer(float);
    cRel       : arraybuffer(float);
    primitive  : sa3d.PrimitiveParams;
    isAnalytic : bool;
  }`,
  );

  loadSTRUCT(reader: (obj: this) => void) {
    reader(this);
    // typed arrays come back as the element type's array; derived data is rebuilt after load
  }
}
