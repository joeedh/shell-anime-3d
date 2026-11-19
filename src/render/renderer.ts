import { getGPU } from "../gpu/device";
import { MeshBuffers } from "../gpu/meshbuffers";
import { PaintGPU } from "../paint/paint_gpu";
import type { Scene } from "../core/scene";
import commonWGSL from "./shaders/common.wgsl";
import baseWGSL from "./shaders/base.wgsl";
import shellWGSL from "./shaders/shell.wgsl";
import pnWGSL from "./shaders/pn.wgsl";
import { computeCurvature, updateCurvature } from "../mesh/curvature";
import type { CurvatureField } from "../mesh/curvature";
import type { Mesh } from "../mesh/mesh";
import { CompareMode, ReferencePass } from "./reference/reference";

/** Bytes in the Camera uniform struct (common.wgsl). */
const CAMERA_UNIFORM_SIZE = 336;
export const DEPTH_FORMAT: GPUTextureFormat = "depth32float";
/** The shell pass marks its line pixels here for the compare pass. */
const MASK_FORMAT: GPUTextureFormat = "r8unorm";

/** Per-canvas render targets, recreated when the canvas size changes. */
interface Targets {
  width: number;
  height: number;
  depth: GPUTexture;
  mask: GPUTexture;
  refBase: GPUTexture;
  refExit: GPUTexture;
}

/** Draws a scene into a viewport's canvas. */
export class Renderer {
  meshBuffers = new MeshBuffers();
  paint = new PaintGPU();
  reference = new ReferencePass();
  /** Submit-to-completion time of the last measured frame (rough; includes queue latency). */
  gpuMs = 0;
  private timing = false;
  /** Set when painted widths changed; the next draw recomputes wmax for every vertex. */
  wmaxDirty = true;
  private wmaxUpload = -1;
  private sampler: GPUSampler | undefined;
  private cameraBuffer: GPUBuffer | undefined;
  private layout: GPUBindGroupLayout | undefined;
  private basePipeline: GPURenderPipeline | undefined;
  private shellPipeline: GPURenderPipeline | undefined;
  curvature: CurvatureField | undefined;
  private curvatureKey: [Mesh?, number?] = [];
  private bindGroup: GPUBindGroup | undefined;
  private bindGroupKey: unknown[] = [];
  private targets = new WeakMap<GPUCanvasContext, Targets>();

  private init() {
    if (this.basePipeline) return;
    const { device, format } = getGPU();

    this.cameraBuffer = device.createBuffer({
      label: "camera",
      size: CAMERA_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const vis = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
    this.layout = device.createBindGroupLayout({
      label: "mesh",
      entries: [
        { binding: 0, visibility: vis, buffer: { type: "uniform" } },
        { binding: 1, visibility: vis, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: vis, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: vis, texture: { sampleType: "float" } },
        { binding: 4, visibility: vis, sampler: { type: "filtering" } },
        { binding: 5, visibility: vis, buffer: { type: "read-only-storage" } },
      ],
    });
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    const module = device.createShaderModule({ label: "base", code: commonWGSL + baseWGSL });
    this.basePipeline = device.createRenderPipeline({
      label: "base",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: "vsBase" },
      fragment: {
        module,
        entryPoint: "fsBase",
        targets: [{ format }, { format: MASK_FORMAT, writeMask: 0 }],
      },
      primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
    });

    const shellModule = device.createShaderModule({ label: "shell", code: commonWGSL + pnWGSL + shellWGSL });
    this.shellPipeline = device.createRenderPipeline({
      label: "shell",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module: shellModule, entryPoint: "vsShell" },
      fragment: {
        module: shellModule,
        entryPoint: "fsShell",
        targets: [{ format }, { format: MASK_FORMAT }],
      },
      // inverted hull: draw the back faces of the extruded shell
      primitive: { topology: "triangle-list", cullMode: "front", frontFace: "ccw" },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
    });

    this.reference.init(this.layout, this.sampler, this.cameraBuffer, format);
  }

