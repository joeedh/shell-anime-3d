import { Mesh } from "./mesh";

/** Output of `butterflySubdivide`. Original vertices keep their indices and exact positions. */
export interface ButterflyResult {
  positions: Float32Array;
  tris: Uint32Array;
  /** Per corner, 6 floats per triangle, linear within each original triangle. */
  uvs: Float32Array;
  /** Index of the original triangle each output triangle came from. */
  parentTri: Uint32Array;
}

/*
 * Half-edge conventions: half-edge h = 3t + k runs from corner k of triangle t to corner
 * k+1. next/prev step within the triangle; twin[h] is the opposite half-edge, or -1 on a
 * boundary.
 */
const nextHe = (h: number) => (h % 3 === 2 ? h - 2 : h + 1);
const prevHe = (h: number) => (h % 3 === 0 ? h + 2 : h - 1);

/** Zorin's extraordinary-vertex weights s_j for valence k (the centre itself gets 3/4). */
const stencilCache = new Map<number, Float64Array>();
function stencilWeights(k: number): Float64Array {
  let s = stencilCache.get(k);
  if (s) return s;
  s = new Float64Array(k);
  if (k === 3) {
    s.set([5 / 12, -1 / 12, -1 / 12]);
  } else if (k === 4) {
    s.set([3 / 8, 0, -1 / 8, 0]);
  } else {
    for (let j = 0; j < k; j++) {
      const a = (2 * Math.PI * j) / k;
      s[j] = (0.25 + Math.cos(a) + 0.5 * Math.cos(2 * a)) / k;
    }
  }
  stencilCache.set(k, s);
  return s;
}

interface Level {
  pos: Float64Array;
  tris: Uint32Array;
  uvs: Float64Array;
  parent: Uint32Array;
}

