// Clip model 2: PN-triangle patches. A line-for-line port of src/math/pn.ts (see that file
// for the derivation). Works in world space; needs `pn` (binding 5) from the mesh layout.

const PN_STRIDE: u32 = 11u;
const PN_MAX_FLAT_HOPS: i32 = 64;
const PN_MAX_ITER: i32 = 12;
const PN_MAX_HOPS: i32 = 8;
const PN_HOP_SLACK: f32 = 0.02;

@group(0) @binding(5) var<storage, read> pn: array<vec4f>;

fn pnCP(tri: u32, k: u32) -> vec3f {
  return pn[tri * PN_STRIDE + k].xyz;
}

fn pnNeighbour(tri: u32, k: u32) -> i32 {
  return bitcast<i32>(pn[tri * PN_STRIDE + 10u][k]);
}

struct PNEval {
  B: vec3f,
  Bu: vec3f,
  Bv: vec3f,
  Buu: vec3f,
  Buv: vec3f,
  Bvv: vec3f,
};

fn pnEval(tri: u32, u: f32, v: f32) -> PNEval {
  let w0 = 1.0 - u - v;
  let w1 = u;
  let w2 = v;
  let b300 = pnCP(tri, 0u);
  let b030 = pnCP(tri, 1u);
  let b003 = pnCP(tri, 2u);
  let b210 = pnCP(tri, 3u);
  let b120 = pnCP(tri, 4u);
  let b021 = pnCP(tri, 5u);
  let b012 = pnCP(tri, 6u);
  let b102 = pnCP(tri, 7u);
  let b201 = pnCP(tri, 8u);
  let b111 = pnCP(tri, 9u);

  var e: PNEval;
  e.B = b300 * (w0 * w0 * w0) + b030 * (w1 * w1 * w1) + b003 * (w2 * w2 * w2)
      + b210 * (3.0 * w0 * w0 * w1) + b120 * (3.0 * w0 * w1 * w1) + b201 * (3.0 * w0 * w0 * w2)
      + b021 * (3.0 * w1 * w1 * w2) + b102 * (3.0 * w0 * w2 * w2) + b012 * (3.0 * w1 * w2 * w2)
      + b111 * (6.0 * w0 * w1 * w2);
  let B0 = b300 * (3.0 * w0 * w0) + b210 * (6.0 * w0 * w1) + b120 * (3.0 * w1 * w1)
         + b201 * (6.0 * w0 * w2) + b102 * (3.0 * w2 * w2) + b111 * (6.0 * w1 * w2);
  let B1 = b030 * (3.0 * w1 * w1) + b210 * (3.0 * w0 * w0) + b120 * (6.0 * w0 * w1)
         + b021 * (6.0 * w1 * w2) + b012 * (3.0 * w2 * w2) + b111 * (6.0 * w0 * w2);
  let B2 = b003 * (3.0 * w2 * w2) + b201 * (3.0 * w0 * w0) + b021 * (3.0 * w1 * w1)
         + b102 * (6.0 * w0 * w2) + b012 * (6.0 * w1 * w2) + b111 * (6.0 * w0 * w1);
  let B00 = b300 * (6.0 * w0) + b210 * (6.0 * w1) + b201 * (6.0 * w2);
  let B11 = b030 * (6.0 * w1) + b120 * (6.0 * w0) + b021 * (6.0 * w2);
  let B22 = b003 * (6.0 * w2) + b102 * (6.0 * w0) + b012 * (6.0 * w1);
  let B01 = b210 * (6.0 * w0) + b120 * (6.0 * w1) + b111 * (6.0 * w2);
  let B02 = b201 * (6.0 * w0) + b102 * (6.0 * w2) + b111 * (6.0 * w1);
  let B12 = b021 * (6.0 * w1) + b012 * (6.0 * w2) + b111 * (6.0 * w0);
  e.Bu = B1 - B0;
  e.Bv = B2 - B0;
  e.Buu = B11 - 2.0 * B01 + B00;
  e.Bvv = B22 - 2.0 * B02 + B00;
  e.Buv = B12 - B01 - B02 + B00;
  return e;
}

fn minIndex(w: vec3f) -> u32 {
  if (w.x < w.y) {
    if (w.x < w.z) { return 0u; }
    return 2u;
  }
  if (w.y < w.z) { return 1u; }
  return 2u;
}

// Barycentrics in `to` of a point given by weights `w` on the corners of `from`.
fn carryWeights(srcTri: u32, dstTri: u32, w: vec3f) -> vec3f {
  let ids = tris[srcTri].idx;
  let nids = tris[dstTri].idx;
  var nw = vec3f(0.0);
  for (var k = 0u; k < 3u; k++) {
    for (var j = 0u; j < 3u; j++) {
      if (nids[j] == ids[k]) {
        nw[j] = w[k];
      }
    }
  }
  return nw;
}

struct PNStart {
  tri: u32,
  u: f32,
  v: f32,
};

