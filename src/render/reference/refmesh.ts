import { Mesh } from "../../mesh/mesh";
import { butterflySubdivide } from "../../mesh/butterfly";
import { projectToAnalytic } from "../../mesh/primitives";
import { computeCurvature } from "../../mesh/curvature";

/** Butterfly levels stop before the refined mesh passes this many triangles. */
export const REF_MAX_TRIS = 300_000;
export const REF_MAX_LEVELS = 3;

export interface ReferenceMesh {
  mesh: Mesh;
  /** Largest |principal curvature| per vertex, for the near-contour band test. */
  kmax: Float32Array;
  levels: number;
}

/** Number of butterfly levels for a base mesh: up to 3, capped by `REF_MAX_TRIS`. */
export function referenceLevels(triCount: number) {
  let levels = 0;
  while (levels < REF_MAX_LEVELS && triCount * 4 ** (levels + 1) <= REF_MAX_TRIS) levels++;
  return levels;
}

/**
 * The smooth surface the reference line is measured against: modified butterfly
 * subdivision (interpolating, so it doesn't shrink), projected onto the true surface for an
 * unsculpted analytic primitive. UVs are linear within each original triangle.
 */
export function buildReferenceMesh(src: Mesh): ReferenceMesh {
  const levels = referenceLevels(src.triCount);
  const sub = butterflySubdivide(src, levels);
  const pos = sub.positions;
  if (src.isAnalytic) {
    for (let i = 0; i < pos.length; i += 3) {
      const p = projectToAnalytic(src.primitive, [pos[i], pos[i + 1], pos[i + 2]]);
      pos[i] = p[0];
      pos[i + 1] = p[1];
      pos[i + 2] = p[2];
    }
  }
  const mesh = Mesh.fromArrays(pos, sub.tris);
  mesh.uvs = Float32Array.from(sub.uvs);
  mesh.markUVsChanged();

  const curv = computeCurvature(mesh);
  const kmax = new Float32Array(mesh.vertCount);
  for (let v = 0; v < kmax.length; v++) {
    kmax[v] = Math.max(Math.abs(curv.k1[v]), Math.abs(curv.k2[v]));
  }
  return { mesh, kmax, levels };
}
