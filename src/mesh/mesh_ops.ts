import { BoolProperty, FloatProperty, IntProperty, ToolOp, nstructjs } from "../pathux";
import { Mesh } from "./mesh";
import { makePrimitive } from "./primitives";
import { unwrapMesh } from "../uv/unwrap";
import type { AppContext } from "../core/context";
import { solveCorrection } from "../solver/correction";
import { SUBDIVIDE_SMOOTH_DEFAULTS, subdivideSmooth } from "./subdivide";

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

type CorrState = "none" | "fresh" | "stale";

/**
 * Whether the correction map was solved, and for this geometry. `corrSolvedAt` is not saved
 * in files, so a loaded non-zero map counts as stale.
 */
function correctionState(mesh: Mesh): CorrState {
  if (mesh.corrSolvedAt >= 0) return mesh.correctionStale ? "stale" : "fresh";
  return mesh.cAbs.some((x) => x !== 0) || mesh.cRel.some((x) => x !== 0) ? "stale" : "none";
}

/** Re-expresses a state on a mesh whose `geomVersion` started over (snapshot restore, new mesh). */
function setCorrectionState(mesh: Mesh, state: CorrState) {
  mesh.corrSolvedAt = state === "none" ? -1 : state === "fresh" ? mesh.geomVersion : mesh.geomVersion - 1;
}

type SubdivideInputs = { factor: FloatProperty; iterations: IntProperty; keepVolume: BoolProperty };
const SubdivideBase = ToolOp as unknown as new () => ToolOp<SubdivideInputs, {}, AppContext>;

/**
 * Splits every triangle 1→4 and smooths a little (src/mesh/subdivide.ts). The UV layout is
 * kept, so the paint survives; undo restores the previous mesh.
 */
export class SubdivideSmoothOp extends SubdivideBase {
  private oldMesh: number[] | undefined;
  private oldCorr: CorrState = "none";

  static tooldef() {
    const d = SUBDIVIDE_SMOOTH_DEFAULTS;
    return {
      uiname: "Subdivide Smooth",
      toolpath: "mesh.subdivide_smooth",
      description: "Split every triangle into four, then apply a little Laplacian smoothing (keeps paint)",
      inputs: {
        factor: new FloatProperty(d.factor, "factor", "Smooth").setRange(0, 1),
        iterations: new IntProperty(d.iterations, "iterations", "Iterations").setRange(0, 10),
        keepVolume: new BoolProperty(d.keepVolume, "keepVolume", "Keep Volume"),
      },
      outputs: {},
    };
  }

  undoPre(ctx: AppContext) {
    const mesh = ctx.scene.mesh;
    this.oldMesh = snapshotMesh(mesh);
    this.oldCorr = correctionState(mesh);
  }

  undo(ctx: AppContext) {
    if (!this.oldMesh) return;
    const mesh = restoreMesh(this.oldMesh);
    setCorrectionState(mesh, this.oldCorr);
    ctx.scene.setMesh(mesh);
    window.redraw_all();
  }

  calcUndoMem() {
    return this.oldMesh?.length ?? 0;
  }

  exec(ctx: AppContext) {
    const old = ctx.scene.mesh;
    const mesh = subdivideSmooth(old, {
      // setValue does not enforce the property range
      factor: Math.min(1, Math.max(0, this.inputs.factor.getValue())),
      iterations: Math.min(10, Math.max(0, Math.round(this.inputs.iterations.getValue()))),
      keepVolume: this.inputs.keepVolume.getValue(),
    });
    // the carried-over correction map is only a starting point: flag it stale if it was solved
    const solved = correctionState(old) !== "none";
    if (solved) setCorrectionState(mesh, "stale");
    ctx.scene.setMesh(mesh);
    _appstate.viewctx.report(
      `Subdivided: ${old.triCount} → ${mesh.triCount} triangles` +
        (solved ? " (correction map stale: Solve Correction)" : ""),
      solved ? "orange" : "green",
    );
    window.redraw_all();
  }
}
ToolOp.register(SubdivideSmoothOp as unknown as Parameters<typeof ToolOp.register>[0]);

/** Solves the correction map (c_abs, c_rel) for the current geometry; see src/solver. */
export class SolveCorrectionOp extends ToolOpBase {
  static tooldef() {
    return {
      uiname: "Solve Correction",
      toolpath: "mesh.solve_correction",
      description: "Make the shell reach the smooth contour plus the line width from every view",
      inputs: {},
      outputs: {},
    };
  }

  exec(ctx: AppContext) {
    const mesh = ctx.scene.mesh;
    const res = solveCorrection(mesh);
    mesh.cAbs = res.cAbs;
    mesh.cRel = res.cRel;
    mesh.corrSolvedAt = mesh.geomVersion;
    mesh.markCorrectionChanged();
    const maxAbs = res.cAbs.reduce((a, b) => Math.max(a, b), 0);
    const maxRel = res.cRel.reduce((a, b) => Math.max(a, b), 0);
    // the tool context is a locked proxy without report(); the view context has it
    _appstate.viewctx.report(
      `Solved in ${res.ms.toFixed(0)} ms: max c_abs ${maxAbs.toFixed(4)}, max c_rel ${maxRel.toFixed(3)}, ` +
        `residual ${(res.residual * 100).toFixed(2)}% of an edge`,
      res.failing > 0 ? "orange" : "green",
    );
    window.redraw_all();
  }
}
ToolOp.register(SolveCorrectionOp as unknown as Parameters<typeof ToolOp.register>[0]);

/** Zeroes the correction map, leaving the raw conservative shell. */
export class ClearCorrectionOp extends ToolOpBase {
  static tooldef() {
    return {
      uiname: "Clear Correction",
      toolpath: "mesh.clear_correction",
      description: "Zero c_abs and c_rel",
      inputs: {},
      outputs: {},
    };
  }

  exec(ctx: AppContext) {
    const mesh = ctx.scene.mesh;
    mesh.cAbs = new Float32Array(mesh.vertCount);
    mesh.cRel = new Float32Array(mesh.vertCount);
    mesh.corrSolvedAt = -1;
    mesh.markCorrectionChanged();
    window.redraw_all();
  }
}
ToolOp.register(ClearCorrectionOp as unknown as Parameters<typeof ToolOp.register>[0]);
