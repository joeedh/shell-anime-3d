import { Mesh, PrimitiveParams, PrimitiveType } from "./mesh";

type Vec3 = [number, number, number];
type SurfaceFn = (u: number, v: number) => Vec3;
interface RawMesh {
  pos: number[];
  tris: number[];
}

/** Appends an (nu x nv) parametric grid over [0,1]^2; u x v must point outward. */
function gridSurface(nu: number, nv: number, f: SurfaceFn, out: RawMesh) {
  const base = out.pos.length / 3;
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      out.pos.push(...f(i / nu, j / nv));
    }
  }
  const row = nu + 1;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = base + j * row + i;
      const b = a + 1;
      const c = a + row + 1;
      const d = a + row;
      out.tris.push(a, b, c, a, c, d);
    }
  }
}

/** Merges coincident points (seams, poles) and drops the degenerate triangles that leaves. */
function weld(raw: RawMesh, eps = 1e-5): RawMesh {
  const map = new Map<string, number>();
  const remap = new Int32Array(raw.pos.length / 3);
  const pos: number[] = [];
  const q = (x: number) => Math.round(x / eps);

  for (let i = 0; i < raw.pos.length / 3; i++) {
    const key = `${q(raw.pos[i * 3])},${q(raw.pos[i * 3 + 1])},${q(raw.pos[i * 3 + 2])}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = pos.length / 3;
      map.set(key, idx);
      pos.push(raw.pos[i * 3], raw.pos[i * 3 + 1], raw.pos[i * 3 + 2]);
    }
    remap[i] = idx;
  }

  const tris: number[] = [];
  for (let t = 0; t < raw.tris.length; t += 3) {
    const a = remap[raw.tris[t]];
    const b = remap[raw.tris[t + 1]];
    const c = remap[raw.tris[t + 2]];
    if (a !== b && b !== c && a !== c) {
      tris.push(a, b, c);
    }
  }
  return { pos, tris };
}

function cube(n: number, r: number): RawMesh {
  const out: RawMesh = { pos: [], tris: [] };
  // per face: origin corner, u axis, v axis, with u x v pointing outward
  const faces: [Vec3, Vec3, Vec3][] = [
    [
      [1, -1, 1],
      [0, 0, -1],
      [0, 1, 0],
    ],
    [
      [-1, -1, -1],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [-1, 1, 1],
      [1, 0, 0],
      [0, 0, -1],
    ],
    [
      [-1, -1, -1],
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [-1, -1, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, -1, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
  ];
  for (const [o, du, dv] of faces) {
    gridSurface(
      n,
      n,
      (u, v) => [
        r * (o[0] + 2 * u * du[0] + 2 * v * dv[0]),
        r * (o[1] + 2 * u * du[1] + 2 * v * dv[1]),
        r * (o[2] + 2 * u * du[2] + 2 * v * dv[2]),
      ],
      out,
    );
  }
  return out;
}

function uvSphere(seg: number, rings: number, r: number): RawMesh {
  const out: RawMesh = { pos: [], tris: [] };
  gridSurface(
    seg,
    rings,
    (u, v) => {
      const th = u * Math.PI * 2;
      const ph = Math.PI * (1 - v);
      return [r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), -r * Math.sin(ph) * Math.sin(th)];
    },
    out,
  );
  return out;
}

function icosphere(level: number, r: number): RawMesh {
  const t = (1 + Math.sqrt(5)) / 2;
  const pos = [
    -1,
    t,
    0,
    1,
    t,
    0,
    -1,
    -t,
    0,
    1,
    -t,
    0,
    0,
    -1,
    t,
    0,
    1,
    t,
    0,
    -1,
    -t,
    0,
    1,
    -t,
    t,
    0,
    -1,
    t,
    0,
    1,
    -t,
    0,
    -1,
    -t,
    0,
    1,
  ];
  let tris = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4,
    3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];

  for (let l = 0; l < level; l++) {
    const mid = new Map<string, number>();
    const getMid = (a: number, b: number) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let m = mid.get(key);
      if (m === undefined) {
        m = pos.length / 3;
        pos.push(
          (pos[a * 3] + pos[b * 3]) / 2,
          (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2,
          (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2,
        );
        mid.set(key, m);
      }
      return m;
    };
    const next: number[] = [];
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i];
      const b = tris[i + 1];
      const c = tris[i + 2];
      const ab = getMid(a, b);
      const bc = getMid(b, c);
      const ca = getMid(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    tris = next;
  }

  for (let i = 0; i < pos.length; i += 3) {
    const l = Math.hypot(pos[i], pos[i + 1], pos[i + 2]);
    pos[i] *= r / l;
    pos[i + 1] *= r / l;
    pos[i + 2] *= r / l;
  }
  return { pos, tris };
}

/** Capsule along Y: a cylinder of radius r and half-length h, capped by hemispheres. */
function capsule(seg: number, rings: number, r: number, h: number): RawMesh {
  const out: RawMesh = { pos: [], tris: [] };
  // v walks from the bottom pole to the top pole, spaced by arc length
  const capLen = (Math.PI / 2) * r;
  const total = 2 * capLen + 2 * h;
  gridSurface(
    seg,
    rings,
    (u, v) => {
      const s = v * total;
      let y: number;
      let rad: number;
      if (s < capLen) {
        const a = s / r - Math.PI / 2;
        y = -h + r * Math.sin(a);
        rad = r * Math.cos(a);
      } else if (s < capLen + 2 * h) {
        y = -h + (s - capLen);
        rad = r;
      } else {
        const a = (s - capLen - 2 * h) / r;
        y = h + r * Math.sin(a);
        rad = r * Math.cos(a);
      }
      const th = u * Math.PI * 2;
      return [rad * Math.cos(th), y, -rad * Math.sin(th)];
    },
    out,
  );
  return out;
}

function torus(segU: number, segV: number, R: number, r: number): RawMesh {
  const out: RawMesh = { pos: [], tris: [] };
  gridSurface(
    segU,
    segV,
    (u, v) => {
      const th = u * Math.PI * 2;
      const ph = v * Math.PI * 2;
      const d = R + r * Math.cos(ph);
      return [d * Math.cos(th), r * Math.sin(ph), -d * Math.sin(th)];
    },
    out,
  );
  return out;
}

/** Dimensions each primitive actually uses, derived from radius/radius2. */
function dims(params: PrimitiveParams) {
  return {
    capsuleRadius: params.radius * 0.5,
    capsuleHalfLength: params.radius2 * 2,
    torusMajor: params.radius * 0.75,
    torusMinor: params.radius2 * 0.75,
  };
}

/** Generates the primitive described by `params`. UVs are left zero for the unwrapper. */
export function makePrimitive(params: PrimitiveParams): Mesh {
  const d = Math.max(1, Math.round(params.density));
  const dm = dims(params);
  let raw: RawMesh;
  let analytic = true;

  switch (params.type) {
    case PrimitiveType.CUBE:
      raw = cube(Math.max(1, Math.round(d / 2)), params.radius / Math.sqrt(3));
      analytic = false;
      break;
    case PrimitiveType.ICOSPHERE:
      raw = icosphere(Math.max(0, Math.min(6, Math.floor(Math.log2(d)) - 1)), params.radius);
      break;
    case PrimitiveType.CAPSULE:
      raw = capsule(Math.max(3, d * 2), Math.max(4, d * 2), dm.capsuleRadius, dm.capsuleHalfLength);
      break;
    case PrimitiveType.TORUS:
      raw = torus(Math.max(3, d * 2), Math.max(3, d), dm.torusMajor, dm.torusMinor);
      break;
    case PrimitiveType.UV_SPHERE:
    default:
      raw = uvSphere(Math.max(3, d * 2), Math.max(2, d), params.radius);
      break;
  }

  const w = weld(raw);
  const mesh = Mesh.fromArrays(w.pos, w.tris);
  mesh.primitive = params.copy();
  mesh.isAnalytic = analytic;
  return mesh;
}

/** Closest point on the primitive's true surface; the reference projects onto this. */
export function projectToAnalytic(params: PrimitiveParams, p: Vec3): Vec3 {
  const dm = dims(params);
  switch (params.type) {
    case PrimitiveType.UV_SPHERE:
    case PrimitiveType.ICOSPHERE: {
      const r = params.radius;
      const l = Math.hypot(p[0], p[1], p[2]) || 1;
      return [(p[0] * r) / l, (p[1] * r) / l, (p[2] * r) / l];
    }
    case PrimitiveType.CAPSULE: {
      const rad = dm.capsuleRadius;
      const cy = Math.max(-dm.capsuleHalfLength, Math.min(dm.capsuleHalfLength, p[1]));
      const dy = p[1] - cy;
      const l = Math.hypot(p[0], dy, p[2]) || 1;
      return [(p[0] * rad) / l, cy + (dy * rad) / l, (p[2] * rad) / l];
    }
    case PrimitiveType.TORUS: {
      const lxz = Math.hypot(p[0], p[2]) || 1;
      const cx = (p[0] / lxz) * dm.torusMajor;
      const cz = (p[2] / lxz) * dm.torusMajor;
      const dx = p[0] - cx;
      const dz = p[2] - cz;
      const l = Math.hypot(dx, p[1], dz) || 1;
      const rt = dm.torusMinor;
      return [cx + (dx * rt) / l, (p[1] * rt) / l, cz + (dz * rt) / l];
    }
    default:
      return p;
  }
}
