import { UIBase, nstructjs } from "../../pathux";
import { Editor } from "../editor_base";
import { getGPU } from "../../gpu/device";

/** 3D view: a WebGPU canvas behind the area's header. */
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
