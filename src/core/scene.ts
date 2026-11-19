import * as nstructjs from "nstructjs";
import { Camera } from "./camera";
import { Mesh, PrimitiveParams } from "../mesh/mesh";
import { makePrimitive } from "../mesh/primitives";
import { unwrapMesh } from "../uv/unwrap";
import { PaintMaps } from "../paint/paintmaps";
import { BrushSettings, ToolMode } from "../paint/brush";

/** Which clip test trims the shell's fragments. A plain object so path.ux can use it as an enum def. */
export const ClipModel = {
  RAW_HULL: 0,
  SPHERE: 1,
  PN_PATCH: 2,
} as const;
export type ClipModel = (typeof ClipModel)[keyof typeof ClipModel];

/** What the base pass tints the mesh with. */
export const Overlay = {
  NONE: 0,
  WIDTH: 1,
  FRONT: 2,
  PROFILE: 3,
} as const;
export type Overlay = (typeof Overlay)[keyof typeof Overlay];

/** View and comparison toggles; saved with the scene. */
export class RenderSettings {
  clipModel: ClipModel = ClipModel.SPHERE;
  showReference = false;
  showCompare = false;
  showWireframe = false;
  overlay: Overlay = Overlay.NONE;
  /** Reference resolution height that painted widths (px) are measured against. */
  refHeight = 1080;
  lineColor = [0.05, 0.05, 0.08];

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  sa3d.RenderSettings {
    clipModel     : int;
    showReference : bool;
    showCompare   : bool;
    showWireframe : bool;
    overlay       : int;
    refHeight     : float;
    lineColor     : array(float);
  }`,
  );

  loadSTRUCT(reader: (obj: this) => void) {
    reader(this);
  }
}

/** Root of the document: everything saved to a scene file and snapshotted for undo. */
export class Scene {
  settings = new RenderSettings();
  camera = new Camera();
  mesh: Mesh;
  maps: PaintMaps;
  /** Object-space "front" for the view-angle weight: head-on along it gives wFront. */
  frontAxis = [0, 0, 1];
  /** What "Create Primitive" builds; editing it changes nothing until the op runs. */
  pendingPrimitive = new PrimitiveParams();
  brush = new BrushSettings();
  toolMode: ToolMode = ToolMode.PAINT;

  /** `init = false` skips building the default mesh and maps (loading overwrites them). */
  constructor(init = true) {
    if (init) {
      this.mesh = makePrimitive(new PrimitiveParams());
      unwrapMesh(this.mesh);
      this.mesh.markUVsChanged();
      this.maps = new PaintMaps();
    } else {
      this.mesh = new Mesh();
      this.maps = new PaintMaps(0);
    }
  }

  static newSTRUCT() {
    return new Scene(false);
  }

  setMesh(mesh: Mesh) {
    this.mesh = mesh;
  }

  /** Rebuilds derived data; call once after the whole scene has been read from a file. */
  afterLoad() {
    this.mesh.rebuildDerived();
  }

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  sa3d.Scene {
    settings  : sa3d.RenderSettings;
    camera    : sa3d.Camera;
    mesh      : sa3d.Mesh;
    frontAxis : array(float);
    pendingPrimitive : sa3d.PrimitiveParams;
    maps             : sa3d.PaintMaps;
    brush            : sa3d.BrushSettings;
    toolMode         : int;
  }`,
  );

  loadSTRUCT(reader: (obj: this) => void) {
    reader(this);
  }
}
