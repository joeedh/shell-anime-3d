import { UIBase, nstructjs } from "../../pathux";
import { Editor } from "../editor_base";
import { getGPU } from "../../gpu/device";
import { ViewMode, ViewNavigateOp } from "./view_ops";
import type { Camera } from "../../core/camera";
import { invert, transformPoint } from "../../math/mat4";
import { PaintStrokeOp } from "../../paint/paint_ops";
import { ToolMode } from "../../paint/brush";

/**
 * 3D view: a WebGPU canvas behind the area's header.
 * Navigation: middle drag orbits, Shift+middle pans, Ctrl+middle zooms, the wheel zooms.
 * Alt+left drag does the same as middle drag, for touchpads.
 */
export class ViewportEditor extends Editor {
  canvas: HTMLCanvasElement;
  gpuContext: GPUCanvasContext | undefined;
  private lastDpi: number | undefined;

  constructor() {
    super();

    this.minSize = [75, 75];

    this.canvas = document.createElement("canvas");
    this.canvas.style.margin = this.canvas.style.padding = "0px";
    this.canvas.style.position = UIBase.PositionKey;
    this.canvas.style.zIndex = "-2";
    this.canvas.style.pointerEvents = "none";
    this.shadow.appendChild(this.canvas);

    this.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
  }

  sceneCamera(): Camera {
    return _appstate.scene.camera;
  }

  /** World-space ray through a client (CSS pixel) position. */
  rayFromClient(x: number, y: number) {
    const [w, h] = this.size ?? [1, 1];
    const [px, py] = this.pos ?? [0, 0];
    const nx = ((x - px) / w) * 2 - 1;
    const ny = 1 - ((y - py) / h) * 2;
    const inv = invert(this.sceneCamera().matrices(w / h).viewProj);
    const a = transformPoint(inv, [nx, ny, 0]);
    const b = transformPoint(inv, [nx, ny, 1]);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    return { origin: [a[0], a[1], a[2]], dir: [d[0] / l, d[1] / l, d[2] / l] };
  }

  /** World size of one CSS pixel at a world point. */
  worldPerCssPixel(p: ArrayLike<number>) {
    const cam = this.sceneCamera();
    const h = this.size?.[1] ?? 1;
    if (cam.ortho) {
      return (2 * cam.halfHeightAtTarget()) / h;
    }
    const e = cam.eye();
    const f = [cam.target[0] - e[0], cam.target[1] - e[1], cam.target[2] - e[2]];
    const fl = Math.hypot(f[0], f[1], f[2]) || 1;
    const depth = ((p[0] - e[0]) * f[0] + (p[1] - e[1]) * f[1] + (p[2] - e[2]) * f[2]) / fl;
    return (2 * depth * Math.tan((cam.fovy * Math.PI) / 360)) / h;
  }

  /** True if the event landed on the canvas rather than on the header or a widget. */
  private isCanvasEvent(e: MouseEvent) {
    const screen = this.ctx?.screen;
    if (!screen) return false;
    const ele = screen.pickElement(e.x, e.y);
    return ele === this || (ele as unknown) === this.canvas;
  }

  private onPointerDown(e: PointerEvent) {
    if (!this.isCanvasEvent(e)) return;

    const navigate = e.button === 1 || (e.button === 0 && e.altKey);
    if (!navigate) {
      if (e.button === 0) this.startStroke(e);
      return;
    }

    e.preventDefault();
    const mode = e.shiftKey ? ViewMode.PAN : e.ctrlKey ? ViewMode.ZOOM : ViewMode.ORBIT;

    this.push_ctx_active();
    void this.ctx.toolstack.execTool(this.ctx, new ViewNavigateOp(this, mode, e), e);
    this.pop_ctx_active();
  }

  private startStroke(e: PointerEvent) {
    const mode = _appstate.scene.toolMode;
    if (mode !== ToolMode.PAINT) return;
    e.preventDefault();
    _appstate.renderer.syncScene(_appstate.scene);
    this.push_ctx_active();
    void this.ctx.toolstack.execTool(this.ctx, new PaintStrokeOp(this, e), e);
    this.pop_ctx_active();
  }

  private onWheel(e: WheelEvent) {
    if (!this.isCanvasEvent(e)) return;
    e.preventDefault();
    this.sceneCamera().zoom(Math.exp(e.deltaY * 0.001));
    window.redraw_all();
  }

  init() {
    super.init();
    this.setCSS();
  }

  private ensureContext() {
    if (this.gpuContext) {
      return this.gpuContext;
    }
    const { device, format } = getGPU();
    const ctx = this.canvas.getContext("webgpu");
    if (!ctx) {
      throw new Error("canvas.getContext('webgpu') failed");
    }
    ctx.configure({ device, format, alphaMode: "opaque" });
    this.gpuContext = ctx;
    return ctx;
  }

  /** Resizes the canvas backing store to the area's size times the DPI. */
  updateSize() {
    const dpi = UIBase.getDPI();
    const [sw, sh] = this.size ?? [1, 1];
    const w = Math.max(1, ~~(sw * dpi));
    const h = Math.max(1, ~~(sh * dpi));

    if (this.lastDpi !== dpi || w !== this.canvas.width || h !== this.canvas.height) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style.width = sw + "px";
      this.canvas.style.height = sh + "px";
      this.lastDpi = dpi;
      window.redraw_all?.();
    }
  }

  draw() {
    const ctx = this.ensureContext();
    _appstate.renderer.draw(ctx, _appstate.scene, this.canvas.width, this.canvas.height);
  }

  update() {
    super.update();
    this.updateSize();
  }

  on_resize(size: number[], oldsize?: number[]) {
    super.on_resize(size, oldsize);
    window.redraw_all?.();
  }

  static define() {
    return {
      tagname: "sa3d-viewport-editor-x",
      areaname: "sa3d_viewport",
      uiname: "Viewport",
      icon: -1,
    };
  }
}
Editor.register(ViewportEditor);
ViewportEditor.STRUCT = nstructjs.STRUCT.inherit(ViewportEditor, Editor, "sa3d.ViewportEditor") + "\n}\n";
nstructjs.register(ViewportEditor);