  private getTargets(ctx: GPUCanvasContext, width: number, height: number): Targets {
    let t = this.targets.get(ctx);
    if (t && t.width === width && t.height === height) {
      return t;
    }
    if (t) {
      for (const tex of [t.depth, t.mask, t.refBase, t.refExit]) tex.destroy();
    }
    const { device } = getGPU();
    const tex = (label: string, format: GPUTextureFormat) =>
      device.createTexture({
        label,
        size: [width, height],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    t = {
      width,
      height,
      depth: tex("base depth", DEPTH_FORMAT),
      mask: tex("model mask", MASK_FORMAT),
      refBase: tex("reference base depth", DEPTH_FORMAT),
      refExit: tex("reference exit depth", DEPTH_FORMAT),
    };
    this.targets.set(ctx, t);
    return t;
  }

  private writeCamera(scene: Scene, width: number, height: number) {
    const { device } = getGPU();
    const cam = scene.camera;
    const m = cam.matrices(width / height);
    const data = new Float32Array(CAMERA_UNIFORM_SIZE / 4);
    data.set(m.view, 0);
    data.set(m.proj, 16);
    data.set(m.viewProj, 32);
    data.set(m.invViewProj, 48);
    data.set(cam.eye(), 64);
    data[67] = cam.ortho ? 1 : 0;
    data[68] = width;
    data[69] = height;
    data[70] = scene.settings.refHeight;
    data[71] = cam.pixelScale(scene.settings.refHeight);
    data.set(scene.frontAxis, 72);
    data[75] = scene.settings.clipModel;
    data.set(scene.settings.lineColor, 76);
    data[79] = scene.settings.showWireframe ? 1 : 0;
    data[80] = scene.settings.overlay;
    device.queue.writeBuffer(this.cameraBuffer!, 0, data);
  }

  private getBindGroup() {
    const mb = this.meshBuffers;
    const key = [mb.vertexBuffer, mb.triBuffer, this.paint.texture, mb.pnBuffer];
    if (this.bindGroup && key.every((k, i) => k === this.bindGroupKey[i])) {
      return this.bindGroup;
    }
    const { device } = getGPU();
    this.bindGroup = device.createBindGroup({
      layout: this.layout!,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer! } },
        { binding: 1, resource: { buffer: mb.vertexBuffer! } },
        { binding: 2, resource: { buffer: mb.triBuffer! } },
        { binding: 3, resource: this.paint.texture!.createView() },
        { binding: 4, resource: this.sampler! },
        { binding: 5, resource: { buffer: mb.pnBuffer! } },
      ],
    });
    this.bindGroupKey = key;
    return this.bindGroup;
  }

  /** Incremental curvature after a sculpt dab; anything else falls back to a full recompute. */
  geometryEdited(mesh: Mesh, verts: Iterable<number>, prevVersion: number) {
    if (this.curvature && this.curvatureKey[0] === mesh && this.curvatureKey[1] === prevVersion) {
      updateCurvature(mesh, this.curvature, verts);
      this.curvatureKey = [mesh, mesh.geomVersion];
      this.meshBuffers.curvatureH = this.curvature.H;
    }
  }

  /** Brings GPU copies of the mesh and maps up to date; also used by tools before a stroke. */
  syncScene(scene: Scene) {
    this.paint.sync(scene.maps);
    const mesh = scene.mesh;
    if (this.curvatureKey[0] !== mesh || this.curvatureKey[1] !== mesh.geomVersion) {
      this.curvature = computeCurvature(mesh, this.curvature);
      this.meshBuffers.curvatureH = this.curvature.H;
      this.meshBuffers.invalidate();
      this.curvatureKey = [mesh, mesh.geomVersion];
    }
    this.meshBuffers.sync(scene.mesh);
    this.paint.syncUVs(scene.mesh);
    if (this.wmaxDirty || this.wmaxUpload !== this.meshBuffers.uploadCount) {
      this.paint.computeWmax(this.meshBuffers);
      this.wmaxDirty = false;
      this.wmaxUpload = this.meshBuffers.uploadCount;
    }
  }

  draw(ctx: GPUCanvasContext, scene: Scene, width: number, height: number) {
    this.init();
    const { device } = getGPU();
    const targets = this.getTargets(ctx, width, height);

    this.syncScene(scene);
    this.writeCamera(scene, width, height);

    const settings = scene.settings;
    const mode = settings.showCompare
      ? CompareMode.COMPARE
      : settings.showReference
        ? CompareMode.REFERENCE
        : CompareMode.OFF;
    if (mode !== CompareMode.OFF) {
      this.reference.sync(scene.mesh);
    }

    const encoder = device.createCommandEncoder();
    const colorView = ctx.getCurrentTexture().createView();
    const maskView = targets.mask.createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: colorView,
          clearValue: { r: 0.72, g: 0.74, b: 0.78, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
        { view: maskView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" },
      ],
      depthStencilAttachment: {
        view: targets.depth.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.setPipeline(this.basePipeline!);
    pass.setBindGroup(0, this.getBindGroup());
    pass.draw(this.meshBuffers.triCount * 3);
    pass.setPipeline(this.shellPipeline!);
    pass.draw(this.meshBuffers.triCount * 3);
    pass.end();

    let readback = false;
    if (mode !== CompareMode.OFF) {
      readback = this.reference.encode({
        encoder,
        color: colorView,
        mask: maskView,
        refBase: targets.refBase.createView(),
        refExit: targets.refExit.createView(),
        refBaseTexture: targets.refBase,
        mapsTexture: this.paint.texture!,
        mode,
      });
    }

    device.queue.submit([encoder.finish()]);
    if (!this.timing) {
      this.timing = true;
      const t0 = performance.now();
      device.queue.onSubmittedWorkDone().then(() => {
        this.gpuMs = performance.now() - t0;
        this.timing = false;
      });
    }
    if (readback) {
      this.reference.startReadback();
    }
  }
}
