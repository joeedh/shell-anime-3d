/**
 * Shell-pass emulation for docs/plans/pn-envelope.md: loads tests/scenes/scene.sa3d, solves
 * the correction, extrudes the shell as vsShell does and finds each pixel's shell fragments
 * for the block saved in tests/scenes/scene_bulge_compare.txt. Also builds an oracle: the
 * exact PN width envelope by dense sampling.
 *
 * Only pixels whose ray misses the base mesh are kept: inside the silhouette the GPU also
 * depth-tests against the base, which this does not model.
 */
import { readFileSync } from "fs";
import { readSceneAuto } from "../../src/core/fileio";
import { triNeighbours } from "../../src/mesh/adjacency";
import { pnControlPoints, pnEval } from "../../src/math/pn";
import type { PNMesh, PNPatch, Vec3 } from "../../src/math/pn";
import { pnBound } from "../../src/math/pn_envelope";
import type { PNEnvelopeMesh, RadiusFn } from "../../src/math/pn_envelope";
import { triRings } from "../../src/mesh/adjacency";
import { solveCorrection } from "../../src/solver/correction";
import type { Mesh } from "../../src/mesh/mesh";
import type { PaintMaps } from "../../src/paint/paintmaps";

export const SCENE = "tests/scenes/scene.sa3d";
const MASK = "tests/scenes/scene_bulge_compare.txt";

const vtx = (a: Float32Array, i: number): Vec3 => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function pnMesh(mesh: Mesh): PNMesh {
  const nb = triNeighbours(mesh);
  const corners = (t: number): [number, number, number] => [
    mesh.tris[t * 3],
    mesh.tris[t * 3 + 1],
    mesh.tris[t * 3 + 2],
  ];
  const patches: PNPatch[] = [];
  for (let t = 0; t < mesh.triCount; t++) {
    const ids = corners(t);
    patches.push(
      pnControlPoints(
        ids.map((v) => vtx(mesh.positions, v)),
        ids.map((v) => vtx(mesh.normals, v)),
      ),
    );
  }
  return {
    corners,
    neighbour: (t, k) => nb[t * 3 + k],
    positions: (t) => corners(t).map((v) => vtx(mesh.positions, v)) as [Vec3, Vec3, Vec3],
    patch: (t) => patches[t],
  };
}

/** Bilinear sample of R·lerp(G, B, 1 − headOn) at uv, with its uv gradient (clamp-to-edge). */
function widthSampler(maps: PaintMaps) {
  const n = maps.size;
  const texel = (x: number, y: number, c: number) =>
    maps.texel(Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y)), c);
  return (U: number, V: number, headOn: number) => {
    const sx = U * n - 0.5,
      sy = V * n - 0.5;
    const x0 = Math.floor(sx),
      y0 = Math.floor(sy);
    const fx = sx - x0,
      fy = sy - y0;
    const ch = (c: number) => {
      const a = texel(x0, y0, c),
        b = texel(x0 + 1, y0, c),
        cc = texel(x0, y0 + 1, c),
        d = texel(x0 + 1, y0 + 1, c);
      const val = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
      const dx = ((b - a) * (1 - fy) + (d - cc) * fy) * n;
      const dy = ((cc - a) * (1 - fx) + (d - b) * fx) * n;
      return [val, dx, dy];
    };
    const [R, Rx, Ry] = ch(0),
      [G, Gx, Gy] = ch(1),
      [B, Bx, By] = ch(2);
    const s = 1 - headOn;
    const m = G + (B - G) * s,
      mx = Gx + (Bx - Gx) * s,
      my = Gy + (By - Gy) * s;
    const w = Math.max(R, 0) * Math.max(m, 0);
    return { w, wu: R * mx + Rx * m, wv: R * my + Ry * m };
  };
}

/** CPU port of wmax.wgsl: max of R·max(G, B) over each incident triangle's UV box. */
function computeWmax(mesh: Mesh, maps: PaintMaps) {
  const n = maps.size;
  const out = new Float32Array(mesh.vertCount);
  for (let t = 0; t < mesh.triCount; t++) {
    const us = [0, 1, 2].map((k) => mesh.uvs[t * 6 + k * 2] * n);
    const vs = [0, 1, 2].map((k) => mesh.uvs[t * 6 + k * 2 + 1] * n);
    const ax = Math.max(0, Math.floor(Math.min(...us)) - 1),
      bx = Math.min(n - 1, Math.ceil(Math.max(...us)) + 1);
    const ay = Math.max(0, Math.floor(Math.min(...vs)) - 1),
      by = Math.min(n - 1, Math.ceil(Math.max(...vs)) + 1);
    let w = 0;
    for (let y = ay; y <= by; y++)
      for (let x = ax; x <= bx; x++)
        w = Math.max(w, maps.texel(x, y, 0) * Math.max(maps.texel(x, y, 1), maps.texel(x, y, 2)));
    for (let k = 0; k < 3; k++) {
      const v = mesh.tris[t * 3 + k];
      out[v] = Math.max(out[v], w);
    }
  }
  return out;
}

