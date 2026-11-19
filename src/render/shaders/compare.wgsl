// Compare pass: full-screen, after the model and the reference are drawn.
// Mode 1 tints reference-line pixels; mode 2 classifies against the model mask and counts.

struct CompareParams {
  mode: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};

@group(0) @binding(0) var<uniform> cp: CompareParams;
@group(0) @binding(1) var modelMask: texture_2d<f32>;
@group(0) @binding(2) var refBase: texture_depth_2d;
@group(0) @binding(3) var refExit: texture_depth_2d;
// both, reference only, model only
@group(0) @binding(4) var<storage, read_write> counts: array<atomic<u32>, 4>;

@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fsCompare(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let px = vec2i(pos.xy);
  let exitD = textureLoad(refExit, px, 0);
  let baseD = textureLoad(refBase, px, 0);
  let isRef = exitD < 1.0 && exitD < baseD;
  let isModel = textureLoad(modelMask, px, 0).r > 0.5;

  if (cp.mode == 1u) {
    if (!isRef) {
      discard;
    }
    return vec4f(0.1, 0.75, 0.3, 0.55);
  }
  if (isRef && isModel) {
    atomicAdd(&counts[0], 1u);
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  if (isRef) {
    atomicAdd(&counts[1], 1u);
    return vec4f(0.9, 0.1, 0.1, 1.0);
  }
  if (isModel) {
    atomicAdd(&counts[2], 1u);
    return vec4f(0.15, 0.35, 1.0, 1.0);
  }
  discard;
  return vec4f(0.0);
}
