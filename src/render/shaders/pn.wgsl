// Clip model 2: PN-triangle patches, envelope form. A line-for-line port of flatWalk in
// src/math/pn.ts and of src/math/pn_envelope.ts (see those files and
// docs/plans/pn-envelope.md). Works in world space; needs `pn` (binding 5) and `pnRing`
// (binding 6) from the mesh layout.

const PN_STRIDE: u32 = 12u;
const PN_MAX_FLAT_HOPS: i32 = 64;
const PN_ENV_ITER: i32 = 12;
const PN_ENV_HOPS: i32 = 8;
const PN_HOP_SLACK: f32 = 0.02;
const PN_INSIDE_EPS: f32 = 1e-6;

@group(0) @binding(5) var<storage, read> pn: array<vec4f>;
// per triangle: [offsets (triCount + 1), then the ring lists], see triRings in adjacency.ts
@group(0) @binding(6) var<storage, read> pnRing: array<u32>;

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

// Orthonormal basis (columns e1, e2) of the plane perpendicular to D.
fn pnBasis(D: vec3f) -> mat2x3f {
  var a = vec3f(1.0, 0.0, 0.0);
  if (abs(D.x) >= 0.9) {
    a = vec3f(0.0, 1.0, 0.0);
  }
  let e1 = normalize(a - D * dot(a, D));
  return mat2x3f(e1, cross(D, e1));
}

// The ray's footprint clamped into one triangle: the flat walk without hops.
fn pnFootprint(tri: u32, O: vec3f, D: vec3f) -> PNStart {
  let b = pnBasis(D);
  let t = tris[tri];
  let d0 = verts[t.idx.x].pos - O;
  let d1 = verts[t.idx.y].pos - O;
  let d2 = verts[t.idx.z].pos - O;
  let P0 = vec2f(dot(d0, b[0]), dot(d0, b[1]));
  let P1 = vec2f(dot(d1, b[0]), dot(d1, b[1]));
  let P2 = vec2f(dot(d2, b[0]), dot(d2, b[1]));
  let area = (P1.x - P0.x) * (P2.y - P0.y) - (P1.y - P0.y) * (P2.x - P0.x);
  var w = vec3f(1.0 / 3.0);
  if (abs(area) >= 1e-20) {
    let b0 = (P1.x * P2.y - P1.y * P2.x) / area;
    let b1 = (P2.x * P0.y - P2.y * P0.x) / area;
    w = vec3f(b0, b1, 1.0 - b0 - b1);
  }
  let cw = max(w, vec3f(0.0));
  let s = max(cw.x + cw.y + cw.z, 1e-12);
  return PNStart(tri, cw.y / s, cw.z / s);
}

