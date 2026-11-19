import type { Mesh } from "./mesh";

/** Ray hit on a mesh triangle; `u`, `v` weight corners 1 and 2. */
export interface RayHit {
  tri: number;
  t: number;
  u: number;
  v: number;
  point: [number, number, number];
}

const LEAF_SIZE = 4;

/**
 * Bounding-volume hierarchy over a mesh's triangles: raycasts for brushes, sphere queries
 * for dab footprints. Built by median split; `refit()` updates boxes after vertices move.
 */
export class TriBVH {
  /** Per node: minx, miny, minz, maxx, maxy, maxz. */
  private boxes: Float32Array;
  /** Per node: left child (or -1 for a leaf), right child / first item, item count. */
  private nodes: Int32Array;
  private items: Uint32Array;
  private nodeCount = 0;

  constructor(private mesh: Mesh) {
    const nt = mesh.triCount;
    const maxNodes = 2 * nt + 1;
    this.boxes = new Float32Array(maxNodes * 6);
    this.nodes = new Int32Array(maxNodes * 3);
    this.items = new Uint32Array(nt);
    for (let i = 0; i < nt; i++) this.items[i] = i;

    const centroids = new Float32Array(nt * 3);
    const p = mesh.positions;
    for (let t = 0; t < nt; t++) {
      for (let k = 0; k < 3; k++) {
        const v = mesh.tris[t * 3 + k];
        centroids[t * 3] += p[v * 3] / 3;
        centroids[t * 3 + 1] += p[v * 3 + 1] / 3;
        centroids[t * 3 + 2] += p[v * 3 + 2] / 3;
      }
    }
    this.build(0, nt, centroids);
    this.refit();
  }

