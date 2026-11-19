import { nstructjs } from "../pathux";

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

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  sa3d.Scene {
    settings : sa3d.RenderSettings;
  }`,
  );

  loadSTRUCT(reader: (obj: this) => void) {
    reader(this);
  }
}
