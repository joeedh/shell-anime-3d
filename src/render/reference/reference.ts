import { getGPU } from "../../gpu/device";
import { MeshBuffers } from "../../gpu/meshbuffers";
import type { Mesh } from "../../mesh/mesh";
import { buildReferenceMesh } from "./refmesh";
import type { ReferenceMesh } from "./refmesh";
import commonWGSL from "../shaders/common.wgsl";
import refCommonWGSL from "../shaders/ref_common.wgsl";
import refBuildWGSL from "../shaders/ref_build.wgsl";
import refDrawWGSL from "../shaders/ref_draw.wgsl";
import compareWGSL from "../shaders/compare.wgsl";

export const CompareMode = { OFF: 0, REFERENCE: 1, COMPARE: 2 } as const;
export type CompareMode = (typeof CompareMode)[keyof typeof CompareMode];

/** Overflow bits in `CompareStats.overflow` (ref_common.wgsl). */
export const RefOverflow = { SAMPLES: 1, DRAWS: 2, GRID: 4 } as const;

export interface CompareStats {
  both: number;
  refOnly: number;
  modelOnly: number;
  samples: number;
  draws: number;
  overflow: number;
  levels: number;
}

/** What the renderer hands the reference pass each frame. */
export interface ReferenceFrame {
  encoder: GPUCommandEncoder;
  color: GPUTextureView;
  mask: GPUTextureView;
  refBase: GPUTextureView;
  refExit: GPUTextureView;
  /** The texture behind `refBase`, to know when the impostor bind group is stale. */
  refBaseTexture: GPUTexture;
  mapsTexture: GPUTexture;
  mode: CompareMode;
}

const SAMPLE_CAP = 1 << 21;
const DRAW_CAP = 1 << 21;
const HASH_SIZE = 1 << 21;
const MAX_GRID = 48;
/** |n.v| margins of the impostor band and the wider containment band. */
const DRAW_MARGIN = 0.05;
const HASH_MARGIN = 0.05;
/** Balls may face this far toward the eye (in n.v) and still get an impostor. */
const FACING_SLACK = 0.02;
const DEPTH: GPUTextureFormat = "depth32float";

/**
 * Ground-truth reference (milestone 7): a butterfly-refined copy of the mesh, ball samples
 * near its contour, impostors that keep only uncontained far points, and a compare pass.
 */
export class ReferencePass {
  readonly buffers = new MeshBuffers(false);
  ref: ReferenceMesh | undefined;
  stats: CompareStats | undefined;
  onStats: ((s: CompareStats) => void) | undefined;
  /** While set (during a sculpt stroke), the refined mesh is not rebuilt. */
  frozen = false;
  /** Debug switches in RefParams.pad: 1 = skip the dimple test, 2 = skip containment. */
  debugFlags = 0;
  private key: [Mesh?, number?] = [];

  private meshLayout!: GPUBindGroupLayout;
  private sampler!: GPUSampler;
  private cameraBuffer!: GPUBuffer;
  private params!: GPUBuffer;
  private ctl!: GPUBuffer;
  private triState: GPUBuffer | undefined;
  private samples!: GPUBuffer;
  private hash!: GPUBuffer;
  private drawList!: GPUBuffer;
  private counts!: GPUBuffer;
  private compareParams!: GPUBuffer;
  private readback!: GPUBuffer;
  private readbackBusy = false;

  private buildLayout!: GPUBindGroupLayout;
  private drawLayout!: GPUBindGroupLayout;
  private compareLayout!: GPUBindGroupLayout;
  private classifyPipe!: GPUComputePipeline;
  private emitPipe!: GPUComputePipeline;
  private argsPipe!: GPUComputePipeline;
  private impostorPipe!: GPURenderPipeline;
  private refBasePipe!: GPURenderPipeline;
  private comparePipe!: GPURenderPipeline;

  private meshGroup: GPUBindGroup | undefined;
  private meshGroupKey: unknown[] = [];
  private buildGroup: GPUBindGroup | undefined;
  private drawGroup: GPUBindGroup | undefined;
  private drawGroupKey: GPUTexture | undefined;

