import { Mesh } from "./mesh";

/**
 * Per-vertex curvature from Rusinkiewicz (2004), "Estimating Curvatures and Their
 * Derivatives on Triangle Meshes".
 *
 * Sign convention: curvature is positive where the vertex normals diverge, so a sphere of
 * radius R with outward normals has k1 = k2 = H = 1/R. Saddle-shaped or concave regions
 * (seen from the normal side) go negative.
 *
 * Ordering: k1 >= k2 (signed), and `dir1` is the unit principal direction of k1. The k2
 * direction is `normal x dir1`.
 */
export class CurvatureField {
  /** Mean curvature, (k1 + k2) / 2. */
  H: Float32Array;
  /** Larger principal curvature (signed). */
  k1: Float32Array;
  /** Smaller principal curvature (signed). */
  k2: Float32Array;
  /** xyz principal direction of k1 per vertex, tangent to the vertex normal. */
  dir1: Float32Array;

  constructor(vertCount = 0) {
    this.H = new Float32Array(vertCount);
    this.k1 = new Float32Array(vertCount);
    this.k2 = new Float32Array(vertCount);
    this.dir1 = new Float32Array(vertCount * 3);
  }

  get vertCount() {
    return this.H.length;
  }
}

/*
 * Per-face record layout in a Float64Array (FACE_STRIDE doubles):
 *   [0..2] face tangent t, [3..5] bitangent b, [6..8] face normal n,
 *   [9..11] second fundamental form (e, f, g) in the (t, b) frame,
 *   [12..14] Voronoi corner areas for corners 0, 1, 2.
 */
const FACE_STRIDE = 15;

/**
 * Fills the face record for triangle `t` at `buf[o]`. A degenerate face gets zero corner
 * areas, so it contributes nothing.
 */
