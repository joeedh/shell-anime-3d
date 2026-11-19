// Painting into the rgba16float maps. The mesh is drawn in UV space; falloff is measured in
// 3D, so both sides of a UV seam receive paint. Shares Vertex/Tri with common.wgsl's layout.

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

struct Dab {
  center: vec3f,
  radius: f32,
  value: f32,
  strength: f32,
  hardness: f32,
  mode: f32,
  texSize: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
};

@group(0) @binding(0) var<uniform> dab: Dab;
@group(0) @binding(1) var<storage, read> verts: array<Vertex>;
@group(0) @binding(2) var<storage, read> tris: array<Tri>;
@group(0) @binding(3) var scratch: texture_2d<f32>;
@group(0) @binding(4) var<storage, read> dilateMap: array<i32>;

struct DabOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
};

@vertex
fn vsDab(@builtin(vertex_index) vi: u32) -> DabOut {
  let t = tris[vi / 3u];
  let corner = vi % 3u;
  var uv = t.uv0;
  if (corner == 1u) { uv = t.uv1; }
  if (corner == 2u) { uv = t.uv2; }

  var o: DabOut;
  o.clip = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  o.world = verts[t.idx[corner]].pos;
  return o;
}

fn falloff(world: vec3f) -> f32 {
  let d = distance(world, dab.center) / dab.radius;
  if (d >= 1.0) {
    return 0.0;
  }
  return 1.0 - smoothstep(min(dab.hardness, 0.999), 1.0, d);
}

// SET and SMOOTH blend with src-alpha; ADD blends one/one.
@fragment
fn fsDab(i: DabOut) -> @location(0) vec4f {
  let f = falloff(i.world);
  if (f <= 0.0) {
    discard;
  }
  let a = dab.strength * f;

  if (dab.mode > 1.5) {
    // smooth: 3x3 box average of the stroke-start copy around this texel
    let c = vec2i(i.clip.xy);
    var sum = vec4f(0.0);
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let p = clamp(c + vec2i(dx, dy), vec2i(0), vec2i(i32(dab.texSize) - 1));
        sum += textureLoad(scratch, p, 0);
      }
    }
    return vec4f((sum / 9.0).xyz, a);
  }
  if (dab.mode > 0.5) {
    return vec4f(vec3f(dab.value * a), 0.0);
  }
  return vec4f(vec3f(dab.value), a);
}

// Gutter fill: copy each gutter texel's value from its nearest covered texel.
@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fsDilate(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let size = i32(dab.texSize);
  let c = vec2i(pos.xy);
  let src = dilateMap[c.y * size + c.x];
  if (src < 0) {
    discard;
  }
  return textureLoad(scratch, vec2i(src % size, src / size), 0);
}
