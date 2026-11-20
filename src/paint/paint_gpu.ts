import { getGPU } from "../gpu/device";
import type { MeshBuffers } from "../gpu/meshbuffers";
import type { Mesh } from "../mesh/mesh";
import { buildDilationMap, GUTTER_TEXELS } from "./gutter";
import type { PaintMaps } from "./paintmaps";
import { BrushMode } from "./brush";
import paintWGSL from "./shaders/paint.wgsl";
import wmaxWGSL from "../render/shaders/wmax.wgsl";

export const TILE = 64;
const TEXEL_BYTES = 8;
const FORMAT: GPUTextureFormat = "rgba16float";
const DAB_UNIFORM_SIZE = 48;
/** Largest blur radius of the smooth brush, in texels (paint.wgsl `smoothSample`). */
const SMOOTH_MAX_TEXELS = 16;

/** Downloaded stroke tiles: the state before the stroke and after it, per tile. */
export interface TileSet {
  tiles: number[];
  before: Uint16Array[];
  after: Uint16Array[];
}

export interface DabParams {
  center: ArrayLike<number>;
  radius: number;
  value: number;
  strength: number;
  hardness: number;
  mode: BrushMode;
  channel: number;
  /** Texel rectangle the dab can touch: x0, y0, x1, y1 (exclusive); scissors the passes. */
  rect: [number, number, number, number];
  /** Tiles to save for undo; must cover every texel the dab or gutter fill can write. */
  tiles: number[];
}

/**
 * GPU side of the painted maps: the texture strokes write into, the dab and gutter-fill
 * pipelines, per-stroke tile undo, and the per-vertex conservative width (wmax) pass.
 */
export class PaintGPU {
  texture: GPUTexture | undefined;
  private size = 0;
  private maps: PaintMaps | undefined;
  private mapsVersion = -1;
  private scratch: GPUTexture | undefined;
  private dilateBuffer: GPUBuffer | undefined;
  private dilateKey: [Mesh?, number?] = [];
  private dabUniform: GPUBuffer | undefined;
  private dabLayout: GPUBindGroupLayout | undefined;
  private dabPipelines = new Map<string, GPURenderPipeline>();
  private wmaxPipeline: GPUComputePipeline | undefined;
  private wmaxLayout: GPUBindGroupLayout | undefined;

  // per-stroke tile undo
  private atlas: GPUTexture | undefined;
  private atlasSlots = new Map<number, number>();
  private atlasCapacity = 0;

  get tilesPerRow() {
    return Math.ceil(this.size / TILE);
  }

  /** Uploads the CPU mirror if it was replaced (load, unwrap, undo of those). */
  sync(maps: PaintMaps) {
    const { device } = getGPU();
    if (maps === this.maps && maps.version === this.mapsVersion) return;

    if (!this.texture || this.size !== maps.size) {
      this.texture?.destroy();
      this.scratch?.destroy();
      this.size = maps.size;
      const usage =
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST;
      this.texture = device.createTexture({
        label: "paint maps",
        size: [maps.size, maps.size],
        format: FORMAT,
        usage,
      });
      this.scratch = device.createTexture({
        label: "paint scratch",
        size: [maps.size, maps.size],
        format: FORMAT,
        usage,
      });
    }
    device.queue.writeTexture(
      { texture: this.texture },
      maps.data,
      { bytesPerRow: maps.size * TEXEL_BYTES },
      [maps.size, maps.size],
    );
    this.maps = maps;
    this.mapsVersion = maps.version;
  }

  /** Rebuilds the gutter source map when the mesh's UVs change. */
  syncUVs(mesh: Mesh) {
    if (this.dilateKey[0] === mesh && this.dilateKey[1] === mesh.uvVersion && this.dilateBuffer) return;
    const { device } = getGPU();
    const map = buildDilationMap(mesh, this.size);
    this.dilateBuffer?.destroy();
    this.dilateBuffer = device.createBuffer({
      label: "dilation map",
      size: map.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.dilateBuffer, 0, map);
    this.dilateKey = [mesh, mesh.uvVersion];
  }

  private initPipelines() {
    if (this.dabLayout) return;
    const { device } = getGPU();
    this.dabUniform = device.createBuffer({
      size: DAB_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const F = GPUShaderStage.FRAGMENT,
      V = GPUShaderStage.VERTEX;
    this.dabLayout = device.createBindGroupLayout({
      label: "dab",
      entries: [
        { binding: 0, visibility: V | F, buffer: { type: "uniform" } },
        { binding: 1, visibility: V, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: V, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: F, texture: { sampleType: "unfilterable-float" } },
        { binding: 4, visibility: F, buffer: { type: "read-only-storage" } },
      ],
    });

    const C = GPUShaderStage.COMPUTE;
    this.wmaxLayout = device.createBindGroupLayout({
      label: "wmax",
      entries: [
        { binding: 0, visibility: C, buffer: { type: "uniform" } },
        { binding: 1, visibility: C, buffer: { type: "storage" } },
        { binding: 2, visibility: C, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: C, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: C, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility: C, buffer: { type: "read-only-storage" } },
        { binding: 6, visibility: C, texture: { sampleType: "unfilterable-float" } },
      ],
    });
    this.wmaxPipeline = device.createComputePipeline({
      label: "wmax",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.wmaxLayout] }),
      compute: { module: device.createShaderModule({ label: "wmax", code: wmaxWGSL }), entryPoint: "csWmax" },
    });
  }

