// Base pass: toon-shaded mesh via vertex pulling; writes base depth.

struct BaseOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) nor: vec3f,
  @location(2) bary: vec3f,
  @location(3) uv: vec2f,
};

@vertex
fn vsBase(@builtin(vertex_index) vi: u32) -> BaseOut {
  let tri = vi / 3u;
  let corner = vi % 3u;
  let v = triVertex(tri, corner);

  var o: BaseOut;
  o.clip = cam.viewProj * vec4f(v.pos, 1.0);
  o.world = v.pos;
  o.nor = v.nor;
  o.bary = barycentricCorner(corner);
  o.uv = triUV(tri, corner);
  return o;
}

@fragment
fn fsBase(i: BaseOut) -> @location(0) vec4f {
  let n = normalize(i.nor);
  let toEye = -viewRayDir(i.world);
  // key light from the upper left of the view
  let right = vec3f(cam.view[0].x, cam.view[1].x, cam.view[2].x);
  let up = vec3f(cam.view[0].y, cam.view[1].y, cam.view[2].y);
  let l = normalize(toEye + up * 0.8 - right * 0.6);

  let d = dot(n, l);
  var shade = 0.62;
  if (d > 0.55) {
    shade = 1.0;
  } else if (d > 0.05) {
    shade = 0.84;
  }
  var col = vec3f(0.96, 0.86, 0.78) * shade;

  if (cam.overlay > 0.5) {
    let m = sampleMaps(i.uv);
    var x = m.r / 12.0;
    if (cam.overlay > 1.5) { x = m.g * 0.5; }
    if (cam.overlay > 2.5) { x = m.b * 0.5; }
    x = clamp(x, 0.0, 1.0);
    // blue -> green -> yellow -> red
    let heat = clamp(vec3f(x * 2.0 - 0.5, 1.5 - abs(x * 2.0 - 1.0) * 1.5, 1.0 - x * 2.0), vec3f(0.0), vec3f(1.0));
    col = mix(col, heat * shade, 0.75);
  }

  if (cam.showWire > 0.5) {
    let fw = fwidth(i.bary);
    let edge = smoothstep(vec3f(0.0), fw * 1.2, i.bary);
    let e = 1.0 - min(edge.x, min(edge.y, edge.z));
    col = mix(col, vec3f(0.25, 0.3, 0.4), e * 0.6);
  }
  return vec4f(col, 1.0);
}
