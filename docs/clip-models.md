# Clip models

How the shell pass decides which pixels belong to the outline, as the code stands now. The
concept is in `docs/shell-outline.md`. The history (why the models are built this way, what
was tried and rejected) is in `docs/plans/test-app.md` and `docs/plans/pn-envelope.md`.

## The question every model answers

- **The line:** the band of the offset surface that shows outside the base surface. A point p
  on the smooth surface carries a ball of radius r(p). A pixel belongs to the line if its view
  ray passes through some ball before it reaches the base surface.
- **The radius:** `r = w · pw`.
  - `w = R · lerp(G, B, 1 − |D · f|)` is the painted width in pixels. R, G and B are the
    paint-map channels, D is the view direction and f is the object's front axis.
  - `pw` is the world size of one pixel at the point's depth (or the ortho pixel size).
  - `targetWidthPx` in `common.wgsl` computes w; `envRadius` in `pn.wgsl` computes it with
    its gradient.
- **The shell is only a candidate set.** It is an inverted hull: front faces are culled and
  each vertex is pushed along its normal by `e = wmax · pixelWorld · (1 + c_rel) + c_abs`.
  - `wmax` is the vertex's largest painted width over its 1-ring (a GPU pass after every
    dab), so the shell is conservative.
  - `c_abs` and `c_rel` are the solved correction map (Solve Correction), which makes the
    shell reach the smooth contour plus the line width from every view.
  - Every back-facing shell fragment asks its clip model "keep or discard?". The model never
    adds pixels the shell does not cover.
- **Exit depth:** a kept fragment writes the depth where its ray leaves the offset surface,
  not the shell's depth, so nearer geometry occludes the line correctly.

The models, picked with Render → Clip Model (`settings.clipModel`):

| Value | Model             | Where                                                          |
| ----- | ----------------- | -------------------------------------------------------------- |
| 0     | Raw hull          | no test: every shell fragment is kept (the baseline)           |
| 1     | Osculating sphere | `sphereClip` in `shell.wgsl`, mirror `src/math/clip_sphere.ts` |
| 2     | PN envelope       | `pnEnvelope` in `pn.wgsl`, mirror `src/math/pn_envelope.ts`    |

The WGSL and TypeScript versions are line-for-line ports of each other. Change both.

## Model 1: osculating sphere

- **Per vertex** (vertex shader, view space): the algebraic sphere through the vertex P with
  normal N and mean curvature H, in APSS form (Guennebaud & Gross 2007):
  `s(x) = u0 + u·x + u4|x|²`, with `u4 = H/2`, `u = N − H·P`, `u0 = (H/2)|P|² − N·P`.
  - It degenerates smoothly to the tangent plane as H → 0, with no 1/H.
  - H is half the trace of the per-vertex curvature tensor (Rusinkiewicz 2004,
    `src/mesh/curvature.ts`).
- **Per fragment:**
  - The five coefficients are interpolated across the shell triangle. On a sphere every
    vertex gives the same sphere, so the result is exact there.
  - If `|u4| ≤ 5e-5` the sphere is treated as a plane and the fragment is kept; the base
    surface's depth hides what should not show.
  - Otherwise `C = −u / (2·u4)`, `R² = |C|² − u0/u4`, and the fragment is kept if
    `dist(ray, C) < R + r`.
  - r is the width at the fragment's own base point, at the fragment's pixel size.
- **Cost:** constant per fragment.
- **Weak spots:**
  - **It is local.** It sees only the fragment's own triangle and its own width. A pixel that
    only a wider neighbour's ball reaches is missed. On `tests/scenes/scene.sa3d` this
    loses about 980 pixels where the painted width changes sharply at a bulge, and no budget
    or tuning fixes it.
  - **One curvature.** Where the curvature across the contour differs from H (a cylinder or
    torus seen obliquely), the sphere bends the wrong amount, and the error grows with the
    shell's extrusion. The torus misses about 4200 pixels.

## Model 2: PN envelope

- **Surface:** each triangle's cubic PN patch (Vlachos et al. 2001), built from its corner
  positions and normals.
  - `MeshBuffers.buildPN` computes the 10 control points on the CPU (`pnControlPoints` in
    `src/math/pn.ts`) whenever the geometry changes. It stores them with the edge neighbours
    and a bounding sphere: 12 vec4s per triangle (`PN_STRIDE`, binding 5).
  - PN patches meet with only C0 continuity, so shared edges are slight creases.
- **The test:** keep the pixel if some patch point p inside its triangle has
  `φ(p) = d(p) − r(p) < 0`, where d is the distance from the ray and r is the painted
  radius at p. This is the exact envelope rule, not "is the closest point within its own
  radius". Those two differ wherever the width changes along the surface.