  /** Dab pipelines differ by blend mode and channel write mask; built on first use. */
  private dabPipeline(mode: BrushMode | "dilate", channel: number) {
    const key = `${mode}:${channel}`;
    let p = this.dabPipelines.get(key);
    if (p) return p;
    const { device } = getGPU();
    const module = device.createShaderModule({ label: "paint", code: paintWGSL });

    const over: GPUBlendState = {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
    };
    const add: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one", operation: "add" },
      alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
    };
    const dilate = mode === "dilate";
    p = device.createRenderPipeline({
      label: `paint ${key}`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.dabLayout!] }),
      vertex: { module, entryPoint: dilate ? "vsFull" : "vsDab" },
      fragment: {
        module,
        entryPoint: dilate ? "fsDilate" : "fsDab",
        targets: [
          {
            format: FORMAT,
            blend: dilate ? undefined : mode === BrushMode.ADD ? add : over,
            writeMask: dilate
              ? GPUColorWrite.ALL
              : [GPUColorWrite.RED, GPUColorWrite.GREEN, GPUColorWrite.BLUE][channel],
          },
        ],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
    this.dabPipelines.set(key, p);
    return p;
  }

  private copyRect(
    src: GPUTexture,
    dst: GPUTexture,
    rect: [number, number, number, number],
    encoder: GPUCommandEncoder,
  ) {
    const [x0, y0, x1, y1] = rect;
    if (x1 <= x0 || y1 <= y0) return;
    encoder.copyTextureToTexture({ texture: src, origin: [x0, y0] }, { texture: dst, origin: [x0, y0] }, [
      x1 - x0,
      y1 - y0,
    ]);
  }

  // ---- strokes ----

  beginStroke() {
    this.atlasSlots.clear();
  }

  /** Tiles overlapping a texel rectangle. */
  tilesForRect(rect: [number, number, number, number]) {
    const tpr = this.tilesPerRow;
    const out: number[] = [];
    const tx0 = Math.floor(rect[0] / TILE),
      ty0 = Math.floor(rect[1] / TILE);
    const tx1 = Math.ceil(rect[2] / TILE),
      ty1 = Math.ceil(rect[3] / TILE);
    for (let ty = ty0; ty < ty1; ty++) {
      for (let tx = tx0; tx < tx1; tx++) out.push(ty * tpr + tx);
    }
    return out;
  }

  private tileOrigin(tile: number): [number, number] {
    const tpr = this.tilesPerRow;
    return [(tile % tpr) * TILE, Math.floor(tile / tpr) * TILE];
  }

  private atlasOrigin(slot: number): [number, number] {
    return [(slot % 16) * TILE, Math.floor(slot / 16) * TILE];
  }

  /** Grows the before-tile atlas to hold `n` tiles, keeping what it already holds. */
  private ensureAtlas(n: number, encoder: GPUCommandEncoder) {
    if (n <= this.atlasCapacity && this.atlas) return;
    const { device } = getGPU();
    let cap = Math.max(64, this.atlasCapacity);
    while (cap < n) cap *= 2;
    const rows = Math.ceil(cap / 16);
    const atlas = device.createTexture({
      label: "stroke undo atlas",
      size: [16 * TILE, rows * TILE],
      format: FORMAT,
      usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });
    if (this.atlas) {
      const oldRows = Math.ceil(this.atlasCapacity / 16);
      encoder.copyTextureToTexture({ texture: this.atlas }, { texture: atlas }, [16 * TILE, oldRows * TILE]);
      const old = this.atlas;
      device.queue.onSubmittedWorkDone().then(() => old.destroy());
    }
    this.atlas = atlas;
    this.atlasCapacity = cap;
  }

  /** Saves each tile's stroke-start state the first time the stroke touches it. */
  private saveTiles(tiles: number[], encoder: GPUCommandEncoder) {
    const fresh = tiles.filter((t) => !this.atlasSlots.has(t));
    if (!fresh.length) return;
    this.ensureAtlas(this.atlasSlots.size + fresh.length, encoder);
    for (const t of fresh) {
      const slot = this.atlasSlots.size;
      this.atlasSlots.set(t, slot);
      const [x, y] = this.tileOrigin(t);
      const w = Math.min(TILE, this.size - x),
        h = Math.min(TILE, this.size - y);
      encoder.copyTextureToTexture(
        { texture: this.texture!, origin: [x, y] },
        { texture: this.atlas!, origin: this.atlasOrigin(slot) },
        [w, h],
      );
    }
  }

  dab(meshBuffers: MeshBuffers, d: DabParams) {
    this.initPipelines();
    const { device } = getGPU();
    const size = this.size;
    // dilation can write GUTTER_TEXELS beyond any covered texel, so widen the saved area
    const g = GUTTER_TEXELS + 1;
    const rect: [number, number, number, number] = [
      Math.max(0, Math.floor(d.rect[0]) - g),
      Math.max(0, Math.floor(d.rect[1]) - g),
      Math.min(size, Math.ceil(d.rect[2]) + g),
      Math.min(size, Math.ceil(d.rect[3]) + g),
    ];
    if (rect[2] <= rect[0] || rect[3] <= rect[1]) return;

    const u = new Float32Array(DAB_UNIFORM_SIZE / 4);
    u.set([
      d.center[0],
      d.center[1],
      d.center[2],
      d.radius,
      d.value,
      d.strength,
      d.hardness,
      d.mode,
      size,
      SMOOTH_MAX_TEXELS,
    ]);
    device.queue.writeBuffer(this.dabUniform!, 0, u);

    const encoder = device.createCommandEncoder();
    this.saveTiles(d.tiles, encoder);
    if (d.mode === BrushMode.SMOOTH) {
      // the blur reads up to SMOOTH_MAX_TEXELS beyond the dab
      const m = SMOOTH_MAX_TEXELS + 1;
      const wide: [number, number, number, number] = [
        Math.max(0, rect[0] - m),
        Math.max(0, rect[1] - m),
        Math.min(size, rect[2] + m),
        Math.min(size, rect[3] + m),
      ];
      this.copyRect(this.texture!, this.scratch!, wide, encoder);
    }

    const bind = device.createBindGroup({
      layout: this.dabLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.dabUniform! } },
        { binding: 1, resource: { buffer: meshBuffers.vertexBuffer! } },
        { binding: 2, resource: { buffer: meshBuffers.triBuffer! } },
        { binding: 3, resource: this.scratch!.createView() },
        { binding: 4, resource: { buffer: this.dilateBuffer! } },
      ],
    });

    const target = this.texture!.createView();
    let pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: "load", storeOp: "store" }],
    });
    pass.setScissorRect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
    pass.setPipeline(this.dabPipeline(d.mode, d.channel));
    pass.setBindGroup(0, bind);
    pass.draw(meshBuffers.triCount * 3);
    pass.end();

    // gutter fill reads a copy, since a pass can't sample its own target
    this.copyRect(this.texture!, this.scratch!, rect, encoder);
    pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: "load", storeOp: "store" }],
    });
    pass.setScissorRect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
    pass.setPipeline(this.dabPipeline("dilate", 0));
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();

    device.queue.submit([encoder.finish()]);
  }

  /** Tiles the current stroke touched, in the order they were first saved. */
  strokeTiles() {
    return [...this.atlasSlots.keys()];
  }

  /** Downloads before (atlas) and after (texture) tiles, then frees the atlas. */
  async endStroke(): Promise<TileSet> {
    const { device } = getGPU();
    const tiles = this.strokeTiles();
    const tileBytes = TILE * TILE * TEXEL_BYTES;
    const result: TileSet = { tiles, before: [], after: [] };
    if (!tiles.length) return result;

    const buffer = device.createBuffer({
      label: "stroke readback",
      size: tiles.length * 2 * tileBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    tiles.forEach((t, i) => {
      const [x, y] = this.tileOrigin(t);
      const w = Math.min(TILE, this.size - x),
        h = Math.min(TILE, this.size - y);
      const layout = { bytesPerRow: TILE * TEXEL_BYTES, rowsPerImage: TILE };
      encoder.copyTextureToBuffer(
        { texture: this.atlas!, origin: this.atlasOrigin(this.atlasSlots.get(t)!) },
        { buffer, offset: i * 2 * tileBytes, ...layout },
        [w, h],
      );
      encoder.copyTextureToBuffer(
        { texture: this.texture!, origin: [x, y] },
        { buffer, offset: (i * 2 + 1) * tileBytes, ...layout },
        [w, h],
      );
    });
    device.queue.submit([encoder.finish()]);
    this.releaseAtlas();

    await buffer.mapAsync(GPUMapMode.READ);
    const all = new Uint16Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy();

    const halfs = TILE * TILE * 4;
    tiles.forEach((_, i) => {
      result.before.push(all.slice(i * 2 * halfs, (i * 2 + 1) * halfs));
      result.after.push(all.slice((i * 2 + 1) * halfs, (i * 2 + 2) * halfs));
    });
    return result;
  }

  /** Cancels a live stroke: copies the saved tiles straight back from the atlas. */
  cancelStroke() {
    if (!this.atlas) return;
    const { device } = getGPU();
    const encoder = device.createCommandEncoder();
    for (const [t, slot] of this.atlasSlots) {
      const [x, y] = this.tileOrigin(t);
      encoder.copyTextureToTexture(
        { texture: this.atlas, origin: this.atlasOrigin(slot) },
        { texture: this.texture!, origin: [x, y] },
        [Math.min(TILE, this.size - x), Math.min(TILE, this.size - y)],
      );
    }
    device.queue.submit([encoder.finish()]);
    this.releaseAtlas();
  }

  private releaseAtlas() {
    const atlas = this.atlas;
    this.atlas = undefined;
    this.atlasCapacity = 0;
    this.atlasSlots.clear();
    if (atlas) {
      getGPU()
        .device.queue.onSubmittedWorkDone()
        .then(() => atlas.destroy());
    }
  }

  /** Writes downloaded tiles to the texture and the CPU mirror (undo/redo). */
  applyTiles(maps: PaintMaps, tiles: number[], data: Uint16Array[]) {
    const { device } = getGPU();
    tiles.forEach((t, i) => {
      const [x, y] = this.tileOrigin(t);
      const w = Math.min(TILE, this.size - x),
        h = Math.min(TILE, this.size - y);
      device.queue.writeTexture(
        { texture: this.texture!, origin: [x, y] },
        data[i],
        { bytesPerRow: TILE * TEXEL_BYTES, rowsPerImage: TILE },
        [w, h],
      );
      // tile rows are TILE texels apart even when clipped at the edge
      for (let row = 0; row < h; row++) {
        maps.writeBlock(x, y + row, w, 1, data[i].subarray(row * TILE * 4, row * TILE * 4 + w * 4));
      }
    });
  }

  /** Copies stroke results into the CPU mirror without touching the GPU. */
  mirrorTiles(maps: PaintMaps, tiles: number[], data: Uint16Array[]) {
    tiles.forEach((t, i) => {
      const [x, y] = this.tileOrigin(t);
      const w = Math.min(TILE, this.size - x),
        h = Math.min(TILE, this.size - y);
      for (let row = 0; row < h; row++) {
        maps.writeBlock(x, y + row, w, 1, data[i].subarray(row * TILE * 4, row * TILE * 4 + w * 4));
      }
    });
  }

  // ---- conservative width ----

  /** Recomputes wmax in the vertex buffer, for all vertices or just `verts`. */
  computeWmax(mb: MeshBuffers, verts?: Uint32Array) {
    this.initPipelines();
    const { device } = getGPU();
    const count = verts ? verts.length : mb.vertCount;
    if (!count || !mb.vertTriStartBuffer || !this.texture) return;

    const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(params, 0, new Uint32Array([count, verts ? 0 : 1, this.size, 0]));
    const list = device.createBuffer({
      size: Math.max(4, verts?.byteLength ?? 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    if (verts) device.queue.writeBuffer(list, 0, verts);

    const bind = device.createBindGroup({
      layout: this.wmaxLayout!,
      entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: { buffer: mb.vertexBuffer! } },
        { binding: 2, resource: { buffer: mb.triBuffer! } },
        { binding: 3, resource: { buffer: mb.vertTriStartBuffer } },
        { binding: 4, resource: { buffer: mb.vertTrisBuffer! } },
        { binding: 5, resource: { buffer: list } },
        { binding: 6, resource: this.texture.createView() },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.wmaxPipeline!);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    device.queue.submit([encoder.finish()]);
    device.queue.onSubmittedWorkDone().then(() => {
      params.destroy();
      list.destroy();
    });
  }
}