/** Möller–Trumbore; returns (t, u, v) with u, v the weights of corners 1 and 2. */
function rayTri(O: Vec3, D: Vec3, p0: Vec3, p1: Vec3, p2: Vec3) {
  const e1 = sub(p1, p0),
    e2 = sub(p2, p0);
  const pv = cross(D, e2);
  const det = dot(e1, pv);
  if (Math.abs(det) < 1e-14) return undefined;
  const tv = sub(O, p0);
  const u = dot(tv, pv) / det;
  if (u < 0 || u > 1) return undefined;
  const qv = cross(tv, e1);
  const v = dot(D, qv) / det;
  if (v < 0 || u + v > 1) return undefined;
  const t = dot(e2, qv) / det;
  return t > 0 ? { t, u, v } : undefined;
}

function setup() {
  const scene = readSceneAuto(readFileSync(SCENE));
  const mesh = scene.mesh;
  const corr = solveCorrection(mesh);
  const pm = pnMesh(mesh);
  const cam = scene.camera;
  // two comment lines, the header, then one row per pixel row ('#' is also a pixel class)
  const lines = readFileSync(MASK, "utf8").split("\n").slice(2);
  const [x0, y0, bw, bh, W, H] = lines[0].split(" ").map(Number);
  const rows = lines.slice(1);

  const { view, viewProj: vpm, invViewProj: inv } = cam.matrices(W / H);
  const toScreen = (p: Vec3) => {
    const c = [0, 1, 3].map((i) => vpm[i] * p[0] + vpm[4 + i] * p[1] + vpm[8 + i] * p[2] + vpm[12 + i]);
    return [((c[0] / c[2] + 1) / 2) * W, ((1 - c[1] / c[2]) / 2) * H];
  };
  const eye = cam.eye() as unknown as Vec3;
  const ps = cam.pixelScale(scene.settings.refHeight);
  const depthOf = (p: Vec3) => -(view[2] * p[0] + view[6] * p[1] + view[10] * p[2] + view[14]);
  const unproj = (x: number, y: number, z: number): Vec3 => {
    const w = inv[3] * x + inv[7] * y + inv[11] * z + inv[15];
    return [0, 1, 2].map((i) => (inv[i] * x + inv[4 + i] * y + inv[8 + i] * z + inv[12 + i]) / w) as Vec3;
  };
  const front = scene.frontAxis as unknown as Vec3;
  const fl = Math.hypot(...front);

  // extruded shell, as vsShell builds it
  const wmax = computeWmax(mesh, scene.maps);
  const shell = new Float32Array(mesh.positions.length);
  for (let v = 0; v < mesh.vertCount; v++) {
    const p = vtx(mesh.positions, v);
    const e = wmax[v] * ps * depthOf(p) * (1 + corr.cRel[v]) + corr.cAbs[v];
    for (let k = 0; k < 3; k++) shell[v * 3 + k] = p[k] + mesh.normals[v * 3 + k] * e;
  }
  const width = widthSampler(scene.maps);

  return {
    wmax,
    mesh,
    pm,
    x0,
    y0,
    bw,
    bh,
    W,
    H,
    rows,
    eye,
    ps,
    depthOf,
    unproj,
    toScreen,
    front,
    fl,
    shell,
    width,
  };
}

export type Frag = { tri: number; u: number; v: number; world: Vec3 };
export type Pixel = { ref: boolean; gpu: boolean; D: Vec3; frags: Frag[]; px: number; py: number };

