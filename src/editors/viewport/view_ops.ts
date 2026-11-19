import { ToolOp, UndoFlags } from "../../pathux";
import type { ViewportEditor } from "./viewport";

const ToolOpBase = ToolOp as unknown as new () => ToolOp<{}, {}>;

export const ViewMode = {
  ORBIT: 0,
  PAN: 1,
  ZOOM: 2,
} as const;
export type ViewMode = (typeof ViewMode)[keyof typeof ViewMode];

/**
 * Drag to orbit, pan or zoom the camera. Pure view state, so NO_UNDO; Escape restores
 * the camera it started from.
 */
export class ViewNavigateOp extends ToolOpBase {
  private viewport: ViewportEditor | undefined;
  private mode: ViewMode = ViewMode.ORBIT;
  private lastX = 0;
  private lastY = 0;
  private startCamera: ReturnType<ViewportEditor["sceneCamera"]> | undefined;

  constructor(viewport?: ViewportEditor, mode?: ViewMode, e?: PointerEvent) {
    super();
    this.viewport = viewport;
    this.mode = mode ?? ViewMode.ORBIT;
    if (e) {
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    }
    this.startCamera = viewport?.sceneCamera().copy();
  }

  static tooldef() {
    return {
      uiname: "Navigate View",
      toolpath: "view3d.navigate",
      is_modal: true,
      undoflag: UndoFlags.NO_UNDO,
      inputs: {},
      outputs: {},
    };
  }

  on_pointermove(e: PointerEvent) {
    const vp = this.viewport;
    if (!vp) return;
    const cam = vp.sceneCamera();
    const h = Math.max(1, vp.size?.[1] ?? 1);
    const dx = (e.clientX - this.lastX) / h;
    const dy = (e.clientY - this.lastY) / h;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    if (this.mode === ViewMode.ORBIT) {
      cam.orbit(dx * Math.PI, dy * Math.PI);
    } else if (this.mode === ViewMode.PAN) {
      cam.pan(dx, dy);
    } else {
      cam.zoom(Math.exp(dy * 2));
    }
    window.redraw_all();
  }

  on_pointerup() {
    this.modalEnd(false);
  }

  on_pointercancel() {
    this.modalEnd(false);
  }

  on_keydown(e: KeyboardEvent) {
    if (e.key === "Escape" && this.viewport && this.startCamera) {
      Object.assign(this.viewport.sceneCamera(), this.startCamera.copy());
      window.redraw_all();
    }
    super.on_keydown(e);
  }

  modalEnd(wasCancelled?: boolean) {
    this.viewport = undefined;
    super.modalEnd(wasCancelled);
  }
}
ToolOp.register(ViewNavigateOp as unknown as Parameters<typeof ToolOp.register>[0]);
