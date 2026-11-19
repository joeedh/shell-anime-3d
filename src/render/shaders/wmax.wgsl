// Per-vertex conservative line width: the maximum of R * max(G, B) over the texels of each
// incident triangle's UV bounding box. Each triangle's corners lie in one chart, so boxes
// are taken per triangle (never across a seam). Writes straight into the vertex records.

struct Vertex {
  pos: vec3f,
  H: f32,
  nor: vec3f,
  wmax: f32,
  cAbs: f32,
  cRel: f32,
  pad0: f32,
  pad1: f32,
};

struct Tri {
  idx: vec3u,
  pad0: u32,
  uv0: vec2f,
  uv1: vec2f,
  uv2: vec2f,
  pad1: vec2f,
};

struct Params {
  count: u32,
  allVerts: u32,
  texSize: u32,
  pad: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> verts: array<Vertex>;
@group(0) @binding(2) var<storage, read> tris: array<Tri>;
@group(0) @binding(3) var<storage, read> vertTriStart: array<u32>;
@group(0) @binding(4) var<storage, read> vertTris: array<u32>;
@group(0) @binding(5) var<storage, read> vertList: array<u32>;
@group(0) @binding(6) var maps: texture_2d<f32>;

@compute @workgroup_size(64)
fn csWmax(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.count) {
    return;
  }
  var v = gid.x;
  if (params.allVerts == 0u) {
    v = vertList[gid.x];
  }

  let size = f32(params.texSize);
  let maxc = vec2i(i32(params.texSize) - 1);
  var w = 0.0;

  for (var i = vertTriStart[v]; i < vertTriStart[v + 1u]; i++) {
    let t = tris[vertTris[i]];
    let lo = min(t.uv0, min(t.uv1, t.uv2)) * size;
    let hi = max(t.uv0, max(t.uv1, t.uv2)) * size;
    // one texel of slack covers bilinear sampling at the edges
    let a = clamp(vec2i(floor(lo)) - 1, vec2i(0), maxc);
    let b = clamp(vec2i(ceil(hi)) + 1, vec2i(0), maxc);
    for (var y = a.y; y <= b.y; y++) {
      for (var x = a.x; x <= b.x; x++) {
        let m = textureLoad(maps, vec2i(x, y), 0);
        w = max(w, m.r * max(m.g, m.b));
      }
    }
  }
  verts[v].wmax = w;
}
