// Reference build: classify refined triangles, emit ball samples, fill the spatial hash.

@group(1) @binding(0) var<uniform> rp: RefParams;
@group(1) @binding(1) var<storage, read_write> ctl: array<atomic<u32>>;
// per triangle: sample offset, grid divisions, flags, unused
@group(1) @binding(2) var<storage, read_write> triState: array<vec4u>;
// xyz = position, w = radius
@group(1) @binding(3) var<storage, read_write> samples: array<vec4f>;
// hash heads (hashMask + 1 words; 0 = empty, else sample + 1), then one `next` per sample
@group(1) @binding(4) var<storage, read_write> hash: array<atomic<u32>>;
@group(1) @binding(5) var<storage, read_write> drawList: array<u32>;

struct TriInfo {
  r: f32,
  rMin: f32,
  pwMin: f32,
  // smallest |n.v| over the corners, 0 if the triangle straddles the contour
  ndv: f32,
  kmax: f32,
};

fn triInfo(t: u32) -> TriInfo {
  var info: TriInfo;
  info.r = 0.0;
  info.rMin = 1e30;
  info.pwMin = 1e30;
  info.ndv = 1e30;
  info.kmax = 0.0;
  var pos = false;
  var neg = false;
  for (var k = 0u; k < 3u; k++) {
    let v = triVertex(t, k);
    let r = refRadius(v.pos, triUV(t, k));
    info.r = max(info.r, r);
    info.rMin = min(info.rMin, r);
    info.pwMin = min(info.pwMin, pixelWorld(v.pos));
    let d = dot(normalize(v.nor), viewRayDir(v.pos));
    info.ndv = min(info.ndv, abs(d));
    pos = pos || d > 0.0;
    neg = neg || d < 0.0;
    info.kmax = max(info.kmax, v.extra);
  }
  if (pos && neg) {
    info.ndv = 0.0;
  }
  return info;
}

@compute @workgroup_size(64)
fn csClassify(@builtin(global_invocation_id) gid: vec3u) {
  let t = gid.x;
  if (t >= rp.triCount) {
    return;
  }
  triState[t] = vec4u(0u);
  let info = triInfo(t);
  if (info.r <= 0.0) {
    return;
  }
  let cutoff = sqrt(2.0 * info.r * info.kmax) + rp.drawMargin;
  let hashCutoff = cutoff + 2.0 * info.r * info.kmax + rp.hashMargin;
  if (info.ndv >= hashCutoff) {
    return;
  }
  var flags = TRI_HASH;
  if (info.ndv < cutoff) {
    flags |= TRI_DRAW;
  }

  // grid spacing h <= r/2, but no finer than half a pixel
  let h = max(0.5 * info.rMin, 0.5 * info.pwMin);
  let a = verts[tris[t].idx.x].pos;
  let b = verts[tris[t].idx.y].pos;
  let c = verts[tris[t].idx.z].pos;
  let edge = max(length(b - a), max(length(c - b), length(a - c)));
  var n = max(u32(ceil(edge / h)), 1u);
  if (n > rp.maxGrid) {
    n = rp.maxGrid;
    atomicOr(&ctl[CTL_OVERFLOW], OVERFLOW_GRID);
  }
  let count = (n + 1u) * (n + 2u) / 2u;
  let off = atomicAdd(&ctl[CTL_SAMPLES], count);
  if (off + count > rp.sampleCap) {
    atomicOr(&ctl[CTL_OVERFLOW], OVERFLOW_SAMPLES);
    return;
  }
  // positive floats order like their bit patterns
  atomicMax(&ctl[CTL_RMAX], bitcast<u32>(info.r));
  triState[t] = vec4u(off, n, flags, 0u);
}

@compute @workgroup_size(64)
fn csEmit(@builtin(global_invocation_id) gid: vec3u) {
  let t = gid.x;
  if (t >= rp.triCount) {
    return;
  }
  let st = triState[t];
  if (st.z == 0u) {
    return;
  }
  let cell = bitcast<f32>(atomicLoad(&ctl[CTL_RMAX]));
  let n = st.y;
  let tri = tris[t];
  let a = verts[tri.idx.x].pos;
  let b = verts[tri.idx.y].pos;
  let c = verts[tri.idx.z].pos;
  let headCount = rp.hashMask + 1u;

  var s = st.x;
  for (var i = 0u; i <= n; i++) {
    for (var j = 0u; j <= n - i; j++) {
      let w1 = f32(i) / f32(n);
      let w2 = f32(j) / f32(n);
      let w0 = 1.0 - w1 - w2;
      let p = a * w0 + b * w1 + c * w2;
      let uv = tri.uv0 * w0 + tri.uv1 * w1 + tri.uv2 * w2;
      let nor = verts[tri.idx.x].nor * w0 + verts[tri.idx.y].nor * w1 + verts[tri.idx.z].nor * w2;
      let r = refRadius(p, uv);
      samples[s] = vec4f(p, r);

      let slot = refHash(refCell(p, cell), rp.hashMask);
      let old = atomicExchange(&hash[slot], s + 1u);
      atomicStore(&hash[headCount + s], old);

      // an exit on the outer envelope lies along +n from its ball, so only balls facing
      // away from the eye can produce one; the rest only serve for containment
      let backFacing = dot(nor, viewRayDir(p)) > -rp.facingSlack * length(nor);
      if ((st.z & TRI_DRAW) != 0u && r > 0.0 && backFacing) {
        let d = atomicAdd(&ctl[CTL_DRAWS], 1u);
        if (d < rp.drawCap) {
          drawList[d] = s;
        }
      }
      s++;
    }
  }
}

@compute @workgroup_size(1)
fn csArgs() {
  let draws = atomicLoad(&ctl[CTL_DRAWS]);
  if (draws > rp.drawCap) {
    atomicOr(&ctl[CTL_OVERFLOW], OVERFLOW_DRAWS);
  }
  atomicStore(&ctl[CTL_ARGS], 6u);
  atomicStore(&ctl[CTL_ARGS + 1u], min(draws, rp.drawCap));
  atomicStore(&ctl[CTL_ARGS + 2u], 0u);
  atomicStore(&ctl[CTL_ARGS + 3u], 0u);
}