function computeFace(mesh: Mesh, t: number, buf: Float64Array, o: number) {
  const p = mesh.positions,
    nrm = mesh.normals,
    tris = mesh.tris;
  const v0 = tris[t * 3],
    v1 = tris[t * 3 + 1],
    v2 = tris[t * 3 + 2];
  const vs = [v0, v1, v2];

  // e[j] is the edge opposite corner j: e0 = p2 - p1, e1 = p0 - p2, e2 = p1 - p0
  const e = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let j = 0; j < 3; j++) {
    const a = vs[(j + 2) % 3],
      b = vs[(j + 1) % 3];
    e[j * 3] = p[a * 3] - p[b * 3];
    e[j * 3 + 1] = p[a * 3 + 1] - p[b * 3 + 1];
    e[j * 3 + 2] = p[a * 3 + 2] - p[b * 3 + 2];
  }

  let nx = e[1] * e[5] - e[2] * e[4],
    ny = e[2] * e[3] - e[0] * e[5],
    nz = e[0] * e[4] - e[1] * e[3];
  const nl = Math.hypot(nx, ny, nz);
  const l0 = Math.hypot(e[0], e[1], e[2]);
  buf.fill(0, o, o + FACE_STRIDE);
  if (nl === 0 || l0 === 0) return;
  const area = nl / 2;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  const tx = e[0] / l0,
    ty = e[1] / l0,
    tz = e[2] / l0;
  const bx = ny * tz - nz * ty,
    by = nz * tx - nx * tz,
    bz = nx * ty - ny * tx;

  // Least squares for II = [[e f][f g]]: II * (u, v) = (dn.t, dn.b) along each edge.
  let wuu = 0,
    wuv = 0,
    wvv = 0,
    m0 = 0,
    m1 = 0,
    m2 = 0;
  for (let j = 0; j < 3; j++) {
    const ex = e[j * 3],
      ey = e[j * 3 + 1],
      ez = e[j * 3 + 2];
    const u = ex * tx + ey * ty + ez * tz;
    const v = ex * bx + ey * by + ez * bz;
    wuu += u * u;
    wuv += u * v;
    wvv += v * v;
    const a = vs[(j + 2) % 3],
      b = vs[(j + 1) % 3];
    const dx = nrm[a * 3] - nrm[b * 3],
      dy = nrm[a * 3 + 1] - nrm[b * 3 + 1],
      dz = nrm[a * 3 + 2] - nrm[b * 3 + 2];
    const dnu = dx * tx + dy * ty + dz * tz;
    const dnv = dx * bx + dy * by + dz * bz;
    m0 += dnu * u;
    m1 += dnu * v + dnv * u;
    m2 += dnv * v;
  }

  /*
   * Normal equations, solved by Cramer's rule:
   *   | wuu  wuv        0   | |e|   |m0|
   *   | wuv  wuu + wvv  wuv | |f| = |m1|
   *   | 0    wuv        wvv | |g|   |m2|
   * det = (wuu + wvv)(wuu wvv - wuv^2), which is > 0 for a non-degenerate triangle.
   */
  const s = wuu + wvv;
  const det = s * (wuu * wvv - wuv * wuv);
  let fe = 0,
    ff = 0,
    fg = 0;
  if (det !== 0) {
    fe = (m0 * (s * wvv - wuv * wuv) - wuv * (m1 * wvv - wuv * m2)) / det;
    ff = (wuu * (m1 * wvv - wuv * m2) - m0 * (wuv * wvv)) / det;
    fg = (wuu * (s * m2 - wuv * m1) + wuv * wuv * (m0 - m2)) / det;
  }

  // Meyer et al. mixed Voronoi areas; obtuse triangles fall back to the split by halves.
  const l2a = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
  const l2b = e[3] * e[3] + e[4] * e[4] + e[5] * e[5];
  const l2c = e[6] * e[6] + e[7] * e[7] + e[8] * e[8];
  const bcw0 = l2a * (l2b + l2c - l2a),
    bcw1 = l2b * (l2c + l2a - l2b),
    bcw2 = l2c * (l2a + l2b - l2c);
  const dot = (i: number, j: number) =>
    e[i * 3] * e[j * 3] + e[i * 3 + 1] * e[j * 3 + 1] + e[i * 3 + 2] * e[j * 3 + 2];
  let c0: number, c1: number, c2: number;
  if (bcw0 <= 0) {
    c1 = (-0.25 * l2c * area) / dot(0, 2);
    c2 = (-0.25 * l2b * area) / dot(0, 1);
    c0 = area - c1 - c2;
  } else if (bcw1 <= 0) {
    c2 = (-0.25 * l2a * area) / dot(1, 0);
    c0 = (-0.25 * l2c * area) / dot(1, 2);
    c1 = area - c2 - c0;
  } else if (bcw2 <= 0) {
    c0 = (-0.25 * l2b * area) / dot(2, 1);
    c1 = (-0.25 * l2a * area) / dot(2, 0);
    c2 = area - c0 - c1;
  } else {
    const scale = (0.5 * area) / (bcw0 + bcw1 + bcw2);
    c0 = scale * (bcw1 + bcw2);
    c1 = scale * (bcw2 + bcw0);
    c2 = scale * (bcw0 + bcw1);
  }
  if (!Number.isFinite(c0 + c1 + c2)) c0 = c1 = c2 = area / 3;

  buf[o] = tx;
  buf[o + 1] = ty;
  buf[o + 2] = tz;
  buf[o + 3] = bx;
  buf[o + 4] = by;
  buf[o + 5] = bz;
  buf[o + 6] = nx;
  buf[o + 7] = ny;
  buf[o + 8] = nz;
  buf[o + 9] = fe;
  buf[o + 10] = ff;
  buf[o + 11] = fg;
  buf[o + 12] = c0;
  buf[o + 13] = c1;
  buf[o + 14] = c2;
}

/**
 * Rotates the frame (u, w), whose normal is u x w = `on`, about on x nn so its normal
 * becomes `nn` (Rusinkiewicz's rot_coord_sys). Results go to `out` as [u'xyz, w'xyz].
 */