// Flat walk in projection along D toward the ray's footprint (see flatWalk in pn.ts).
fn pnFlatWalk(startTri: u32, O: vec3f, D: vec3f) -> PNStart {
  let basis = pnBasis(D);
  let e1 = basis[0];
  let e2 = basis[1];

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

// Painted radius at a patch point, with its derivatives in the triangle's (u, v), at the
// fragment's pixel size `pw`. A manual bilinear fetch keeps value and gradient consistent.
struct EnvRadius {
  r: f32,
  ru: f32,
  rv: f32,
};

fn envRadius(tri: u32, u: f32, v: f32, headOn: f32, pw: f32) -> EnvRadius {
  let t = tris[tri];
  let w = max(vec3f(1.0 - u - v, u, v), vec3f(0.0));
  let uv = (t.uv0 * w.x + t.uv1 * w.y + t.uv2 * w.z) / max(w.x + w.y + w.z, 1e-12);
  let size = vec2f(textureDimensions(maps, 0));
  let st = uv * size - 0.5;
  let i0 = floor(st);
  let f = st - i0;
  let maxc = vec2i(size) - 1;
  let c0 = vec2i(i0);
  let a = textureLoad(maps, clamp(c0, vec2i(0), maxc), 0);
  let b = textureLoad(maps, clamp(c0 + vec2i(1, 0), vec2i(0), maxc), 0);
  let c = textureLoad(maps, clamp(c0 + vec2i(0, 1), vec2i(0), maxc), 0);
  let d = textureLoad(maps, clamp(c0 + vec2i(1, 1), vec2i(0), maxc), 0);
  let val = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  let dx = mix(b - a, d - c, f.y) * size.x;
  let dy = mix(c - a, d - b, f.x) * size.y;
  // width = R * lerp(G, B, 1 - headOn), as in targetWidthPx
  let s = 1.0 - headOn;
  let m = mix(val.g, val.b, s);
  let mx = mix(dx.g, dx.b, s);
  let my = mix(dy.g, dy.b, s);
  let wu = val.r * mx + dx.r * m;
  let wv = val.r * my + dy.r * m;
  let ju = t.uv1 - t.uv0;
  let jv = t.uv2 - t.uv0;
  return EnvRadius(
    max(val.r, 0.0) * max(m, 0.0) * pw,
    (wu * ju.x + wv * ju.y) * pw,
    (wu * jv.x + wv * jv.y) * pw,
  );
}

struct EnvPoint {
  tri: u32,
  u: f32,
  v: f32,
  e: PNEval,
  q: vec3f,
  d: f32,
  rad: EnvRadius,
};

// The fragment's ray and the inputs of its radius.
struct EnvRay {
  O: vec3f,
  D: vec3f,
  headOn: f32,
  pw: f32,
};

fn envAt(tri: u32, u: f32, v: f32, ray: EnvRay) -> EnvPoint {
  let e = pnEval(tri, u, v);
  let rel = e.B - ray.O;
  let q = rel - ray.D * dot(rel, ray.D);
  return EnvPoint(tri, u, v, e, q, length(q), envRadius(tri, u, v, ray.headOn, ray.pw));
}

fn envPhi(p: EnvPoint) -> f32 {
  return p.d - p.rad.r;
}

// φ < 0 counts only inside the triangle: within the hop slack the cubic is extrapolated.
fn envHit(p: EnvPoint) -> bool {
  let inside = p.u >= -PN_INSIDE_EPS && p.v >= -PN_INSIDE_EPS && p.u + p.v <= 1.0 + PN_INSIDE_EPS;
  return p.d < p.rad.r && inside;
}

// LM descent on φ = d − r from one start, stopping at the first hit (searchFrom in
// pn_envelope.ts).
fn envSearch(start: PNStart, ray: EnvRay) -> EnvPoint {
  let D = ray.D;
  var tri = start.tri;
  var u = start.u;
  var v = start.v;
  var hops = 0;
  var lambda = 1e-3;
  var cur = envAt(tri, u, v, ray);
  var best = cur;
  if (envHit(cur)) {
    return cur;
  }

  for (var it = 0; it < PN_ENV_ITER; it++) {
    let pu = cur.e.Bu - D * dot(cur.e.Bu, D);
    let pv = cur.e.Bv - D * dot(cur.e.Bv, D);
    // ∇d = g / d and ∇²d = h / d − g gᵀ / d³, from the half-gradient and half-Hessian of d²
    let d = max(cur.d, 1e-9);
    let d3 = d * d * d;
    let g0 = dot(pu, cur.q);
    let g1 = dot(pv, cur.q);
    let huu = (dot(pu, pu) + dot(cur.e.Buu, cur.q)) / d - g0 * g0 / d3;
    let huv = (dot(pu, pv) + dot(cur.e.Buv, cur.q)) / d - g0 * g1 / d3;
    let hvv = (dot(pv, pv) + dot(cur.e.Bvv, cur.q)) / d - g1 * g1 / d3;
    let gu = g0 / d - cur.rad.ru;
    let gv = g1 / d - cur.rad.rv;

    var accepted = false;
    for (var tries = 0; tries < 6; tries++) {
      let damp = lambda * (abs(huu) + abs(hvv) + 1e-12);
      let a = huu + damp;
      let c = hvv + damp;
      let det = a * c - huv * huv;
      // an indefinite system can point uphill; raise the damping until it is positive definite
      if (!(det > 1e-30) || a <= 0.0) {
        lambda *= 10.0;
        continue;
      }
      let trial = envAt(tri, u - (c * gu - huv * gv) / det, v - (a * gv - huv * gu) / det, ray);
      if (envPhi(trial) < envPhi(cur)) {
        u = trial.u;
        v = trial.v;
        cur = trial;
        lambda = max(lambda * 0.3, 1e-6);
        accepted = true;
        break;
      }
      lambda *= 10.0;
    }
    if (!accepted) {
      break;
    }

    // leaving the triangle: hop across the crossed edge, or clamp when out of hops
    let w = vec3f(1.0 - u - v, u, v);
    let k = minIndex(w);
    if (w[k] < -PN_HOP_SLACK) {
      var nb = -1;
      if (hops < PN_ENV_HOPS) {
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
        let cw = max(w, vec3f(0.0));
        let s = cw.x + cw.y + cw.z;
        u = cw.y / s;
        v = cw.z / s;
      }
      cur = envAt(tri, u, v, ray);
    }

    if (envPhi(cur) < envPhi(best)) {
      best = cur;
    }
    if (envHit(cur)) {
      return cur;
    }
  }
  return best;
}

// Lower bound of the ray's distance to a patch: its control points' projected bounding box.
fn pnBoxDistance(tri: u32, O: vec3f, b: mat2x3f) -> f32 {
  var lo = vec2f(1e30);
  var hi = vec2f(-1e30);
  for (var k = 0u; k < 10u; k++) {
    let rel = pnCP(tri, k) - O;
    let p = vec2f(dot(rel, b[0]), dot(rel, b[1]));
    lo = min(lo, p);
    hi = max(hi, p);
  }
  return length(max(max(lo, vec2f(0.0)), -hi));
}

// Whether the ray O + tD, through a shell fragment of `fragTri` with pixel size `pw`, passes
// inside the width envelope of the patch union: the fragment's own flat-walk search, then
// its ring.
fn pnEnvelope(fragTri: u32, O: vec3f, D: vec3f, pw: f32) -> EnvPoint {
  let ray = EnvRay(O, D, abs(dot(D, normalize(cam.frontAxis))), pw);
  let first = pnFlatWalk(fragTri, O, D);
  var best = envSearch(first, ray);
  if (envHit(best)) {
    return best;
  }

  let b = pnBasis(D);
  let end = pnRing[first.tri + 1u];
  for (var i = pnRing[first.tri]; i < end; i++) {
    let t = pnRing[i];
    let sphere = pn[t * PN_STRIDE + 11u];
    let idx = tris[t].idx;
    let reach = max(verts[idx.x].wmax, max(verts[idx.y].wmax, verts[idx.z].wmax)) * pw;
    let rel = sphere.xyz - O;
    if (length(rel - D * dot(rel, D)) - sphere.w >= reach) {
      continue;
    }
    if (pnBoxDistance(t, O, b) >= reach) {
      continue;
    }
    let res = envSearch(pnFootprint(t, O, D), ray);
    if (envHit(res)) {
      return res;
    }
    if (envPhi(res) < envPhi(best)) {
      best = res;
    }
  }
  return best;
}
