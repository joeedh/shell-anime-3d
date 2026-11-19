import { getGPU } from "./device";
import type { Mesh } from "../mesh/mesh";
import { triNeighbours } from "../mesh/adjacency";
import { pnControlPoints } from "../math/pn";
import type { Vec3 } from "../math/pn";

/** Floats per vertex record: pos.xyz, H, normal.xyz, wmax, cAbs, cRel, extra, pad. */
export const VERTEX_STRIDE = 12;
/** Words per triangle record: i0, i1, i2, pad, uv0.xy, uv1.xy, uv2.xy, pad, pad. */
export const TRI_STRIDE = 12;
/** vec4s per PN record: 10 control points (xyz), then the 3 edge neighbours (as i32 bits). */
export const PN_STRIDE = 11;

/**
 * GPU copies of a mesh for vertex pulling. Packed into two storage buffers because the
 * default limit is 8 storage buffers per shader stage (see the plan).
 */
export class MeshBuffers {
  vertexBuffer: GPUBuffer | undefined;
  triBuffer: GPUBuffer | undefined;
  /** CSR vertex -> triangles, for compute passes (wmax). */
  vertTriStartBuffer: GPUBuffer | undefined;
  vertTrisBuffer: GPUBuffer | undefined;
  /** PN control points and edge neighbours per triangle (clip model 2). */
  pnBuffer: GPUBuffer | undefined;
  private neighbours: Int32Array | undefined;
  triCount = 0;
  vertCount = 0;
  /** Bumped on every upload; per-vertex GPU-computed fields (wmax) must be refreshed after. */
  uploadCount = 0;
  private mesh: Mesh | undefined;
  private geomVersion = -1;

  /** Per-vertex values the renderer owns (curvature, conservative width), set before sync. */
  curvatureH: Float32Array | undefined;
  wmax: Float32Array | undefined;
  /** Optional per-vertex value in the record's spare slot (the reference stores kmax). */
  extra: Float32Array | undefined;

  /** @param withPN build PN patches; without them `pnBuffer` is a 16-byte placeholder. */
  constructor(readonly withPN = true) {}

  /** Re-uploads if the mesh object or its geometry version changed. */
  sync(mesh: Mesh) {
    if (mesh === this.mesh && mesh.geomVersion === this.geomVersion) {
      return;
    }
    const sameTopology = mesh === this.mesh && this.triCount === mesh.triCount;
    this.mesh = mesh;
    this.geomVersion = mesh.geomVersion;
    this.upload(mesh, !sameTopology);
  }

  private buildPN(mesh: Mesh, nb: Int32Array) {
    const nt = mesh.triCount;
    const buf = new ArrayBuffer(Math.max(1, nt) * PN_STRIDE * 16);
    const f = new Float32Array(buf);
    const iv = new Int32Array(buf);
    const p = mesh.positions,
      n = mesh.normals;
    const at = (a: Float32Array, i: number): Vec3 => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
    for (let t = 0; t < nt; t++) {
      const ids = [mesh.tris[t * 3], mesh.tris[t * 3 + 1], mesh.tris[t * 3 + 2]];
      const cp = pnControlPoints(
        ids.map((v) => at(p, v)),
        ids.map((v) => at(n, v)),
      );
      const o = t * PN_STRIDE * 4;
      for (let k = 0; k < 10; k++) f.set(cp[k], o + k * 4);
      iv[o + 40] = nb[t * 3];
      iv[o + 41] = nb[t * 3 + 1];
      iv[o + 42] = nb[t * 3 + 2];
    }
    return f;
  }

  /** Forces the next sync to upload, e.g. after per-vertex inputs changed. */
  invalidate() {
    this.geomVersion = -1;
  }

  private upload(mesh: Mesh, recreate: boolean) {
    const { device } = getGPU();
    const nv = mesh.vertCount;
    const nt = mesh.triCount;

    const vdata = new Float32Array(Math.max(1, nv) * VERTEX_STRIDE);
    for (let v = 0; v < nv; v++) {
      const o = v * VERTEX_STRIDE;
      vdata[o] = mesh.positions[v * 3];
      vdata[o + 1] = mesh.positions[v * 3 + 1];
      vdata[o + 2] = mesh.positions[v * 3 + 2];
      vdata[o + 3] = this.curvatureH?.[v] ?? 0;
      vdata[o + 4] = mesh.normals[v * 3];
      vdata[o + 5] = mesh.normals[v * 3 + 1];
      vdata[o + 6] = mesh.normals[v * 3 + 2];
      vdata[o + 7] = this.wmax?.[v] ?? 0;
      vdata[o + 8] = mesh.cAbs[v] ?? 0;
      vdata[o + 9] = mesh.cRel[v] ?? 0;
      vdata[o + 10] = this.extra?.[v] ?? 0;
    }

    const tbuf = new ArrayBuffer(Math.max(1, nt) * TRI_STRIDE * 4);
    const tu = new Uint32Array(tbuf);
    const tf = new Float32Array(tbuf);
    for (let t = 0; t < nt; t++) {
      const o = t * TRI_STRIDE;
      tu[o] = mesh.tris[t * 3];
      tu[o + 1] = mesh.tris[t * 3 + 1];
      tu[o + 2] = mesh.tris[t * 3 + 2];
      for (let k = 0; k < 6; k++) {
        tf[o + 4 + k] = mesh.uvs[t * 6 + k];
      }
    }

    if (recreate || !this.vertexBuffer || this.vertexBuffer.size !== vdata.byteLength) {
      this.vertexBuffer?.destroy();
      this.vertexBuffer = device.createBuffer({
        label: "mesh vertices",
        size: vdata.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    if (recreate || !this.triBuffer || this.triBuffer.size !== tbuf.byteLength) {
      this.triBuffer?.destroy();
      this.triBuffer = device.createBuffer({
        label: "mesh triangles",
        size: tbuf.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    device.queue.writeBuffer(this.vertexBuffer, 0, vdata);
    device.queue.writeBuffer(this.triBuffer, 0, tbuf);

    if (recreate || !this.vertTriStartBuffer) {
      this.vertTriStartBuffer?.destroy();
      this.vertTrisBuffer?.destroy();
      const mk = (label: string, data: Uint32Array) => {
        const b = device.createBuffer({
          label,
          size: Math.max(4, data.byteLength),
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(b, 0, data);
        return b;
      };
      this.vertTriStartBuffer = mk("vertTriStart", mesh.vertTriStart);
      this.vertTrisBuffer = mk("vertTris", mesh.vertTris);
    }
    if (this.withPN && (recreate || !this.neighbours)) {
      this.neighbours = triNeighbours(mesh);
    }
    const pnData = this.withPN ? this.buildPN(mesh, this.neighbours!) : new Float32Array(4);
    if (recreate || !this.pnBuffer || this.pnBuffer.size !== pnData.byteLength) {
      this.pnBuffer?.destroy();
      this.pnBuffer = device.createBuffer({
        label: "pn patches",
        size: pnData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    device.queue.writeBuffer(this.pnBuffer, 0, pnData);

    this.triCount = nt;
    this.vertCount = nv;
    this.uploadCount++;
  }
}
