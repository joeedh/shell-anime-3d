import * as nstructjs from "nstructjs";
import { Camera } from "./camera";
import { Mesh, PrimitiveParams } from "../mesh/mesh";
import { makePrimitive } from "../mesh/primitives";

/** Which clip test trims the shell's fragments. A plain object so path.ux can use it as an enum def. */
export const ClipModel = {
  RAW_HULL: 0,
  SPHERE: 1,
  PN_PATCH: 2,
} as const;
export type ClipModel = (typeof ClipModel)[keyof typeof ClipModel];

/** View and comparison toggles; saved with the scene. */
export class RenderSettings {
  clipModel: ClipModel = ClipModel.SPHERE;
  showReference = false;
  showCompare = false;
  showWireframe = false;
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
  /** Object-space "front" for the view-angle weight: head-on along it gives wFront. */
  frontAxis = [0, 0, 1];
  /** What "Create Primitive" builds; editing it changes nothing until the op runs. */
  pendingPrimitive = new PrimitiveParams();

  constructor() {
    this.mesh = makePrimitive(new PrimitiveParams());
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
  }`,
  );

  loadSTRUCT(reader: (obj: this) => void) {
    reader(this);
  }
}
