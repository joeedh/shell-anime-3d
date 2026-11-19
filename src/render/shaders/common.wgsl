// Shared declarations, prepended to every mesh shader.

struct Camera {
  view: mat4x4f,
  proj: mat4x4f,
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  eye: vec3f,
  ortho: f32,
  viewport: vec2f,
  refHeight: f32,
  // world size of one reference pixel = pixelScale * viewDepth (perspective) or pixelScale (ortho)
  pixelScale: f32,
  frontAxis: vec3f,
  clipModel: f32,
  lineColor: vec3f,
  showWire: f32,
};

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

@group(0) @binding(0) var<uniform> cam: Camera;
@group(0) @binding(1) var<storage, read> verts: array<Vertex>;
@group(0) @binding(2) var<storage, read> tris: array<Tri>;

fn triVertex(tri: u32, corner: u32) -> Vertex {
  return verts[tris[tri].idx[corner]];
}

// View-space depth along the view axis (positive in front of the camera).
fn viewDepth(p: vec3f) -> f32 {
  return -(cam.view * vec4f(p, 1.0)).z;
}

// World size of one reference pixel at world point p.
fn pixelWorld(p: vec3f) -> f32 {
  if (cam.ortho > 0.5) {
    return cam.pixelScale;
  }
  return cam.pixelScale * viewDepth(p);
}

// Ray through a world point, from the eye (perspective) or along the view axis (ortho).
fn viewRayDir(p: vec3f) -> vec3f {
  if (cam.ortho > 0.5) {
    return -normalize(vec3f(cam.view[0].z, cam.view[1].z, cam.view[2].z));
  }
  return normalize(p - cam.eye);
}

fn barycentricCorner(corner: u32) -> vec3f {
  return vec3f(f32(corner == 0u), f32(corner == 1u), f32(corner == 2u));
}