// Flat walk in projection along D toward the ray's footprint (see flatWalk in pn.ts).
fn pnFlatWalk(startTri: u32, O: vec3f, D: vec3f) -> PNStart {
  var a = vec3f(1.0, 0.0, 0.0);
  if (abs(D.x) >= 0.9) {
    a = vec3f(0.0, 1.0, 0.0);
  }
  let e1 = normalize(a - D * dot(a, D));
  let e2 = cross(D, e1);

  var tri = startTri;
  var prev = -1;
  var w = vec3f(1.0 / 3.0);
  for (var hop = 0; hop < PN_MAX_FLAT_HOPS; hop++) {
    let t = tris[tri];
    let d0 = verts[t.idx.x].pos - O;
    let d1 = verts[t.idx.y].pos - O;
    let d2 = verts[t.idx.z].pos - O;
    let P0 = vec2f(dot(d0, e1), dot(d0, e2));
    let P1 = vec2f(dot(d1, e1), dot(d1, e2));
    let P2 = vec2f(dot(d2, e1), dot(d2, e2));
    let area = (P1.x - P0.x) * (P2.y - P0.y) - (P1.y - P0.y) * (P2.x - P0.x);
    if (abs(area) < 1e-20) {
      break;
    }
    let b0 = (P1.x * P2.y - P1.y * P2.x) / area;
    let b1 = (P2.x * P0.y - P2.y * P0.x) / area;
    w = vec3f(b0, b1, 1.0 - b0 - b1);
    let k = minIndex(w);
    if (w[k] >= 0.0) {
      break;
    }
    let nb = pnNeighbour(tri, k);
    if (nb < 0 || nb == prev) {
      break;
    }
    prev = i32(tri);
    tri = u32(nb);
  }
  let cw = max(w, vec3f(0.0));
  let s = max(cw.x + cw.y + cw.z, 1e-12);
  return PNStart(tri, cw.y / s, cw.z / s);
}

struct PNResult {
  tri: u32,
  u: f32,
  v: f32,
  dist: f32,
  t: f32,
};

fn pnClosest(startTri: u32, O: vec3f, D: vec3f) -> PNResult {
  let start = pnFlatWalk(startTri, O, D);
  var tri = start.tri;
  var u = start.u;
  var v = start.v;
  var lambda = 1e-3;
  var hops = 0;

  var e = pnEval(tri, u, v);
  var q = (e.B - O) - D * dot(e.B - O, D);
  var f = dot(q, q);
  var best = PNResult(tri, u, v, f, dot(e.B - O, D));

  for (var it = 0; it < PN_MAX_ITER; it++) {
    let pu = e.Bu - D * dot(e.Bu, D);
    let pv = e.Bv - D * dot(e.Bv, D);
    let gu = dot(pu, q);
    let gv = dot(pv, q);
    let huu = dot(pu, pu) + dot(e.Buu, q);
    let huv = dot(pu, pv) + dot(e.Buv, q);
    let hvv = dot(pv, pv) + dot(e.Bvv, q);

    var accepted = false;
    for (var tries = 0; tries < 6; tries++) {
      let damp = lambda * (abs(huu) + abs(hvv) + 1e-12);
      let a = huu + damp;
      let c = hvv + damp;
      let det = a * c - huv * huv;
      if (!(abs(det) > 1e-30)) {
        lambda *= 10.0;
        continue;
      }
      let nu = u - (c * gu - huv * gv) / det;
      let nv = v - (a * gv - huv * gu) / det;
      let te = pnEval(tri, nu, nv);
      let tq = (te.B - O) - D * dot(te.B - O, D);
      let tf = dot(tq, tq);
      if (tf < f) {
        u = nu;
        v = nv;
        e = te;
        q = tq;
        f = tf;
        lambda = max(lambda * 0.3, 1e-6);
        accepted = true;
        break;
      }
      lambda *= 10.0;
    }
    if (!accepted) {
      break;
    }

    let w = vec3f(1.0 - u - v, u, v);
    let k = minIndex(w);
    if (w[k] < -PN_HOP_SLACK) {
      let cw = max(w, vec3f(0.0));
      let s = cw.x + cw.y + cw.z;
      var nb = -1;
      if (hops < PN_MAX_HOPS) {
        nb = pnNeighbour(tri, k);
      }
      if (nb >= 0) {
        // carry the overshoot across as depth into the neighbour
        var carried = w;
        carried[k] = 0.0;
        var nw = carryWeights(tri, u32(nb), carried);
        let nids = tris[u32(nb)].idx;
        let ids = tris[tri].idx;
        for (var j = 0u; j < 3u; j++) {
          if (nids[j] != ids.x && nids[j] != ids.y && nids[j] != ids.z) {
            nw[j] = -w[k];
          }
        }
        nw /= (nw.x + nw.y + nw.z);
        tri = u32(nb);
        u = nw.y;
        v = nw.z;
        hops++;
      } else {
        u = cw.y / s;
        v = cw.z / s;
      }
      e = pnEval(tri, u, v);
      q = (e.B - O) - D * dot(e.B - O, D);
      f = dot(q, q);
    }

    if (f < best.dist) {
      best = PNResult(tri, u, v, f, dot(e.B - O, D));
    }
  }
  best.dist = sqrt(best.dist);
  return best;
}
