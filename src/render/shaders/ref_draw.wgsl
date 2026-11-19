// Reference draw: one impostor quad per drawable ball. The fragment finds the pixel ray's
// far point on its ball and keeps it only if no other ball contains it (it is then on the
// union's boundary); the depth test keeps the nearest such exit.

@group(1) @binding(0) var<uniform> rp: RefParams;
@group(1) @binding(1) var<storage, read> ctl: array<u32>;
@group(1) @binding(3) var<storage, read> samples: array<vec4f>;
@group(1) @binding(4) var<storage, read> hash: array<u32>;
@group(1) @binding(5) var<storage, read> drawList: array<u32>;
@group(1) @binding(6) var refBaseDepth: texture_depth_2d;

struct ImpOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) @interpolate(flat) ball: u32,
};

fn viewForward() -> vec3f {
  return -normalize(vec3f(cam.view[0].z, cam.view[1].z, cam.view[2].z));
}

@vertex
fn vsImpostor(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> ImpOut {
  let s = drawList[ii];
  let ball = samples[s];
  let C = ball.xyz;
  let r = ball.w;

  // a square perpendicular to the ray to C, circumscribing the tangent cone's cross-section
  var f = viewForward();
  var halfSize = r;
  if (cam.ortho < 0.5) {
    let toC = C - cam.eye;
    let d = length(toC);
    f = toC / d;
    halfSize = r * d / sqrt(max(d * d - r * r, 1e-12));
  }
  var up0 = vec3f(0.0, 1.0, 0.0);
  if (abs(f.y) > 0.9) {
    up0 = vec3f(1.0, 0.0, 0.0);
  }
  let right = normalize(cross(f, up0));
  let up = cross(right, f);
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
  );
  let q = corners[vi];
  let world = C + (right * q.x + up * q.y) * halfSize;

  var o: ImpOut;
  o.clip = cam.viewProj * vec4f(world, 1.0);
  o.world = world;
  o.ball = s;
  return o;
}

// True if some ball other than `own` contains the point pOwn + rel (strictly, with radius
// scaled by sqrt(shrink)). Offsets stay relative to pOwn: absolute f32 positions several
// units from the origin lose more precision than the containment tolerance allows.
fn containedBy(pOwn: vec3f, rel: vec3f, own: u32, shrink: f32) -> bool {
  let cell = bitcast<f32>(ctl[CTL_RMAX]);
  let c0 = refCell(pOwn + rel, cell);
  let headCount = rp.hashMask + 1u;
  // the point's own cell first: most rejected points are deep inside a ball there
  for (var k = 0; k < 27; k++) {
    let m = (k + 13) % 27;
    let off = vec3i(m % 3 - 1, (m / 3) % 3 - 1, m / 9 - 1);
    {
      {
        var it = hash[refHash(c0 + off, rp.hashMask)];
        // bounded walk, so a corrupt chain cannot hang the GPU
        for (var guard = 0; guard < 4096 && it != 0u; guard++) {
          let j = it - 1u;
          if (j != own) {
            let b = samples[j];
            let d = (pOwn - b.xyz) + rel;
            if (dot(d, d) < b.w * b.w * shrink) {
              return true;
            }
          }
          it = hash[headCount + j];
        }
      }
    }
  }
  return false;
}

@fragment
fn fsImpostor(i: ImpOut) -> @builtin(frag_depth) f32 {
  let ball = samples[i.ball];
  let C = ball.xyz;
  let r = ball.w;
  var O = cam.eye;
  var D = normalize(i.world - cam.eye);
  if (cam.ortho > 0.5) {
    D = viewForward();
    O = i.world;
  }
  // far point as an offset from C: -(perpendicular part of C - O) + D * half-chord
  let co = C - O;
  let tc = dot(co, D);
  let perp = co - D * tc;
  let d2 = dot(perp, perp);
  if (d2 >= r * r) {
    discard;
  }
  let rel = -perp + D * sqrt(r * r - d2);
  let c = cam.viewProj * vec4f(C + rel, 1.0);
  let depth = c.z / c.w;
  // behind the refined surface: cannot be a line pixel, so skip the lookups
  if (depth >= textureLoad(refBaseDepth, vec2i(i.clip.xy), 0)) {
    discard;
  }

  // strictly inside another ball: not on the union's boundary
  if ((rp.debug & 2u) == 0u && containedBy(C, rel, i.ball, 1.0 - 1e-3)) {
    discard;
  }
  // a dimple between sampled balls rather than a real exit (round-2 pressure test)
  let h = max(0.5 * r, 0.5 * pixelWorld(C));
  if ((rp.debug & 1u) == 0u && containedBy(C, rel + D * (2.0 * h), i.ball, 1.0)) {
    discard;
  }
  return clamp(depth, 0.0, 1.0);
}

// Depth of the refined surface, which the reference line must lie in front of.
@vertex
fn vsRefBase(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let v = triVertex(vi / 3u, vi % 3u);
  return cam.viewProj * vec4f(v.pos, 1.0);
}