  private build(start: number, end: number, centroids: Float32Array): number {
    const node = this.nodeCount++;
    if (end - start <= LEAF_SIZE) {
      this.nodes[node * 3] = -1;
      this.nodes[node * 3 + 1] = start;
      this.nodes[node * 3 + 2] = end - start;
      return node;
    }

    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const t = this.items[i];
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], centroids[t * 3 + k]);
        hi[k] = Math.max(hi[k], centroids[t * 3 + k]);
      }
    }
    const axis =
      hi[0] - lo[0] > hi[1] - lo[1]
        ? hi[0] - lo[0] > hi[2] - lo[2]
          ? 0
          : 2
        : hi[1] - lo[1] > hi[2] - lo[2]
          ? 1
          : 2;

    const sub = Array.from(this.items.subarray(start, end));
    sub.sort((a, b) => centroids[a * 3 + axis] - centroids[b * 3 + axis]);
    this.items.set(sub, start);

    const mid = (start + end) >> 1;
    const left = this.build(start, mid, centroids);
    const right = this.build(mid, end, centroids);
    this.nodes[node * 3] = left;
    this.nodes[node * 3 + 1] = right;
    return node;
  }

  /** Recomputes every box bottom-up; topology must not have changed. */
  refit() {
    const p = this.mesh.positions;
    const tris = this.mesh.tris;
    const b = this.boxes;
    // children always have larger indices than their parent, so walk backwards
    for (let n = this.nodeCount - 1; n >= 0; n--) {
      const o = n * 6;
      b[o] = b[o + 1] = b[o + 2] = Infinity;
      b[o + 3] = b[o + 4] = b[o + 5] = -Infinity;
      const left = this.nodes[n * 3];
      if (left < 0) {
        const first = this.nodes[n * 3 + 1];
        const count = this.nodes[n * 3 + 2];
        for (let i = first; i < first + count; i++) {
          const t = this.items[i];
          for (let k = 0; k < 3; k++) {
            const v = tris[t * 3 + k];
            for (let a = 0; a < 3; a++) {
              b[o + a] = Math.min(b[o + a], p[v * 3 + a]);
              b[o + 3 + a] = Math.max(b[o + 3 + a], p[v * 3 + a]);
            }
          }
        }
      } else {
        for (const c of [left, this.nodes[n * 3 + 1]]) {
          for (let a = 0; a < 3; a++) {
            b[o + a] = Math.min(b[o + a], b[c * 6 + a]);
            b[o + 3 + a] = Math.max(b[o + 3 + a], b[c * 6 + 3 + a]);
          }
        }
      }
    }
  }

  /** Nearest front- or back-facing hit along origin + t*dir, t > 0. */
  raycast(origin: ArrayLike<number>, dir: ArrayLike<number>): RayHit | undefined {
    const inv = [1 / dir[0], 1 / dir[1], 1 / dir[2]];
    let best: RayHit | undefined;
    const stack = [0];
    const b = this.boxes;
    const p = this.mesh.positions;
    const tris = this.mesh.tris;

    while (stack.length) {
      const n = stack.pop()!;
      const o = n * 6;
      let t0 = 0;
      let t1 = best ? best.t : Infinity;
      for (let a = 0; a < 3; a++) {
        let ta = (b[o + a] - origin[a]) * inv[a];
        let tb = (b[o + 3 + a] - origin[a]) * inv[a];
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
      }
      if (t0 > t1) continue;

      const left = this.nodes[n * 3];
      if (left >= 0) {
        stack.push(left, this.nodes[n * 3 + 1]);
        continue;
      }
      const first = this.nodes[n * 3 + 1];
      for (let i = first; i < first + this.nodes[n * 3 + 2]; i++) {
        const t = this.items[i];
        const i0 = tris[t * 3] * 3;
        const i1 = tris[t * 3 + 1] * 3;
        const i2 = tris[t * 3 + 2] * 3;
        // Moller-Trumbore
        const e1 = [p[i1] - p[i0], p[i1 + 1] - p[i0 + 1], p[i1 + 2] - p[i0 + 2]];
        const e2 = [p[i2] - p[i0], p[i2 + 1] - p[i0 + 1], p[i2 + 2] - p[i0 + 2]];
        const pv = [
          dir[1] * e2[2] - dir[2] * e2[1],
          dir[2] * e2[0] - dir[0] * e2[2],
          dir[0] * e2[1] - dir[1] * e2[0],
        ];
        const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
        if (Math.abs(det) < 1e-12) continue;
        const id = 1 / det;
        const tv = [origin[0] - p[i0], origin[1] - p[i0 + 1], origin[2] - p[i0 + 2]];
        const u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) * id;
        if (u < 0 || u > 1) continue;
        const qv = [
          tv[1] * e1[2] - tv[2] * e1[1],
          tv[2] * e1[0] - tv[0] * e1[2],
          tv[0] * e1[1] - tv[1] * e1[0],
        ];
        const v = (dir[0] * qv[0] + dir[1] * qv[1] + dir[2] * qv[2]) * id;
        if (v < 0 || u + v > 1) continue;
        const tt = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) * id;
        if (tt > 1e-9 && (!best || tt < best.t)) {
          best = {
            tri: t,
            t: tt,
            u,
            v,
            point: [origin[0] + dir[0] * tt, origin[1] + dir[1] * tt, origin[2] + dir[2] * tt],
          };
        }
      }
    }
    return best;
  }

  /** Calls `cb` for each triangle whose bounding box intersects the sphere. */
  querySphere(center: ArrayLike<number>, radius: number, cb: (tri: number) => void) {
    const stack = [0];
    const b = this.boxes;
    const r2 = radius * radius;
    while (stack.length) {
      const n = stack.pop()!;
      const o = n * 6;
      let d2 = 0;
      for (let a = 0; a < 3; a++) {
        const c = center[a];
        const d = c < b[o + a] ? b[o + a] - c : c > b[o + 3 + a] ? c - b[o + 3 + a] : 0;
        d2 += d * d;
      }
      if (d2 > r2) continue;
      const left = this.nodes[n * 3];
      if (left >= 0) {
        stack.push(left, this.nodes[n * 3 + 1]);
      } else {
        const first = this.nodes[n * 3 + 1];
        for (let i = first; i < first + this.nodes[n * 3 + 2]; i++) cb(this.items[i]);
      }
    }
  }
}
