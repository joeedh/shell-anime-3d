# Plan: PN clip model tests the width envelope, not the closest point

Status: implemented (see "GPU results"). Two decisions changed during implementation; see
"Changes during implementation".

## Problem

`tests/scenes/scene.sa3d` is a sculpted sphere (960 triangles) with painted width. The outline
loses whole segments where a wide painted patch crosses the silhouette of a sculpted bulge.
After Solve Correction, the compare pass reports:

| Model  | Missing px, painted width | Missing px, width map cleared |
| ------ | ------------------------- | ----------------------------- |
| Sphere | 980                       | 644                           |
| PN     | 509                       | 77                            |

Diagnosis (RenderDoc pixel debug of (1260, 660), replayed on the CPU with the same result):

- **Wrong question.** The PN fragment finds the patch point closest to its ray and keeps
  the pixel if that distance is below the radius _at that point_. The reference keeps a
  pixel if _any_ surface point's ball reaches it. These agree only for constant width.
- **Wrong basin.** PN patches are only C0 across edges, so along a grazing ray a shared edge
  can be its own local minimum of distance. At the debugged pixel the search ping-ponged
  between triangles 676 and 677 and stopped on their edge (d 0.0288, radius 0.0169). The
  true closest point is on 675 (d 0.0231), where the painted width is 4.9 px instead of 3
  (radius 0.0278).

The sphere model only sees the fragment's own triangle, so it cannot be fixed without
making it non-local. It stays as is; its remaining misses are documented as a limitation.

## Measurement harness

`tests/pn_envelope.test.ts` with `tests/harness/pn_scene.ts` emulates the shell pass on the
CPU for a 180×260 block around the bulge and scores search variants against the compare
mask saved from a RenderDoc capture (`tests/scenes/scene_bulge_compare.txt`).

- Shell fragments: extruded as `vsShell` does (CPU port of `wmax.wgsl`, the solver's
  cAbs/cRel); every back-facing shell triangle the pixel ray crosses is a fragment.
- Scope: pixels whose ray misses the base mesh (3541 pixels; 1725 in the reference). Inside
  the silhouette the GPU also depth-tests against the base, which is not modelled.
- Fidelity: today's search, emulated, agrees with the GPU on 97.1% of pixels.
- Oracle: the exact PN envelope by dense sampling (41×41 per patch). It bounds what any
  search can achieve; its extra pixels are the PN surface differing from the reference's
  butterfly surface.

## Results (missing / extra of 1725 reference pixels; iterations per fragment)

| Variant                                                  | Missing | Extra | Iter/frag |
| -------------------------------------------------------- | ------- | ----- | --------- |
| Oracle (exact PN envelope)                               | 55      | 576   | —         |
| Today: closest point, radius there                       | 511     | 529   | ~5        |
| Descend on φ = d − r, one start                          | 499     | 538   | 6.8       |
| …plus no hop back to the previous triangle               | 588     | 505   | 6.8       |
| φ, flat-walk triangle + its 3 edge neighbours            | 262     | 572   | 16        |
| φ, triangles sharing a vertex with it (ring 1)           | 166     | 596   | 40        |
| φ, two shared-vertex rings, reach-culled, 6 iter, 2 hops | **43**  | 599   | **17.5**  |
| same, 4 iterations, no hops                              | 77      | 591   | 12        |
| d² instead of φ, two rings                               | 75      | 581   | 32        |

What the numbers showed:

- Larger iteration or hop budgets change nothing (40 iterations, 30 hops: 495 missing).
  The search converges, into the wrong basin.
- Given the right triangle, a search confined to it and started at the ray's projected
  footprint always finds φ < 0. The whole problem is picking triangles.
- The triangle holding an envelope point is within two shared-vertex rings of the
  flat-walk triangle for 98.9% of pixels (0 rings: 69%, 1: 18%, 2: 12%).
- Each pixel near the silhouette has exactly one shell fragment, so there is no second
  chance from another fragment.
- The anti-ping-pong clamp (B in the first draft) hurts and is dropped.
- Culled by reach, two rings leave 6.4 candidates per fragment on average, 15 at most.
  Trying them nearest-first saves only 5% of iterations, so the GPU uses ring order.

## Design