function rotateFrame(u: number[], w: number[], on: number[], nn: ArrayLike<number>, out: number[]) {
  const nd = on[0] * nn[0] + on[1] * nn[1] + on[2] * nn[2];
  if (nd <= -1) {
    for (let i = 0; i < 3; i++) {
      out[i] = -u[i];
      out[i + 3] = -w[i];
    }
    return;
  }
  const px = nn[0] - nd * on[0],
    py = nn[1] - nd * on[1],
    pz = nn[2] - nd * on[2];
  const k = 1 / (1 + nd);
  const dx = (on[0] + nn[0]) * k,
    dy = (on[1] + nn[1]) * k,
    dz = (on[2] + nn[2]) * k;
  const pu = px * u[0] + py * u[1] + pz * u[2];
  const pw = px * w[0] + py * w[1] + pz * w[2];
  out[0] = u[0] - dx * pu;
  out[1] = u[1] - dy * pu;
  out[2] = u[2] - dz * pu;
  out[3] = w[0] - dx * pw;
  out[4] = w[1] - dy * pw;
  out[5] = w[2] - dz * pw;
}

/** Deterministic tangent frame (u, w) for a unit normal n, with u x w = n. */
function tangentFrame(n: number[], u: number[], w: number[]) {
  const ax = Math.abs(n[0]) < 0.9 ? 1 : 0,
    ay = 1 - ax;
  const d = ax * n[0] + ay * n[1];
  let ux = ax - d * n[0],
    uy = ay - d * n[1],
    uz = -d * n[2];
  const l = Math.hypot(ux, uy, uz);
  ux /= l;
  uy /= l;
  uz /= l;
  u[0] = ux;
  u[1] = uy;
  u[2] = uz;
  w[0] = n[1] * uz - n[2] * uy;
  w[1] = n[2] * ux - n[0] * uz;
  w[2] = n[0] * uy - n[1] * ux;
}

/** Scratch vectors, reused to keep the per-vertex loop allocation-free. */
const sN = [0, 0, 0],
  sU = [0, 0, 0],
  sW = [0, 0, 0],
  sR = [0, 0, 0, 0, 0, 0];

/**
 * Accumulates the face tensors around vertex `v` into its own frame, weighted by Voronoi
 * corner area, and writes the diagonalized result. `faceAt(t)` returns the offset of
 * triangle t's record in `buf`.
 */