function subdivideOnce(src: Level): Level {
  const { pos, tris, uvs, parent } = src;
  const nv = pos.length / 3,
    nh = tris.length,
    nt = nh / 3;

  // vertex -> outgoing half-edges (CSR)
  const start = new Uint32Array(nv + 1);
  for (let h = 0; h < nh; h++) start[tris[h] + 1]++;
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nv);
  const outHe = new Uint32Array(nh);
  for (let h = 0; h < nh; h++) outHe[fill[tris[h]]++] = h;

  // twins: the half-edge b->a is among b's outgoing half-edges
  const twin = new Int32Array(nh).fill(-1);
  for (let h = 0; h < nh; h++) {
    const a = tris[h],
      b = tris[nextHe(h)];
    for (let i = start[b]; i < start[b + 1]; i++) {
      const c = outHe[i];
      if (tris[nextHe(c)] === a) {
        twin[h] = c;
        break;
      }
    }
  }

  // valence of interior manifold vertices; -1 for boundary or non-manifold ones
  const valence = new Int32Array(nv).fill(-1);
  for (let v = 0; v < nv; v++) {
    const k = start[v + 1] - start[v];
    if (k === 0) continue;
    const h0 = outHe[start[v]];
    let h = h0,
      count = 0;
    do {
      h = twin[prevHe(h)];
      count++;
    } while (h >= 0 && h !== h0 && count <= k);
    if (h === h0 && count === k) valence[v] = k;
  }

  // one edge id per undirected edge; its new vertex is nv + id
  const edgeOf = new Uint32Array(nh);
  let ne = 0;
  for (let h = 0; h < nh; h++) {
    const tw = twin[h];
    if (tw < 0 || h < tw) {
      edgeOf[h] = ne;
      if (tw >= 0) edgeOf[tw] = ne;
      ne++;
    }
  }

  const out = new Float64Array((nv + ne) * 3);
  out.set(pos);
  let ax = 0,
    ay = 0,
    az = 0;
  const add = (v: number, w: number) => {
    ax += pos[v * 3] * w;
    ay += pos[v * 3 + 1] * w;
    az += pos[v * 3 + 2] * w;
  };
  const opp = (h: number) => tris[prevHe(h)];
  // Zorin's stencil around vertex v, starting from its outgoing half-edge h along the edge.
  const addStencil = (v: number, h: number, k: number, scale: number) => {
    const s = stencilWeights(k);
    add(v, 0.75 * scale);
    for (let j = 0; j < k; j++) {
      add(tris[nextHe(h)], s[j] * scale);
      h = twin[prevHe(h)];
    }
  };

  for (let h = 0; h < nh; h++) {
    const tw = twin[h];
    if (tw >= 0 && tw < h) continue;
    const a = tris[h],
      b = tris[nextHe(h)];
    const va = valence[a],
      vb = valence[b];
    ax = ay = az = 0;

    if (tw < 0 || va < 3 || vb < 3) {
      add(a, 0.5);
      add(b, 0.5);
    } else if (va === 6 && vb === 6) {
      // regular 10-point butterfly: 1/2 endpoints, 1/8 wing tips, -1/16 outer wings
      add(a, 0.5);
      add(b, 0.5);
      add(opp(h), 0.125);
      add(opp(tw), 0.125);
      add(opp(twin[nextHe(h)]), -0.0625);
      add(opp(twin[prevHe(h)]), -0.0625);
      add(opp(twin[nextHe(tw)]), -0.0625);
      add(opp(twin[prevHe(tw)]), -0.0625);
    } else if (vb === 6) {
      addStencil(a, h, va, 1);
    } else if (va === 6) {
      addStencil(b, tw, vb, 1);
    } else {
      addStencil(a, h, va, 0.5);
      addStencil(b, tw, vb, 0.5);
    }
    const o = (nv + edgeOf[h]) * 3;
    out[o] = ax;
    out[o + 1] = ay;
    out[o + 2] = az;
  }

  // 1:4 split, keeping winding; UVs from the parent triangle's own corners (no seam smoothing)
  const nTris = new Uint32Array(nt * 12);
  const nUvs = new Float64Array(nt * 24);
  const nParent = new Uint32Array(nt * 4);
  const childCorners = [0, 3, 5, 1, 4, 3, 2, 5, 4, 3, 4, 5];
  const vid = [0, 0, 0, 0, 0, 0];
  const cu = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let t = 0; t < nt; t++) {
    vid[0] = tris[t * 3];
    vid[1] = tris[t * 3 + 1];
    vid[2] = tris[t * 3 + 2];
    vid[3] = nv + edgeOf[t * 3];
    vid[4] = nv + edgeOf[t * 3 + 1];
    vid[5] = nv + edgeOf[t * 3 + 2];
    for (let i = 0; i < 6; i++) cu[i] = uvs[t * 6 + i];
    for (let k = 0; k < 3; k++) {
      const k2 = (k + 1) % 3;
      cu[6 + k * 2] = 0.5 * (cu[k * 2] + cu[k2 * 2]);
      cu[7 + k * 2] = 0.5 * (cu[k * 2 + 1] + cu[k2 * 2 + 1]);
    }
    for (let c = 0; c < 4; c++) {
      const dt = t * 4 + c;
      for (let k = 0; k < 3; k++) {
        const s = childCorners[c * 3 + k];
        nTris[dt * 3 + k] = vid[s];
        nUvs[dt * 6 + k * 2] = cu[s * 2];
        nUvs[dt * 6 + k * 2 + 1] = cu[s * 2 + 1];
      }
      nParent[dt] = parent[t];
    }
  }

  return { pos: out, tris: nTris, uvs: nUvs, parent: nParent };
}

/**
 * Modified butterfly subdivision (Zorin, Schröder & Sweldens 1996), `levels` times.
 *
 * - Interpolating: vertex i of the input is vertex i of the output, at the same position.
 * - Edge points use the 10-point stencil between two valence-6 vertices, Zorin's
 *   extraordinary stencil when one end is irregular, and the average of both stencils when
 *   both are.
 * - Boundary edges, and edges touching a boundary or non-manifold vertex, get the plain
 *   midpoint. The meshes here are closed, so this is only a no-crash fallback.
 * - Positions are computed in double precision across levels and rounded once at the end.
 */
export function butterflySubdivide(mesh: Mesh, levels: number): ButterflyResult {
  const nt = mesh.triCount;
  let lvl: Level = {
    pos: Float64Array.from(mesh.positions),
    tris: mesh.tris.slice(),
    uvs: mesh.uvs.length === nt * 6 ? Float64Array.from(mesh.uvs) : new Float64Array(nt * 6),
    parent: Uint32Array.from({ length: nt }, (_, i) => i),
  };
  for (let l = 0; l < levels; l++) lvl = subdivideOnce(lvl);
  return {
    positions: Float32Array.from(lvl.pos),
    tris: lvl.tris,
    uvs: Float32Array.from(lvl.uvs),
    parentTri: lvl.parent,
  };
}
