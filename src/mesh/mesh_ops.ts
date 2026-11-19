import { ToolOp, nstructjs } from "../pathux";
import { Mesh } from "./mesh";
import { makePrimitive } from "./primitives";
import type { AppContext } from "../core/context";

const ToolOpBase = ToolOp as unknown as new () => ToolOp<{}, {}, AppContext>;

function snapshotMesh(mesh: Mesh): number[] {
  const data: number[] = [];
  nstructjs.writeObject(data, mesh);
  return data;
}

function restoreMesh(data: number[]): Mesh {
  const mesh = nstructjs.readObject(new DataView(new Uint8Array(data).buffer), Mesh) as Mesh;
  mesh.rebuildDerived();
  return mesh;
}

/**
 * Replaces the scene mesh with the primitive described by `scene.pendingPrimitive`.
 * Undo restores the previous mesh exactly (sculpting included), not by regenerating it.
 */
export class SetPrimitiveOp extends ToolOpBase {
  private oldMesh: number[] | undefined;

  static tooldef() {
    return {
      uiname: "Create Primitive",
      toolpath: "mesh.set_primitive",
      inputs: {},
      outputs: {},
    };
  }

  undoPre(ctx: AppContext) {
    this.oldMesh = snapshotMesh(ctx.scene.mesh);
  }

  undo(ctx: AppContext) {
    if (this.oldMesh) {
      ctx.scene.setMesh(restoreMesh(this.oldMesh));
      window.redraw_all();
    }
  }

  exec(ctx: AppContext) {
    ctx.scene.setMesh(makePrimitive(ctx.scene.pendingPrimitive));
    window.redraw_all();
  }

  calcUndoMem() {
    return this.oldMesh?.length ?? 0;
  }
}
ToolOp.register(SetPrimitiveOp as unknown as Parameters<typeof ToolOp.register>[0]);