The fragment keeps its pixel if some patch point p, inside its triangle, has
φ(p) = d(p) − r(p) < 0, with d = distance from the ray and r = width(uv(p), D) · pw, where
pw is the fragment's pixel size (as in the closest-point model). The search stops at the
first such point.

1. **Flat walk** from the fragment's triangle, as today, to triangle T and a start (u, v).
2. **Search T**: LM descent on φ, at most 12 iterations and 8 edge hops.
   - With f = d², half-gradient g and half-Hessian h as in `pn.ts`:
     ∇d = g / d, ∇²d = h / d − g gᵀ / d³. ∇r is the bilinear map gradient (product rule
     over R and the G/B mix) chained through the triangle's UV Jacobian. r's Hessian is
     ignored.
   - A step is accepted only if φ decreases; λ rises until the damped system is positive
     definite.
   - φ < 0 counts only inside the triangle (all barycentrics ≥ −1e-6). Within the hop slack
     the point lies on the extrapolated cubic, not on the surface.
3. **Search the ring** of T: the triangles within two shared-vertex rings, precomputed per
   triangle in BFS order and capped at 48 (the cap matters only near high-valence vertices,
   such as UV-sphere poles). For each, with reach = max(corner wmax) · pw:
   - skip it if its control points' bounding sphere is out of reach (one vec4 load);
   - skip it if the 2D box of its control points, projected along D, is out of reach;
   - otherwise search it as in step 2, from the ray's footprint clamped into it.
4. **Exit depth** from the first point with φ < 0: `t + √(r² − d²)` along the ray, as today.
   The fragment's own search runs first.

### GPU changes

- `src/mesh/adjacency.ts`: `triRings(mesh, 2, 48)` packs offsets and lists into one
  `Uint32Array` (about 38 entries per triangle; about 10 MB at density 128).
- `MeshBuffers`:
  - the PN buffer stride grows from 11 to 12 vec4s; the new one is the bounding sphere;
  - the ring table is a new storage buffer, binding 6, visible to the **fragment stage
    only**. The mesh layout is shared with the reference's compute pipeline, which already
    uses all 8 default storage-buffer slots.
- `pn.wgsl`: `pnEnvelope(fragTri, O, D, pw)` replaces `pnClosest` in the shell pass. The
  bilinear width and its gradient come from four `textureLoad`s, so value and gradient
  agree. Corner wmax comes from `verts`, since the wmax pass rewrites it after painting.
- `src/math/pn_envelope.ts` is the line-for-line mirror.

## Acceptance

Baselines are measured on the GPU before the change, with today's PN model, and saved in
this file. Every case runs Solve Correction first.

- **Harness:** the mirror gives about 57 missing / 580 extra on the bulge block (oracle
  55 / 576; today 511 / 529). This is a test (`tests/pn_envelope.test.ts`).
- **`scene.sa3d`:** frame-wide PN missing falls from about 509 to under 120. Extra grows by
  at most 15% outside the silhouette.
- **Primitive suite** (default camera, uniform width 3 px unless noted):
  - UV sphere density 16; torus density 24; capsule density 24; cube density 8.
  - UV sphere density 64, camera at pitch 0 so both poles lie on the silhouette: uniform
    width 4 px for the compare (the reference loses the device at 8 px and above), 16 px
    for timing (the cost case from round 2).
  - Missing must not grow on any of them.
- **GPU time:** the viewport's GPU ms for the PN model at most 3× the baseline on
  `scene.sa3d` and on the torus. The density-64 pole case is recorded, not gated.
- `tests/clip_pn.test.ts` keeps passing.

### Baselines (today's PN model, 2026-11-20, RTX 5050)

Measured with `measure.js`-style CDP scripts: Solve Correction, then compare counts after 4
frames; GPU ms is the median of 12 frames of `renderer.gpuMs` (submit to work-done, compare
off), with the raw hull (clip model 0) for scale.