function gatherVertex(
  mesh: Mesh,
  v: number,
  buf: Float64Array,
  faceAt: (t: number) => number,
  field: CurvatureField,
) {
  const nrm = mesh.normals,
    tris = mesh.tris;
  sN[0] = nrm[v * 3];
  sN[1] = nrm[v * 3 + 1];
  sN[2] = nrm[v * 3 + 2];
  tangentFrame(sN, sU, sW);

  let ku = 0,
    kuv = 0,
    kv = 0,
    area = 0;
  for (let i = mesh.vertTriStart[v]; i < mesh.vertTriStart[v + 1]; i++) {
    const t = mesh.vertTris[i];
    const o = faceAt(t);
    const j = tris[t * 3] === v ? 0 : tris[t * 3 + 1] === v ? 1 : 2;
    const ca = buf[o + 12 + j];
    if (ca === 0) continue;

    // express the vertex frame in the face plane, then re-read the face's II in it
    rotateFrame(sU, sW, sN, buf.subarray(o + 6, o + 9), sR);
    const u1 = sR[0] * buf[o] + sR[1] * buf[o + 1] + sR[2] * buf[o + 2];
    const v1 = sR[0] * buf[o + 3] + sR[1] * buf[o + 4] + sR[2] * buf[o + 5];
    const u2 = sR[3] * buf[o] + sR[4] * buf[o + 1] + sR[5] * buf[o + 2];
    const v2 = sR[3] * buf[o + 3] + sR[4] * buf[o + 4] + sR[5] * buf[o + 5];
    const fe = buf[o + 9],
      ff = buf[o + 10],
      fg = buf[o + 11];
    ku += ca * (fe * u1 * u1 + ff * (2 * u1 * v1) + fg * v1 * v1);
    kuv += ca * (fe * u1 * u2 + ff * (u1 * v2 + u2 * v1) + fg * v1 * v2);
    kv += ca * (fe * u2 * u2 + ff * (2 * u2 * v2) + fg * v2 * v2);
    area += ca;
  }
  if (area > 0) {
    ku /= area;
    kuv /= area;
    kv /= area;
  }

  // Jacobi rotation diagonalizing [[ku kuv][kuv kv]]
  let c = 1,
    s = 0,
    tt = 0;
  if (kuv !== 0) {
    const h = (0.5 * (kv - ku)) / kuv;
    tt = h < 0 ? 1 / (h - Math.sqrt(1 + h * h)) : 1 / (h + Math.sqrt(1 + h * h));
    c = 1 / Math.sqrt(1 + tt * tt);
    s = tt * c;
  }
  const ka = ku - tt * kuv,
    kb = kv + tt * kuv;
  let dx: number, dy: number, dz: number;
  if (ka >= kb) {
    field.k1[v] = ka;
    field.k2[v] = kb;
    dx = c * sU[0] - s * sW[0];
    dy = c * sU[1] - s * sW[1];
    dz = c * sU[2] - s * sW[2];
  } else {
    field.k1[v] = kb;
    field.k2[v] = ka;
    dx = s * sU[0] + c * sW[0];
    dy = s * sU[1] + c * sW[1];
    dz = s * sU[2] + c * sW[2];
  }
  field.H[v] = 0.5 * (ku + kv);
  field.dir1[v * 3] = dx;
  field.dir1[v * 3 + 1] = dy;
  field.dir1[v * 3 + 2] = dz;
}

/**
 * Computes curvature for every vertex. Needs `mesh.normals` and adjacency to be current.
 * Reuses `out` when it has the right size.
 */
export function computeCurvature(mesh: Mesh, out?: CurvatureField): CurvatureField {
  const nv = mesh.vertCount,
    nt = mesh.triCount;
  const field = out && out.vertCount === nv ? out : new CurvatureField(nv);
  const buf = new Float64Array(nt * FACE_STRIDE);
  for (let t = 0; t < nt; t++) computeFace(mesh, t, buf, t * FACE_STRIDE);
  const faceAt = (t: number) => t * FACE_STRIDE;
  for (let v = 0; v < nv; v++) gatherVertex(mesh, v, buf, faceAt, field);
  return field;
}

/**
 * Recomputes curvature for `verts` only; results are identical to `computeCurvature` for
 * those vertices.
 *
 * Which set to pass: a vertex's value depends on the positions and *normals* of its 1-ring,
 * and a normal depends on positions out to its own 1-ring. So when a set M of vertices has
 * moved (and `mesh.computeNormals` was rerun on M plus its 1-ring), pass M plus its 2-ring,
 * e.g. `expandRings(mesh, M, 2)`. Passing less leaves stale values at the edge of the set.
 */
export function updateCurvature(mesh: Mesh, field: CurvatureField, verts: Iterable<number>): void {
  const buf = new Float64Array(FACE_STRIDE);
  const faceAt = (t: number) => {
    computeFace(mesh, t, buf, 0);
    return 0;
  };
  for (const v of verts) gatherVertex(mesh, v, buf, faceAt, field);
}

/** Returns `seeds` plus every vertex within `rings` edges of them (via the 1-ring CSR). */
export function expandRings(mesh: Mesh, seeds: Iterable<number>, rings: number): Set<number> {
  const out = new Set<number>(seeds);
  let frontier = [...out];
  for (let r = 0; r < rings; r++) {
    const next: number[] = [];
    for (const v of frontier) {
      for (let i = mesh.vertNbrStart[v]; i < mesh.vertNbrStart[v + 1]; i++) {
        const w = mesh.vertNbrs[i];
        if (!out.has(w)) {
          out.add(w);
          next.push(w);
        }
      }
    }
    frontier = next;
  }
  return out;
}
