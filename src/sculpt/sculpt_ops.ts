import { ToolOp } from "../pathux";
import type { AppContext } from "../core/context";
import type { ViewportEditor } from "../editors/viewport/viewport";
import { ToolMode } from "../paint/brush";
import { SculptBrush, sculptDab, updateAfterMove } from "./sculpt";
import type { V3 } from "./sculpt";

const ToolOpBase = ToolOp as unknown as new () => ToolOp<{}, {}, AppContext>;

/**
 * One sculpt stroke (draw or smooth). Each dab updates normals, curvature, the BVH and the
 * GPU copy incrementally; the reference rebuild waits for the stroke to end. Undo keeps the
 * starting and final positions of the vertices the stroke moved.
 */
export class SculptStrokeOp extends ToolOpBase {
  private viewport: ViewportEditor | undefined;
  private startEvent: PointerEvent | undefined;
  private last: [number, number] | undefined;
  private invert = false;
  private orig = new Map<number, V3>();
  private final = new Map<number, V3>();
  private wasAnalytic = false;

  constructor(viewport?: ViewportEditor, e?: PointerEvent) {
    super();
    this.viewport = viewport;
    this.startEvent = e;
    this.invert = !!e?.ctrlKey;
  }

  static tooldef() {
    return {
      uiname: "Sculpt Stroke",
      toolpath: "sculpt.stroke",
      is_modal: true,
      inputs: {},
      outputs: {},
    };
  }

  undoPre() {
    // positions are recorded as the stroke touches them
  }

  modalStart(ctx: AppContext) {
    const ret = super.modalStart(ctx);
    const mesh = _appstate.scene.mesh;
    this.wasAnalytic = mesh.isAnalytic;
    _appstate.renderer.reference.frozen = true;
    if (this.startEvent) {
      this.dabAt(this.startEvent.clientX, this.startEvent.clientY);
    }
    return ret;
  }

  private dabAt(x: number, y: number) {
    const vp = this.viewport;
    if (!vp) return;
    const scene = _appstate.scene;
    const mesh = scene.mesh;
    const bvh = _appstate.bvhFor(mesh);
    const ray = vp.rayFromClient(x, y);
    const hit = bvh.raycast(ray.origin, ray.dir);
    this.last = [x, y];
    if (!hit) return;

    const brush = scene.brush;
    const moved = sculptDab(
      mesh,
      bvh,
      {
        center: hit.point,
        radius: brush.radius * vp.worldPerCssPixel(hit.point),
        strength:
          scene.toolMode === ToolMode.SCULPT_SMOOTH
            ? Math.min(1, brush.sculptStrength * 10)
            : brush.sculptStrength,
        hardness: brush.hardness,
        brush: scene.toolMode === ToolMode.SCULPT_SMOOTH ? SculptBrush.SMOOTH : SculptBrush.DRAW,
        invert: this.invert,
      },
      this.orig,
    );
    if (!moved.length) return;
    mesh.isAnalytic = false;
    const ring2 = updateAfterMove(mesh, moved);
    _appstate.geometryEdited(mesh, ring2);
    window.redraw_all();
  }

  on_pointermove(e: PointerEvent) {
    if (!this.last) return;
    const step = Math.max(1, _appstate.scene.brush.radius * _appstate.scene.brush.spacing);
    let [lx, ly] = this.last;
    let dist = Math.hypot(e.clientX - lx, e.clientY - ly);
    while (dist >= step) {
      lx += ((e.clientX - lx) / dist) * step;
      ly += ((e.clientY - ly) / dist) * step;
      this.dabAt(lx, ly);
      dist = Math.hypot(e.clientX - lx, e.clientY - ly);
    }
  }

  on_pointerup() {
    this.modalEnd(false);
  }

  on_pointercancel() {
    this.modalEnd(true);
  }

  on_keydown(e: KeyboardEvent) {
    if (e.key === "Escape") this.modalEnd(true);
  }

  modalEnd(wasCancelled?: boolean) {
    const mesh = _appstate.scene.mesh;
    const p = mesh.positions;
    for (const v of this.orig.keys()) this.final.set(v, [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]]);
    _appstate.renderer.reference.frozen = false;
    if (!wasCancelled && this.orig.size && mesh.correctionStale) {
      _appstate.viewctx.report("Geometry changed: the correction map is stale (Solve Correction)", "orange");
    }
    this.viewport = undefined;
    this.startEvent = undefined;
    window.redraw_all();
    super.modalEnd(wasCancelled);
  }

  private apply(pos: Map<number, V3>, analytic: boolean) {
    const mesh = _appstate.scene.mesh;
    for (const [v, x] of pos) mesh.positions.set(x, v * 3);
    mesh.isAnalytic = analytic;
    const ring2 = updateAfterMove(mesh, pos.keys());
    _appstate.geometryEdited(mesh, ring2);
    window.redraw_all();
  }

  undo() {
    this.apply(this.orig, this.wasAnalytic);
  }

  redo() {
    this.apply(this.final, false);
  }

  calcUndoMem() {
    return (this.orig.size + this.final.size) * 40;
  }
}
ToolOp.register(SculptStrokeOp as unknown as Parameters<typeof ToolOp.register>[0]);