| Case                                        | Tris  | PN missing | PN extra | Raw ms | PN ms |
| ------------------------------------------- | ----- | ---------- | -------- | ------ | ----- |
| scene.sa3d                                  | 960   | 509        | 2601     | 3.6    | 4.3   |
| UV sphere d16, 3 px                         | 960   | 38         | 14776    | 3.7    | 10.5  |
| Torus d24, 3 px                             | 2304  | 45         | 4919     | 3.5    | 7.5   |
| Capsule d24, 3 px                           | 4512  | 4          | 2305     | 3.6    | 9.0   |
| Cube d8, 3 px                               | 192   | 6364       | 37137    | 3.8    | 8.5   |
| UV sphere d64, pitch 0, 4 px                | 16128 | 287        | 959      | 3.9    | 10.7  |
| UV sphere d64, pitch 0, 16 px (timing only) | 16128 | —          | —        | 3.9    | 13.0  |

- The dense case's compare runs at 4 px: **the reference pass loses the GPU device** at
  8 px and above on density 64 (a GPU timeout), so it cannot be ground truth there.
- The sphere model's numbers on the same runs: scene.sa3d 980 missing, torus 4183, cube 7268.

### GPU results (after the change, same runs as the baselines)

| Case                          | PN missing   | PN extra      | PN ms       |
| ----------------------------- | ------------ | ------------- | ----------- |
| scene.sa3d                    | 509 → **38** | 2601 → 2446   | 4.3 → 4.4   |
| UV sphere d16, 3 px           | 38 → 4       | 14776 → 12848 | 10.5 → 10.2 |
| Torus d24, 3 px               | 45 → 50      | 4919 → 3919   | 7.5 → 9.0   |
| Capsule d24, 3 px             | 4 → 3        | 2305 → 2175   | 9.0 → 8.5   |
| Cube d8, 3 px                 | 6364 → 6279  | 37137 → 27035 | 8.5 → 9.7   |
| UV sphere d64, pitch 0, 4 px  | 287 → 76     | 959 → 920     | 10.7 → 13.8 |
| UV sphere d64, pitch 0, 16 px | —            | —             | 13.0 → 15.8 |

- Every acceptance criterion holds except "missing must not grow" on the torus: 45 → 50,
  while its extra falls by 1000. Accepted; the torus's misses are inner-contour coverage
  gaps (Known limitations).
- GPU time grows at most 1.3× (the density-64 pole case), well inside the 3× budget.
- The bulge harness: 42 missing / 597 extra (closest point: 511 / 529; oracle 55 / 576).
- Two isolated one-pixel holes remain inside the line at the bulge.

### Changes during implementation

Measured on the GPU with a temporary debug bitmask in the camera uniform, on the d16
sphere and the torus (missing / extra):

| Variant                                          | Sphere d16    | Torus d24     |
| ------------------------------------------------ | ------------- | ------------- |
| As planned (pixelWorld(p), 6 iterations, 2 hops) | 393 / 12429   | 154 / 3742    |
| …with the fragment's pixel size                  | 205 / 12713   | 106 / 3873    |
| …without the inside-only rule                    | 371 / 12431   | 147 / 3746    |
| …with 12 iterations and 8 hops                   | 119 / 12476   | 66 / 3771     |
| Fragment pixel size + 12 / 8 (shipped)           | **4** / 12848 | **50** / 3919 |

- **Budget back to 12 iterations and 8 hops.** The bulge harness needed only 6 / 2. The
  primitives need more, because on a uniform-width silhouette the flat-walk start lies
  farther from the envelope point.
- **The fragment's pixel size, not pixelWorld(p).** On primitives the reference is built on
  the analytic surface, not the PN surface, so the compare also measures PN's shape error.
  The fragment lies behind the contour, so its pixel size is slightly larger; that covers
  the shape error, as it did in the closest-point model, while pixelWorld(p) exposed it as
  missing pixels. With the fragment's pw, the reach bound is simply max(corner wmax) · pw.
- The inside-only rule stays: it costs little and removes extrapolated hits.

## Known limitations (not addressed here)

- **Inner contours lose about 10% of their pixels to shell coverage**, today and after this
  change. Where a near contour passes in front of the body, the ray can still be inside the
  shell layer when it reaches the base, so the near contour's shell produces no back-face
  fragment. Measured in round 2 on a CPU torus: 35 of 362 and 79 of 609 line pixels.
- The sphere model is local by construction and keeps its misses.
- The reference drops balls on front-facing samples (`FACING_SLACK`), so it is biased
  against envelope pixels that only a front-facing point reaches. Extra counts include some
  such pixels.

## Risks

