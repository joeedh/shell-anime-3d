import { getGPU } from "../gpu/device";
import { MeshBuffers } from "../gpu/meshbuffers";
import { PaintGPU } from "../paint/paint_gpu";
import type { Scene } from "../core/scene";
import commonWGSL from "./shaders/common.wgsl";
import baseWGSL from "./shaders/base.wgsl";

/** Bytes in the Camera uniform struct (common.wgsl). */
const CAMERA_UNIFORM_SIZE = 336;
export const DEPTH_FORMAT: GPUTextureFormat = "depth32float";

/** Per-canvas render targets, recreated when the canvas size changes. */
interface Targets {
  width: number;
  height: number;
  depth: GPUTexture;
}

/** Draws a scene into a viewport's canvas. */
export class Renderer {
  meshBuffers = new MeshBuffers();
  paint = new PaintGPU();
  /** Set when painted widths changed; the next draw recomputes wmax for every vertex. */
  wmaxDirty = true;
  private wmaxUpload = -1;
  private sampler: GPUSampler | undefined;
  private cameraBuffer: GPUBuffer | undefined;
  private layout: GPUBindGroupLayout | undefined;
  private basePipeline: GPURenderPipeline | undefined;
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
      fragment: { module, entryPoint: "fsBase", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
    });
  }

  private getTargets(ctx: GPUCanvasContext, width: number, height: number): Targets {
    let t = this.targets.get(ctx);
    if (t && t.width === width && t.height === height) {
      return t;
    }
    t?.depth.destroy();
    const { device } = getGPU();
    t = {
      width,
      height,
      depth: device.createTexture({
        label: "base depth",
        size: [width, height],
        format: DEPTH_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }),
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
    const key = [mb.vertexBuffer, mb.triBuffer, this.paint.texture];
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
      ],
    });
    this.bindGroupKey = key;
    return this.bindGroup;
  }

  /** Brings GPU copies of the mesh and maps up to date; also used by tools before a stroke. */
  syncScene(scene: Scene) {
    this.paint.sync(scene.maps);
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

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: ctx.getCurrentTexture().createView(),
          clearValue: { r: 0.72, g: 0.74, b: 0.78, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
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
    pass.end();

    device.queue.submit([encoder.finish()]);
  }
}