- **Per fragment** (`pnEnvelope(fragTri, O, D, pw)`, in world space):
  1. **Flat walk** (`pnFlatWalk`): from the fragment's triangle, hop across edges in the
     projection along D until the triangle contains the ray's footprint. The fragment's own
     triangle is often several edges behind the contour.
  2. **Search that triangle** (`envSearch`): Levenberg–Marquardt descent on φ.
     - ∇d = g/d and ∇²d = h/d − ggᵀ/d³, from the half-gradient g and half-Hessian h of d².
     - ∇r is the bilinear paint-map gradient (product rule over R and the G/B mix), chained
       through the triangle's UV Jacobian. r's Hessian is ignored.
     - A step is accepted only if φ drops. λ rises until the damped system is positive
       definite.
     - Leaving the triangle hops to the neighbour, carrying the overshoot across.
     - Budget: 12 iterations (`PN_ENV_ITER`) and 8 hops (`PN_ENV_HOPS`).
     - φ < 0 counts only inside a triangle (barycentrics ≥ −1e-6). Within the hop slack the
       point is on the extrapolated cubic, not on the surface.
  3. **Search the ring:** the triangles within two shared-vertex rings of the walk's
     triangle, in BFS order and capped at 48 (`triRings` in `src/mesh/adjacency.ts`,
     binding 6, fragment stage only). For each, with `reach = max(corner wmax) · pw`:
     - skip it if its bounding sphere is out of reach;
     - skip it if the 2D box of its control points, projected along D, is out of reach;
     - otherwise run `envSearch` from the ray's footprint clamped into it.
  4. **Stop at the first hit.** The exit depth is `t + √(r² − d²)` along the ray from that
     point.
- **Why the ring search:** a closest-point search stalls at the C0 creases, which are local
  minima of the distance along grazing rays. The point that actually reaches the pixel can
  be two triangles away from where the descent gives up.
- **Pixel size:** r uses the fragment's pw, not each point's own. On analytic primitives the
  reference is built on the true surface, not on the PN surface, so the compare also
  measures PN's shape error. The fragment sits behind the contour, so its pw is slightly
  larger, which covers that error. Using each point's pw exposed it as missing pixels.
- **Cost:** a kept fragment stops at its first hit, but a discarded fragment near the line's
  outer edge tests every ring candidate the culls let through. GPU time is at most 1.3× the
  old closest-point model's.
- **Weak spots:**
  - **Inner contours** lose about 10% of their pixels. Where a near contour passes in front of
    the body, the ray is still inside the shell layer when it reaches the base, so the
    near contour's shell produces no back-face fragment to test. It is a shell coverage
    gap, not a clip-model error.
  - **Sharp creases** (the cube): PN rounds edges differently from the butterfly reference,
    so "the smooth surface" is ambiguous there and both models miss thousands of pixels.
  - **Bilinear cell edges:** φ is not smooth where the paint map's bilinear cells meet. The
    12-iteration budget copes, and two isolated one-pixel holes remain at the
    `scene.sa3d` bulge.

## Current numbers

Missing / extra pixels against the reference, after Solve Correction (RTX 5050,
2026-11-20; the full tables are in `docs/plans/pn-envelope.md`):

| Case                         | Sphere model missing | PN missing / extra |
| ---------------------------- | -------------------- | ------------------ |
| `scene.sa3d`                 | 980                  | 38 / 2446          |
| UV sphere d16, 3 px          | —                    | 4 / 12848          |
| Torus d24, 3 px              | 4183                 | 50 / 3919          |
| Capsule d24, 3 px            | —                    | 3 / 2175           |
| Cube d8, 3 px                | 7268                 | 6279 / 27035       |
| UV sphere d64, pitch 0, 4 px | —                    | 76 / 920           |

- Extra pixels are mostly the shell's conservative margin past the true line. The reference
  also drops balls on front-facing samples (`FACING_SLACK`), which biases it against some
  envelope pixels, so part of "extra" is the reference's error.
- The compare pass loses the GPU device on density-64 meshes with lines of 8 px or more,
  so it cannot be used there (`docs/debugging.md`).

## Tests and tools

- `tests/clip_sphere.test.ts`: the sphere's construction, exactness on a faceted sphere, the
  flat-region fallback, and the silhouette error with estimated N and H.
- `tests/clip_pn.test.ts`: patch interpolation, derivatives against finite differences, and
  the contour found from shell fragments on spheres. It uses `pnClosest`, which the shell
  no longer calls.
- `tests/pn_envelope.test.ts` with `tests/harness/pn_scene.ts`: a CPU replay of the shell
  pass on `scene.sa3d` against a dense-sampling oracle and a saved GPU compare mask. It
  also pins the pixel that was debugged in RenderDoc.
- Debugging a pixel on the GPU: the compare pass and RenderDoc workflow in
  `docs/debugging.md` ("GPU debugging toolkit").