- Cost lands on discarded fragments near the line's outer edge, which test every
  candidate. Round 2 measured about 31 candidates per fragment on a density-64 sphere with
  a 16 px line, where the cull removes only 16%.
- φ is not smooth at the bilinear map's cell edges (texel centres). The acceptance test
  copes, within the 12-iteration budget.

## Pressure-test results (round 1, 2026-11-20, on the first draft)

A fresh subagent built its own CPU harness (solved correction, ported wmax, depth test
against the flat base) and tested the first draft's claims.

- **Survived:**
  - ∇d = g/d and ∇²d = h/d − ggᵀ/d³.
  - Harness fidelity: extrusion, front-face culling as dot(n_g, D) > 0, pixel centres. Its
    emulation gave 511 missing / 529 extra against the GPU's 488 / 520.
  - Several starts are the main lever.
- **Broke:**
  - φ descent alone gains almost nothing (502 vs 511 missing). The width gradient is zero on
    painted plateaus and non-zero only in a band about one texel wide.
  - The hop-back clamp blocks legitimate returns (590 missing).
  - The first draft's start sets reach only about 260 missing, so "under 150" was
    unreachable with them.
  - The early 426 / 36 / 26 split of missing pixels came from a replay that started next to
    the brute-force closest triangle, not from the shell; 342 of the "426" were kept by it.
  - "pw differs by a few parts in a thousand": up to 3.7% here.
  - "Exit depth matters only behind nearby surfaces": inside the silhouette φ < 0 holds at
    once wherever the ray hits the surface, so the exit point alone decides visibility.
- **Minor:** bilinear filtering has a cross term in its Hessian, and the width is a product
  of bilinears (product rule needed; the harness's sampler has it).
- **Changes made:**
  - Dropped the hop-back clamp.
  - Replaced the start sets with two reach-culled shared-vertex rings, which the harness shows
    reach the oracle.
  - φ < 0 counts only inside the triangle.
  - r uses pixelWorld(p).
  - The fragment's own search runs first, to keep today's exit inside the silhouette.
  - Added the torus inner-contour check and the reference's facing bias to acceptance.

## Pressure-test results (round 2, 2026-11-20, on the revised design)

A second fresh subagent built a CPU torus emulator with every back-facing fragment, a
flat-base depth test and a union-of-balls oracle, plus dense-sphere variants.

- **Survived:**
  - Inner contours: early exit with the fragment's own search first matches today exactly
    on 8 torus configurations. Every miss there is a shell-coverage gap (now under Known
    limitations). Taking the minimum exit over all candidates is wrong under union
    semantics and adds 330–1600 extra pixels.
  - φ < 0 only inside the triangle: no loss (43 → 43 missing, 599 → 596 extra).
  - Two rings suffice even when the line is much wider than the triangles: a 16 px line on
    density 64 misses 11 of 1321 pixels with 2 rings, 5 with 3.
  - Ring-table size: about 38 entries per triangle.
- **Broke:**
  - The harness target: 43 missing used the fragment's pixel size; with pixelWorld(p) it is
    57 / 580.
  - The mirror lacked the inside-only rule and pixelWorld(p), and its fan walk stopped at
    16 triangles (73 instead of 103 at a density-16 pole).
  - Reach culling with the fragment's pixel size is not conservative once r uses
    pixelWorld(p) (20 of 16906 kept points exceeded it).
  - Binding count: the mesh layout is shared with the reference's compute pipeline, which
    already uses 8 storage buffers.
  - Cost: about 31 candidates per fragment on dense meshes with wide lines, 390 at a
    density-64 pole; 10 control-point loads per candidate for the box alone.
  - Acceptance: the primitive suite and the GPU-time scene were undefined.
- **Changes made:**
  - The mirror now implements the inside-only rule and pixelWorld(p), and uses the same
    precomputed ring table as the GPU, capped at 48.
  - The reach bound uses pixelWorld at the far side of the bounding sphere.
  - A per-triangle bounding sphere (one vec4) is tested before the box.
  - The ring table is fragment-only.
  - The acceptance cases are defined, with baselines measured before the change.
  - The torus shell-coverage gap is recorded as a known limitation.
- **Harness after the changes:** 57 missing / 580 extra, 3.6 searches and 18.7 iterations
  per fragment (sphere-only culling: 6.2 searches, 34 iterations).
