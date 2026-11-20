// Shell pass: an inverted hull extruded by the conservative width, trimmed per fragment by
// the active clip model. The sphere model is a line-for-line port of src/math/clip_sphere.ts.

const SPHERE_EPS: f32 = 5e-5;

struct ShellOut {
  @builtin(position) clip: vec4f,
  @location(0) viewPos: vec3f,
  @location(1) bary: vec3f,
  @location(2) @interpolate(flat) tri: u32,
  // algebraic sphere in view space: u0, u.xyz, u4
  @location(3) sphereU: vec4f,
  @location(4) sphereU4: f32,
  @location(5) world: vec3f,
};

@vertex
fn vsShell(@builtin(vertex_index) vi: u32) -> ShellOut {
  let tri = vi / 3u;
  let corner = vi % 3u;
  let v = triVertex(tri, corner);

  let e = max(v.wmax, 0.0) * pixelWorld(v.pos) * (1.0 + v.cRel) + v.cAbs;
  let world = v.pos + v.nor * e;

  // the per-vertex sphere is built in view space, where magnitudes stay small
  let P = (cam.view * vec4f(v.pos, 1.0)).xyz;
  let N = normalize((cam.view * vec4f(v.nor, 0.0)).xyz);
  let H = v.H;

  var o: ShellOut;
  o.clip = cam.viewProj * vec4f(world, 1.0);
  o.viewPos = (cam.view * vec4f(world, 1.0)).xyz;
  o.world = world;
  o.bary = barycentricCorner(corner);
  o.tri = tri;
  o.sphereU = vec4f(0.5 * H * dot(P, P) - dot(N, P), N - H * P);
  o.sphereU4 = 0.5 * H;
  return o;
}

struct ClipResult {
  keep: bool,
  hasExit: bool,
  exitT: f32,
};

fn sphereClip(u: vec4f, u4: f32, O: vec3f, D: vec3f, r: f32) -> ClipResult {
  var res: ClipResult;
  res.keep = true;
  res.hasExit = false;
  if (abs(u4) <= SPHERE_EPS) {
    return res;
  }
  let C = -u.yzw / (2.0 * u4);
  let R = sqrt(max(0.0, dot(C, C) - u.x / u4));
  let oc = C - O;
  let tc = dot(oc, D);
  let d2 = max(0.0, dot(oc, oc) - tc * tc);
  let Ro = R + r;
  if (d2 >= Ro * Ro) {
    res.keep = false;
    return res;
  }
  res.hasExit = true;
  res.exitT = tc + sqrt(Ro * Ro - d2);
  return res;
}

struct ShellFrag {
  @location(0) color: vec4f,
  // model mask for the compare pass
  @location(1) mask: f32,
  @builtin(frag_depth) depth: f32,
};

@fragment
fn fsShell(i: ShellOut) -> ShellFrag {
  let t = tris[i.tri];
  let uv = t.uv0 * i.bary.x + t.uv1 * i.bary.y + t.uv2 * i.bary.z;

  // view-space ray through this fragment
  var O = vec3f(0.0);
  var D = normalize(i.viewPos);
  if (cam.ortho > 0.5) {
    O = vec3f(i.viewPos.xy, 0.0);
    D = vec3f(0.0, 0.0, -1.0);
  }
  let worldDir = normalize((vec4f(D, 0.0) * cam.view).xyz);
  let depth = -i.viewPos.z;
  var pw = cam.pixelScale * depth;
  if (cam.ortho > 0.5) {
    pw = cam.pixelScale;
  }
  let r = targetWidthPx(uv, worldDir) * pw;

  var res: ClipResult;
  res.keep = true;
  res.hasExit = false;
  var exitWorld = vec3f(0.0);
  var hasWorldExit = false;
  if (cam.clipModel > 0.5 && cam.clipModel < 1.5) {
    res = sphereClip(i.sphereU, i.sphereU4, O, D, r);
  } else if (cam.clipModel > 1.5) {
    // PN: is the world-space ray inside the width envelope of the patch union?
    let pe = pnEnvelope(i.tri, i.world, worldDir, pw);
    res.keep = envHit(pe);
    if (res.keep) {
      hasWorldExit = true;
      let t = dot(pe.e.B - i.world, worldDir);
      exitWorld = i.world + worldDir * (t + sqrt(max(pe.rad.r * pe.rad.r - pe.d * pe.d, 0.0)));
    }
  }
  if (!res.keep) {
    discard;
  }

  var o: ShellFrag;
  o.color = vec4f(cam.lineColor, 1.0);
  o.mask = 1.0;
  o.depth = i.clip.z;
  if (hasWorldExit) {
    let c = cam.viewProj * vec4f(exitWorld, 1.0);
    o.depth = clamp(c.z / c.w, 0.0, 1.0);
  }
  if (res.hasExit) {
    // depth of the offset surface's exit point, so nearer geometry occludes correctly
    let p = O + D * res.exitT;
    let c = cam.proj * vec4f(p, 1.0);
    o.depth = clamp(c.z / c.w, 0.0, 1.0);
  }
  return o;
}