export function buildHarness() {
  const S = setup();
  const { mesh, pm } = S;
  const tri = (a: Float32Array, t: number) =>
    [0, 1, 2].map((k) => vtx(a, mesh.tris[t * 3 + k])) as [Vec3, Vec3, Vec3];

  // pixels in scope, with their fragments
  const pixels: Pixel[] = [];
  for (let j = 0; j < S.bh; j++) {
    for (let i = 0; i < S.bw; i++) {
      const c = S.rows[j][i];
      const nx = ((S.x0 + i + 0.5) / S.W) * 2 - 1,
        ny = 1 - ((S.y0 + j + 0.5) / S.H) * 2;
      const a = S.unproj(nx, ny, 0),
        b = S.unproj(nx, ny, 1);
      const d = sub(b, a);
      const l = Math.hypot(...d);
      const D: Vec3 = [d[0] / l, d[1] / l, d[2] / l];
      let onBase = false;
      const frags: Frag[] = [];
      for (let t = 0; t < mesh.triCount && !onBase; t++) {
        const [p0, p1, p2] = tri(mesh.positions, t);
        if (rayTri(S.eye, D, p0, p1, p2)) onBase = true;
        const [s0, s1, s2] = tri(S.shell, t);
        // the shell pass culls front faces, so only faces turned away from the eye draw
        if (dot(cross(sub(s1, s0), sub(s2, s0)), D) <= 0) continue;
        const h = rayTri(S.eye, D, s0, s1, s2);
        if (h)
          frags.push({
            tri: t,
            u: h.u,
            v: h.v,
            world: [S.eye[0] + D[0] * h.t, S.eye[1] + D[1] * h.t, S.eye[2] + D[2] * h.t],
          });
      }
      if (onBase || frags.length === 0) continue;
      pixels.push({
        ref: c === "#" || c === "m",
        gpu: c === "#" || c === "x",
        D,
        frags,
        px: S.x0 + i,
        py: S.y0 + j,
      });
    }
  }

  /** Radius at a patch point; a fixed `pw` (today's shader) or pixelWorld at the point. */
  const radiusFor = (D: Vec3, fixedPw?: number): RadiusFn => {
    const headOn = Math.abs(dot(D, S.front)) / S.fl;
    return (t, u, v, B) => {
      const pw = fixedPw ?? S.ps * S.depthOf(B);
      const w0 = Math.max(0, 1 - u - v),
        w1 = Math.max(0, u),
        w2 = Math.max(0, v);
      const s = w0 + w1 + w2 || 1;
      const uv = mesh.uvs;
      const du = [uv[t * 6 + 2] - uv[t * 6], uv[t * 6 + 3] - uv[t * 6 + 1]];
      const dv = [uv[t * 6 + 4] - uv[t * 6], uv[t * 6 + 5] - uv[t * 6 + 1]];
      const U = (uv[t * 6] * w0 + uv[t * 6 + 2] * w1 + uv[t * 6 + 4] * w2) / s;
      const V = (uv[t * 6 + 1] * w0 + uv[t * 6 + 3] * w1 + uv[t * 6 + 5] * w2) / s;
      const m = S.width(U, V, headOn);
      return { r: m.w * pw, ru: (m.wu * du[0] + m.wv * du[1]) * pw, rv: (m.wu * dv[0] + m.wv * dv[1]) * pw };
    };
  };
  // oracle: the exact PN envelope, by dense sampling of every patch, bucketed by screen pixel
  const N = 40;
  const REACH = 15; // screen px; the widest line here is about 8 px
  const buckets = new Map<number, { B: Vec3; r: number; t: number }[]>();
  const key = (x: number, y: number) => y * 100000 + x;
  for (let t = 0; t < mesh.triCount; t++) {
    const patch = pm.patch(t);
    for (let i = 0; i <= N; i++)
      for (let j = 0; j <= N - i; j++) {
        const B = pnEval(patch, i / N, j / N).B as Vec3;
        const [sx, sy] = S.toScreen(B);
        if (sx < S.x0 - REACH || sx > S.x0 + S.bw + REACH || sy < S.y0 - REACH || sy > S.y0 + S.bh + REACH)
          continue;
        const r = radiusFor(sub(B, S.eye))(t, i / N, j / N, B).r;
        const k = key(Math.floor(sx), Math.floor(sy));
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k)!.push({ B, r, t });
      }
  }
  // triangles holding a point whose ball reaches the pixel
  const oracleTris = pixels.map((p) => {
    const out = new Set<number>();
    for (let y = p.py - REACH; y <= p.py + REACH; y++)
      for (let x = p.px - REACH; x <= p.px + REACH; x++)
        for (const s of buckets.get(key(x, y)) ?? []) {
          const rel = sub(s.B, S.eye);
          const t = dot(rel, p.D);
          const dx = rel[0] - p.D[0] * t,
            dy = rel[1] - p.D[1] * t,
            dz = rel[2] - p.D[2] * t;
          if (dx * dx + dy * dy + dz * dz < s.r * s.r) out.add(s.t);
        }
    return out;
  });
  const oracleKeep = pixels.map((p) => {
    for (let y = p.py - REACH; y <= p.py + REACH; y++)
      for (let x = p.px - REACH; x <= p.px + REACH; x++)
        for (const s of buckets.get(key(x, y)) ?? []) {
          const rel = sub(s.B, S.eye);
          const t = dot(rel, p.D);
          const dx = rel[0] - p.D[0] * t,
            dy = rel[1] - p.D[1] * t,
            dz = rel[2] - p.D[2] * t;
          if (dx * dx + dy * dy + dz * dz < s.r * s.r) return true;
        }
    return false;
  });
  // the envelope search's view of the mesh: ring table and per-patch bounds
  const rings = triRings(mesh);
  const bounds = Array.from({ length: mesh.triCount }, (_, t) => {
    const { c, rad } = pnBound(pm.patch(t));
    const ids = pm.corners(t);
    return { c, rad, wmax: Math.max(S.wmax[ids[0]], S.wmax[ids[1]], S.wmax[ids[2]]) };
  });
  const em: PNEnvelopeMesh = {
    ...pm,
    ring: (t) => rings.subarray(rings[t], rings[t + 1]),
    bound: (t) => bounds[t],
  };
  return { S, pm, em, mesh, pixels, radiusFor, oracleTris, oracleKeep };
}
