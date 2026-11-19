// Ground-truth reference, shared by the build (compute) and draw (impostor) modules.
// Lines are the first-interval exits of the union of balls B(p, r(p)) over samples p on the
// refined surface near its contour; see "Ground-truth reference" in docs/plans/test-app.md.

struct RefParams {
  triCount: u32,
  sampleCap: u32,
  drawCap: u32,
  hashMask: u32,
  // |n.v| margins: impostors come from the inner band, containment balls from the wider one
  drawMargin: f32,
  hashMargin: f32,
  maxGrid: u32,
  // debug switches: 1 = skip the dimple test, 2 = skip containment
  debug: u32,
  // how far past n.v = 0 toward the eye a ball may face and still be drawn
  facingSlack: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
};

// ctl words: sample allocator, rmax (f32 bits), draw count, overflow bits, drawIndirect args
const CTL_SAMPLES: u32 = 0u;
const CTL_RMAX: u32 = 1u;
const CTL_DRAWS: u32 = 2u;
const CTL_OVERFLOW: u32 = 3u;
const CTL_ARGS: u32 = 4u;

const OVERFLOW_SAMPLES: u32 = 1u;
const OVERFLOW_DRAWS: u32 = 2u;
const OVERFLOW_GRID: u32 = 4u;

// triState flags
const TRI_HASH: u32 = 1u;
const TRI_DRAW: u32 = 2u;

fn refCell(p: vec3f, cell: f32) -> vec3i {
  return vec3i(floor(p / cell));
}

fn refHash(c: vec3i, mask: u32) -> u32 {
  let h = (bitcast<u32>(c.x) * 73856093u) ^ (bitcast<u32>(c.y) * 19349663u) ^ (bitcast<u32>(c.z) * 83492791u);
  return h & mask;
}

// World radius of the line ball at a surface point.
fn refRadius(p: vec3f, uv: vec2f) -> f32 {
  return targetWidthPx(uv, viewRayDir(p)) * pixelWorld(p);
}