  init(
    meshLayout: GPUBindGroupLayout,
    sampler: GPUSampler,
    cameraBuffer: GPUBuffer,
    format: GPUTextureFormat,
  ) {
    if (this.params) return;
    const { device } = getGPU();
    this.meshLayout = meshLayout;
    this.sampler = sampler;
    this.cameraBuffer = cameraBuffer;

    const buf = (label: string, size: number, usage: number) => device.createBuffer({ label, size, usage });
    const S = GPUBufferUsage.STORAGE;
    this.params = buf("ref params", 48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.ctl = buf(
      "ref ctl",
      32,
      S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    );
    this.samples = buf("ref samples", SAMPLE_CAP * 16, S | GPUBufferUsage.COPY_SRC);
    this.hash = buf("ref hash", (HASH_SIZE + SAMPLE_CAP) * 4, S | GPUBufferUsage.COPY_DST);
    this.drawList = buf("ref draw list", DRAW_CAP * 4, S | GPUBufferUsage.COPY_SRC);
    this.counts = buf("compare counts", 16, S | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    this.compareParams = buf("compare params", 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.readback = buf("compare readback", 48, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);

    const C = GPUShaderStage.COMPUTE,
      V = GPUShaderStage.VERTEX,
      F = GPUShaderStage.FRAGMENT;
    const storage = (binding: number, visibility: number, type: GPUBufferBindingType) => ({
      binding,
      visibility,
      buffer: { type },
    });
    this.buildLayout = device.createBindGroupLayout({
      label: "ref build",
      entries: [
        { binding: 0, visibility: C, buffer: { type: "uniform" } },
        storage(1, C, "storage"),
        storage(2, C, "storage"),
        storage(3, C, "storage"),
        storage(4, C, "storage"),
        storage(5, C, "storage"),
      ],
    });
    this.drawLayout = device.createBindGroupLayout({
      label: "ref draw",
      entries: [
        { binding: 0, visibility: V | F, buffer: { type: "uniform" } },
        storage(1, F, "read-only-storage"),
        storage(3, V | F, "read-only-storage"),
        storage(4, F, "read-only-storage"),
        storage(5, V, "read-only-storage"),
        { binding: 6, visibility: F, texture: { sampleType: "depth" } },
      ],
    });
    this.compareLayout = device.createBindGroupLayout({
      label: "compare",
      entries: [
        { binding: 0, visibility: F, buffer: { type: "uniform" } },
        { binding: 1, visibility: F, texture: { sampleType: "float" } },
        { binding: 2, visibility: F, texture: { sampleType: "depth" } },
        { binding: 3, visibility: F, texture: { sampleType: "depth" } },
        storage(4, F, "storage"),
      ],
    });

    const buildModule = device.createShaderModule({
      label: "ref build",
      code: commonWGSL + refCommonWGSL + refBuildWGSL,
    });
    const buildPL = device.createPipelineLayout({ bindGroupLayouts: [meshLayout, this.buildLayout] });
    const compute = (entryPoint: string) =>
      device.createComputePipeline({
        label: entryPoint,
        layout: buildPL,
        compute: { module: buildModule, entryPoint },
      });
    this.classifyPipe = compute("csClassify");
    this.emitPipe = compute("csEmit");
    this.argsPipe = compute("csArgs");

    const drawModule = device.createShaderModule({
      label: "ref draw",
      code: commonWGSL + refCommonWGSL + refDrawWGSL,
    });
    this.impostorPipe = device.createRenderPipeline({
      label: "ref impostors",
      layout: device.createPipelineLayout({ bindGroupLayouts: [meshLayout, this.drawLayout] }),
      vertex: { module: drawModule, entryPoint: "vsImpostor" },
      fragment: { module: drawModule, entryPoint: "fsImpostor", targets: [] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: "less" },
    });
    this.refBasePipe = device.createRenderPipeline({
      label: "ref base depth",
      layout: device.createPipelineLayout({ bindGroupLayouts: [meshLayout] }),
      vertex: { module: drawModule, entryPoint: "vsRefBase" },
      primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
      depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: "less" },
    });

    const compareModule = device.createShaderModule({ label: "compare", code: compareWGSL });
    this.comparePipe = device.createRenderPipeline({
      label: "compare",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.compareLayout] }),
      vertex: { module: compareModule, entryPoint: "vsFull" },
      fragment: {
        module: compareModule,
        entryPoint: "fsCompare",
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });

    this.buildGroup = device.createBindGroup({
      layout: this.buildLayout,
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: { buffer: this.ctl } },
        { binding: 2, resource: { buffer: this.placeholderTriState() } },
        { binding: 3, resource: { buffer: this.samples } },
        { binding: 4, resource: { buffer: this.hash } },
        { binding: 5, resource: { buffer: this.drawList } },
      ],
    });
  }

  private placeholderTriState() {
    this.triState ??= getGPU().device.createBuffer({
      label: "ref tri state",
      size: 16,
      usage: GPUBufferUsage.STORAGE,
    });
    return this.triState;
  }

  /** Rebuilds the refined mesh when the source geometry changed. */
  sync(mesh: Mesh) {
    if (this.key[0] === mesh && this.key[1] === mesh.geomVersion) return;
    if (this.frozen && this.ref) return;
    this.key = [mesh, mesh.geomVersion];
    this.ref = buildReferenceMesh(mesh);
    this.buffers.extra = this.ref.kmax;
    this.buffers.invalidate();
    this.buffers.sync(this.ref.mesh);

    const { device } = getGPU();
    const size = Math.max(1, this.buffers.triCount) * 16;
    if (!this.triState || this.triState.size < size) {
      this.triState?.destroy();
      this.triState = device.createBuffer({ label: "ref tri state", size, usage: GPUBufferUsage.STORAGE });
      this.buildGroup = device.createBindGroup({
        layout: this.buildLayout,
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: this.ctl } },
          { binding: 2, resource: { buffer: this.triState } },
          { binding: 3, resource: { buffer: this.samples } },
          { binding: 4, resource: { buffer: this.hash } },
          { binding: 5, resource: { buffer: this.drawList } },
        ],
      });
    }
  }

  private getMeshGroup(maps: GPUTexture) {
    const mb = this.buffers;
    const key = [mb.vertexBuffer, mb.triBuffer, mb.pnBuffer, mb.ringBuffer, maps];
    if (this.meshGroup && key.every((k, i) => k === this.meshGroupKey[i])) return this.meshGroup;
    this.meshGroup = getGPU().device.createBindGroup({
      layout: this.meshLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: mb.vertexBuffer! } },
        { binding: 2, resource: { buffer: mb.triBuffer! } },
        { binding: 3, resource: maps.createView() },
        { binding: 4, resource: this.sampler },
        { binding: 5, resource: { buffer: mb.pnBuffer! } },
        { binding: 6, resource: { buffer: mb.ringBuffer! } },
      ],
    });
    this.meshGroupKey = key;
    return this.meshGroup;
  }

  private getDrawGroup(f: ReferenceFrame) {
    if (this.drawGroup && this.drawGroupKey === f.refBaseTexture) return this.drawGroup;
    this.drawGroup = getGPU().device.createBindGroup({
      layout: this.drawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: { buffer: this.ctl } },
        { binding: 3, resource: { buffer: this.samples } },
        { binding: 4, resource: { buffer: this.hash } },
        { binding: 5, resource: { buffer: this.drawList } },
        { binding: 6, resource: f.refBase },
      ],
    });
    this.drawGroupKey = f.refBaseTexture;
    return this.drawGroup;
  }

  /** Records the reference build, its depth passes and the compare pass. */
  encode(f: ReferenceFrame) {
    const { device } = getGPU();
    const nt = this.buffers.triCount;
    const params = new ArrayBuffer(48);
    const pu = new Uint32Array(params);
    const pf = new Float32Array(params);
    pu[0] = nt;
    pu[1] = SAMPLE_CAP;
    pu[2] = DRAW_CAP;
    pu[3] = HASH_SIZE - 1;
    pf[4] = DRAW_MARGIN;
    pf[5] = HASH_MARGIN;
    pu[6] = MAX_GRID;
    pu[7] = this.debugFlags;
    pf[8] = FACING_SLACK;
    device.queue.writeBuffer(this.params, 0, params);
    device.queue.writeBuffer(this.compareParams, 0, new Uint32Array([f.mode, 0, 0, 0]));

    const enc = f.encoder;
    enc.clearBuffer(this.ctl);
    enc.clearBuffer(this.hash, 0, HASH_SIZE * 4);
    enc.clearBuffer(this.counts);
    const meshGroup = this.getMeshGroup(f.mapsTexture);

    const cp = enc.beginComputePass({ label: "ref build" });
    cp.setBindGroup(0, meshGroup);
    cp.setBindGroup(1, this.buildGroup!);
    const groups = Math.ceil(nt / 64);
    cp.setPipeline(this.classifyPipe);
    cp.dispatchWorkgroups(groups);
    cp.setPipeline(this.emitPipe);
    cp.dispatchWorkgroups(groups);
    cp.setPipeline(this.argsPipe);
    cp.dispatchWorkgroups(1);
    cp.end();

    const depthPass = (view: GPUTextureView, label: string) =>
      enc.beginRenderPass({
        label,
        colorAttachments: [],
        depthStencilAttachment: { view, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
      });
    let rp = depthPass(f.refBase, "ref base");
    rp.setPipeline(this.refBasePipe);
    rp.setBindGroup(0, meshGroup);
    rp.draw(nt * 3);
    rp.end();

    rp = depthPass(f.refExit, "ref impostors");
    rp.setPipeline(this.impostorPipe);
    rp.setBindGroup(0, meshGroup);
    rp.setBindGroup(1, this.getDrawGroup(f));
    rp.drawIndirect(this.ctl, 16);
    rp.end();

    const compareGroup = device.createBindGroup({
      layout: this.compareLayout,
      entries: [
        { binding: 0, resource: { buffer: this.compareParams } },
        { binding: 1, resource: f.mask },
        { binding: 2, resource: f.refBase },
        { binding: 3, resource: f.refExit },
        { binding: 4, resource: { buffer: this.counts } },
      ],
    });
    rp = enc.beginRenderPass({
      label: "compare",
      colorAttachments: [{ view: f.color, loadOp: "load", storeOp: "store" }],
    });
    rp.setPipeline(this.comparePipe);
    rp.setBindGroup(0, compareGroup);
    rp.draw(3);
    rp.end();

    const readNow = !this.readbackBusy;
    if (readNow) {
      enc.copyBufferToBuffer(this.counts, 0, this.readback, 0, 16);
      enc.copyBufferToBuffer(this.ctl, 0, this.readback, 16, 32);
    }
    return readNow;
  }

  /** Debug: copies the current ball samples and draw list back to the CPU. */
  async debugRead() {
    const { device } = getGPU();
    const n = this.stats?.samples ?? 0;
    const nd = this.stats?.draws ?? 0;
    const sb = device.createBuffer({
      size: Math.max(16, n * 16),
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const db = device.createBuffer({
      size: Math.max(16, nd * 4),
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const enc = device.createCommandEncoder();
    if (n) enc.copyBufferToBuffer(this.samples, 0, sb, 0, n * 16);
    if (nd) enc.copyBufferToBuffer(this.drawList, 0, db, 0, nd * 4);
    device.queue.submit([enc.finish()]);
    await Promise.all([sb.mapAsync(GPUMapMode.READ), db.mapAsync(GPUMapMode.READ)]);
    const out = {
      samples: new Float32Array(sb.getMappedRange().slice(0)),
      drawList: new Uint32Array(db.getMappedRange().slice(0)),
    };
    sb.destroy();
    db.destroy();
    return out;
  }

  /** Call after the frame's submit when `encode` returned true. */
  startReadback() {
    this.readbackBusy = true;
    const levels = this.ref?.levels ?? 0;
    this.readback.mapAsync(GPUMapMode.READ).then(
      () => {
        const u = new Uint32Array(this.readback.getMappedRange().slice(0));
        this.readback.unmap();
        this.readbackBusy = false;
        this.stats = {
          both: u[0],
          refOnly: u[1],
          modelOnly: u[2],
          samples: u[4],
          draws: u[6],
          overflow: u[7],
          levels,
        };
        this.onStats?.(this.stats);
      },
      () => {
        this.readbackBusy = false;
      },
    );
  }
}
