import { ToolOp, nstructjs } from "../pathux";
import { Mesh } from "./mesh";
import { makePrimitive } from "./primitives";
import { unwrapMesh } from "../uv/unwrap";
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
 * Base for ops that replace the mesh's topology or UVs and therefore reset the paint.
 * Undo restores the previous mesh and paint exactly (sculpting and strokes included).
 */
abstract class MeshResetOp extends ToolOpBase {
  private oldMesh: number[] | undefined;
  private oldPaint: Uint16Array | undefined;

  undoPre(ctx: AppContext) {
    this.oldMesh = snapshotMesh(ctx.scene.mesh);
    this.oldPaint = ctx.scene.maps.data.slice();
  }

  undo(ctx: AppContext) {
    if (!this.oldMesh || !this.oldPaint) return;
    ctx.scene.setMesh(restoreMesh(this.oldMesh));
    ctx.scene.maps.data.set(this.oldPaint);
    ctx.scene.maps.version++;
    window.redraw_all();
  }

  protected finish(ctx: AppContext, mesh: Mesh) {
    unwrapMesh(mesh);
    mesh.markUVsChanged();
    ctx.scene.setMesh(mesh);
    ctx.scene.maps.clear();
    window.redraw_all();
  }

  calcUndoMem() {
    return (this.oldMesh?.length ?? 0) + (this.oldPaint?.byteLength ?? 0);
  }
}

/** Replaces the scene mesh with the primitive described by `scene.pendingPrimitive`. */
export class SetPrimitiveOp extends MeshResetOp {
  static tooldef() {
    return {
      uiname: "Create Primitive",
      toolpath: "mesh.set_primitive",
      description: "Replace the mesh with this primitive (resets paint)",
      inputs: {},
      outputs: {},
    };
  }

  exec(ctx: AppContext) {
    this.finish(ctx, makePrimitive(ctx.scene.pendingPrimitive));
  }
}
ToolOp.register(SetPrimitiveOp as unknown as Parameters<typeof ToolOp.register>[0]);

/** Re-unwraps the current mesh, e.g. after sculpting has stretched the UVs. */
export class UnwrapOp extends MeshResetOp {
  static tooldef() {
    return {
      uiname: "Unwrap UVs",
      toolpath: "mesh.unwrap",
      description: "Recompute UVs (resets paint)",
      inputs: {},
      outputs: {},
    };
  }

  exec(ctx: AppContext) {
    // a copy, so undo's snapshot of the old mesh stays independent
    const mesh = restoreMesh(snapshotMesh(ctx.scene.mesh));
    this.finish(ctx, mesh);
  }
}
ToolOp.register(UnwrapOp as unknown as Parameters<typeof ToolOp.register>[0]);
