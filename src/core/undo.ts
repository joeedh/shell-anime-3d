import { ToolOp, nstructjs } from "../pathux";
import { Scene } from "./scene";

// path.ux's base ToolOp.undoPre/undo throw, and setDefaultUndoHandlers is dead code,
// so install whole-scene snapshot undo on the prototype (as path.ux's example does).
// Ops that change large data (paint, sculpt, primitives) override both hooks.

declare module "../pathux" {
  interface ToolOp {
    _sceneUndo?: number[];
  }
}

/** Serializes the scene for undo; same session, so no struct scripts are needed. */
export function snapshotScene(scene: Scene): number[] {
  const data: number[] = [];
  nstructjs.writeObject(data, scene);
  return data;
}

export function restoreScene(data: number[]): Scene {
  const scene = nstructjs.readObject(new DataView(new Uint8Array(data).buffer), Scene) as Scene;
  scene.afterLoad();
  return scene;
}

ToolOp.prototype.undoPre = function () {
  this._sceneUndo = snapshotScene(_appstate.scene);
};

ToolOp.prototype.undo = function () {
  if (this._sceneUndo) {
    _appstate.setScene(restoreScene(this._sceneUndo), false);
  }
};

ToolOp.prototype.calcUndoMem = function () {
  return this._sceneUndo?.length ?? 0;
};
