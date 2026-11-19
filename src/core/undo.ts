import { ToolOp, nstructjs } from "../pathux";
import { Scene } from "./scene";
import { PaintMaps } from "../paint/paintmaps";

// path.ux's base ToolOp.undoPre/undo throw, and setDefaultUndoHandlers is dead code,
// so install whole-scene snapshot undo on the prototype (as path.ux's example does).
// Ops that change large data (paint, sculpt, primitives) override both hooks.

declare module "../pathux" {
  interface ToolOp {
    _sceneUndo?: number[];
  }
}

const EMPTY_MAPS = new PaintMaps(0);

/**
 * Serializes the scene for undo, without the paint maps (megabytes; ops that change them
 * keep their own undo data). Same session, so no struct scripts are needed.
 */
export function snapshotScene(scene: Scene): number[] {
  const maps = scene.maps;
  const data: number[] = [];
  scene.maps = EMPTY_MAPS;
  try {
    nstructjs.writeObject(data, scene);
  } finally {
    scene.maps = maps;
  }
  return data;
}

/** Rebuilds a scene from a snapshot, keeping the live scene's paint maps. */
export function restoreScene(data: number[], current: Scene): Scene {
  const scene = nstructjs.readObject(new DataView(new Uint8Array(data).buffer), Scene) as Scene;
  scene.maps = current.maps;
  scene.afterLoad();
  return scene;
}

ToolOp.prototype.undoPre = function () {
  this._sceneUndo = snapshotScene(_appstate.scene);
};

ToolOp.prototype.undo = function () {
  if (this._sceneUndo) {
    _appstate.setScene(restoreScene(this._sceneUndo, _appstate.scene), false);
  }
};

ToolOp.prototype.calcUndoMem = function () {
  return this._sceneUndo?.length ?? 0;
};
