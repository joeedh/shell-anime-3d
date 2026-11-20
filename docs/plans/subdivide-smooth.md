# Subdivide Smooth tool

Status: implemented (`src/mesh/subdivide.ts`, `SubdivideSmoothOp` in `src/mesh/mesh_ops.ts`,
button in the Mesh panel, `tests/subdivide.test.ts`). The smoothing lives in
`src/mesh/smooth.ts` and is also its own op, `mesh.smooth` (Smooth button), with the same
inputs, undo and correction-map handling but no split.

## Goal

- A mesh op, `mesh.subdivide_smooth`, that splits every triangle 1→4 and then applies a
  little weighted Laplacian smoothing.
- Use case: refine a coarse or sculpted mesh so the shell and PN patches follow a smoother
  surface, without losing the paint.

## Design (as implemented)

- **Split:** one new vertex per undirected edge (sorted vertex-pair key) at its midpoint,
  shared by both triangles. Triangle (a, b, c) with midpoints ab, bc, ca becomes
  (a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca), so the winding is kept.
- **UVs:** each new corner's UV is the midpoint of its own triangle's corner UVs. UVs are
  per corner, so seams need no special case and the UV layout is unchanged. The paint maps
  live in UV space, so they carry over untouched (no `maps.clear()`, no re-unwrap).
- **Smoothing:** `iterations` Jacobi steps of p ← p + f · ((L(p) − p) · n) n.
  - L(p) is the cotangent-weighted 1-ring mean, weights unclamped. Cots are capped at
    ±1e3, and a vertex whose weight sum is not positive and finite falls back to uniform
    weights.
  - Only the normal component is applied, so vertices do not slide and the paint does not
    slide with them.
  - Taubin by default (`keepVolume`): each λ = factor step is followed by a
    μ = 1 / (0.1 − 1/λ) step, so the mesh does not shrink.
  - Vertices of boundary or non-manifold edges (seen by ≠ 2 triangles) stay fixed.
  - Defaults: factor 0.5, iterations 1. They are tool inputs, clamped in exec. The panel
    button has no input UI; scripts pass values as
    `mesh.subdivide_smooth(factor=0.3 iterations=2)` (space-separated), and path.ux
    remembers the last values used for the next run.
- **Correction map:** cAbs and cRel are averaged onto the midpoints. If the old map was
  solved (or is non-zero, since `corrSolvedAt` is not saved in files), the new mesh is
  marked stale and the op reports it.
- **Analytic flag:** the result is not analytic (the reference uses the mesh).
- **Undo:** snapshot the old mesh. The paint is untouched, so it is not snapshotted. The
  correction state (none, fresh or stale) is stored and re-expressed on the restored mesh's
  new `geomVersion`.

## Results (scene.sa3d, after Solve Correction)

- 960 → 3840 triangles; subdivide 10–25 ms, solve 0.35 s → 1.5 s.
- Compare missing / extra pixels:

  | Model  | Before     | After     |
  | ------ | ---------- | --------- |
  | Sphere | 980 / 2278 | 638 / 700 |
  | PN     | 38 / 2446  | 64 / 689  |
  - The reference is built from the mesh, so it changes too; the rows are not a strict
    like-for-like comparison.

## Pressure test (fresh subagent)

Claims that broke, and how the plan changed:

- **"factor 0.5 lowers the radial error on a sphere"**: broke. Laplacian smoothing shrinks
  a convex mesh (mean |1 − r| of midpoints 0.0049 → 0.0059 at d16).
  - Change: Taubin λ/μ by default. The sphere test now checks that the spread of the radius
    drops and the mean radius holds, and that it shrinks without `keepVolume`.
- **Undo restoring the raw `corrSolvedAt`**: broke. `geomVersion` is not saved, so a
  restored mesh starts over and the raw number gives a false answer either way.
  - Change: store none/fresh/stale and re-express it.
- **"The existing warning asks for Solve Correction"**: broke. The only warning is at the
  end of a sculpt stroke.
  - Change: the op reports it. Also, a non-zero map counts as solved, because
    `corrSolvedAt` comes back as -1 from a file.
- **Degenerate triangles**: broke. A collinear corner gives cot = ±∞, and
  `Math.max(0, ∞)` lets it through, so ∞/∞ = NaN positions. The "all weights clamp to
  zero" fallback could never fire: per triangle, the two far-corner cots sum to
  sin θ_v / (sin θ_j sin θ_k) > 0.
  - Change: capped cots, a finiteness fallback, and a test with collinear triangles.

Claims that only partly held:

- **"Clamped cotan weights keep the paint from sliding"**: partly held. scene.sa3d has 436
  obtuse triangles out of 960, and clamping gave a tangential motion of about 19% of the
  normal motion (unclamped 0.2%, uniform 110%).
  - Change: no clamp, and only the normal component is applied. The test is now "an
    irregular flat grid does not move at all", which replaces the planar-grid test (that
    one could not fail).
- **Tool inputs**: no last-tool panel is mounted, and `setValue` does not enforce ranges.
  - Change: clamp in exec. The button uses the defaults.
- **Counts V + E and 4T**: held, given sorted-pair edge keys. Non-manifold edges get one
  midpoint and their vertices are held fixed.

Held:

- UVs and paint carry over. The gutter and wmax passes work per UV triangle, and
  `PaintGPU`, MeshBuffers, the BVH and the reference are keyed by the mesh object, so they
  rebuild.
- Redo is undoPre + exec, so a deterministic exec is enough.
- GPU buffers at 4x scene.sa3d are small. The reference is bounded by `REF_MAX_TRIS`.

Costs to know (not changed):

- The reference rebuild at the end of each sculpt stroke grows about 3x per subdivide (88 → 278 ms
  on scene.sa3d), and `solveCorrection` about 4–5x.
- Rejected alternative: `butterflySubdivide` (interpolating, no shrink). The request was
  for Laplacian smoothing; butterfly stays available if an interpolating option is wanted.
