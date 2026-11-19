import { ToolOp } from "../pathux";
import type { AppContext } from "../core/context";
import type { ViewportEditor } from "../editors/viewport/viewport";
import { GUTTER_TEXELS } from "./gutter";
import type { TileSet } from "./paint_gpu";

const ToolOpBase = ToolOp as unknown as new () => ToolOp<{}, {}, AppContext>;

/**
 * One paint stroke, painted straight into the GPU texture. Undo is per tile: the stroke
 * saves each tile's starting state on the GPU, and at stroke end downloads those and the
 * final tiles. Undo/redo await that download before uploading either set.
 */
export class PaintStrokeOp extends ToolOpBase {
  private viewport: ViewportEditor | undefined;
  private startEvent: PointerEvent | undefined;
  private last: [number, number] | undefined;
  private readback: Promise<TileSet> | undefined;
  private tileSet: TileSet | undefined;
  private cancelled = false;

  constructor(viewport?: ViewportEditor, e?: PointerEvent) {
    super();
    this.viewport = viewport;
    this.startEvent = e;
  }

  static tooldef() {
    return {
      uiname: "Paint Stroke",
      toolpath: "paint.stroke",
      is_modal: true,
      inputs: {},
      outputs: {},
    };
  }

  undoPre() {
    // tiles are saved during the stroke
  }

  modalStart(ctx: AppContext) {
    const ret = super.modalStart(ctx);
    _appstate.renderer.paint.beginStroke();
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
    const ray = vp.rayFromClient(x, y);
    const hit = _appstate.bvhFor(mesh).raycast(ray.origin, ray.dir);
    this.last = [x, y];
    if (!hit) return;

    const brush = scene.brush;
    const radius = brush.radius * vp.worldPerCssPixel(hit.point);
    const paint = _appstate.renderer.paint;
    const size = scene.maps.size;
    const pad = GUTTER_TEXELS + 1;

    const rect: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    const tiles = new Set<number>();
    _appstate.bvhFor(mesh).querySphere(hit.point, radius, (t) => {
      const uv = mesh.uvs;
      const xs = [uv[t * 6], uv[t * 6 + 2], uv[t * 6 + 4]].map((u) => u * size);
      const ys = [uv[t * 6 + 1], uv[t * 6 + 3], uv[t * 6 + 5]].map((v) => v * size);
      const r: [number, number, number, number] = [
        Math.max(0, Math.floor(Math.min(...xs)) - pad),
        Math.max(0, Math.floor(Math.min(...ys)) - pad),
        Math.min(size, Math.ceil(Math.max(...xs)) + pad),
        Math.min(size, Math.ceil(Math.max(...ys)) + pad),
      ];
      rect[0] = Math.min(rect[0], r[0]);
      rect[1] = Math.min(rect[1], r[1]);
      rect[2] = Math.max(rect[2], r[2]);
      rect[3] = Math.max(rect[3], r[3]);
      for (const tile of paint.tilesForRect(r)) tiles.add(tile);
    });
    if (!tiles.size) return;

    paint.dab(_appstate.renderer.meshBuffers, {
      center: hit.point,
      radius,
      value: brush.value,
      strength: brush.strength,
      hardness: brush.hardness,
      mode: brush.mode,
      channel: brush.channel,
      rect,
      tiles: [...tiles],
    });
    _appstate.renderer.wmaxDirty = true;
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

  modalEnd(wasCancelled?: boolean) {
    const paint = _appstate.renderer.paint;
    if (wasCancelled) {
      // the toolstack runs undo() next; the atlas still holds every saved tile
      this.cancelled = true;
      paint.cancelStroke();
    } else {
      const maps = _appstate.scene.maps;
      this.readback = paint.endStroke().then((set) => {
        this.tileSet = set;
        paint.mirrorTiles(maps, set.tiles, set.after);
        return set;
      });
    }
    this.viewport = undefined;
    this.startEvent = undefined;
    super.modalEnd(wasCancelled);
  }

  async undo() {
    if (this.cancelled) {
      _appstate.renderer.wmaxDirty = true;
      window.redraw_all();
      return;
    }
    const set = await this.readback;
    if (!set) return;
    _appstate.renderer.paint.applyTiles(_appstate.scene.maps, set.tiles, set.before);
    _appstate.renderer.wmaxDirty = true;
    window.redraw_all();
  }

  async redo() {
    const set = await this.readback;
    if (!set) return;
    _appstate.renderer.paint.applyTiles(_appstate.scene.maps, set.tiles, set.after);
    _appstate.renderer.wmaxDirty = true;
    window.redraw_all();
  }

  calcUndoMem() {
    const s = this.tileSet;
    return s ? s.tiles.length * 2 * s.before[0].byteLength : 0;
  }
}
ToolOp.register(PaintStrokeOp as unknown as Parameters<typeof ToolOp.register>[0]);
