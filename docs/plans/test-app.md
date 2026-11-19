# Plan: shell-outline test app

Status: pressure-tested once (see "Pressure-test results" at the end); ready to implement.

The app tests the idea in `docs/shell-outline.md`: an inverted-hull shell that each fragment
trims against an analytic offset of the smooth surface. Requirements are listed in
`docs/test-app-requirements.md`. The app compares two clip models against a ground-truth
reference, on meshes the user can paint and sculpt.

## Decisions already made

- **Runtime:** NW.js running WebGPU. The SDK flavour of `nw` is a dev dependency.
- **UI:** path.ux, consumed as TypeScript source from a git submodule. Its ToolOp/ToolStack
  system handles all undo and redo.
- **Serialization:** nstructjs, from a git submodule of `github.com/joeedh/STRUCT`.
  - Files can be saved as binary or as JSON.
  - Both formats embed the `write_scripts()` dump, so migration code can see the schema the
    file was written with.
- **Clip models** (both live, switchable from the UI):
  1. **Osculating sphere.** An algebraic sphere is built per vertex from position, normal and
     mean curvature H.
  2. **PN-triangle patch.** The fragment rebuilds the smooth patch from its source triangle's
     positions and normals.
- **Ground-truth reference:** included in v1. Comparison output is an error heatmap plus
  missing/extra pixel counts.
- **Painted maps live in textures**, not per vertex. They are unwrapped by the app's own simple
  UV unwrapper and painted entirely on the GPU, with tile-based undo.
- **View-angle weight:** two painted scalars, `wFront` and `wProfile`. They are blended by the
  view direction in the object frame (see Width model).
- **Correction map:** per vertex, recomputed by a "Solve" button. Any sculpt stroke marks it
  stale.
- **Git:** commit straight to `master` (initial implementation).

## Repo layout

```
extern/nstructjs/        git submodule (github.com/joeedh/STRUCT)
extern/path.ux/          git submodule (github.com/joeedh/path.ux), recursive
app/                     NW.js app dir: package.json manifest, index.html, dist/
src/
  core/      app state, context, toolop undo patch, file I/O, settings
  mesh/      Mesh, primitives, adjacency, BVH, curvature, normals, butterfly subdivision
  uv/        chart creation, area-correction solver, packer
  paint/     paint textures, GPU brush, tile undo
  sculpt/    draw and smooth brushes
  gpu/       device setup, buffers, pipelines, WGSL sources
  render/    passes: base, shell, reference, compare
  solver/    correction-map solver
  editors/   path.ux areas: viewport, properties, menu bar
  math/      TS mirrors of the WGSL clip math (unit-testable)
tools/       build.mjs (esbuild), nw.mjs (launcher), cdp.mjs (DevTools-protocol client)
tests/       vitest
```

## Build and tooling

- **pnpm, single package.**
  - `pnpm-workspace.yaml` exists only for settings, such as build approval for `nw` and
    `esbuild`. Its package globs never include `extern/*`.
  - The root depends on `nstructjs` via `link:./extern/nstructjs`.
  - Dev tools: `esbuild`, `nw` (sdk), `typescript`/`tsgo`, `@webgpu/types`, `vitest`,
    `lintrix`, `@pathtx/prettier`.
- **Single nstructjs copy.**
  - path.ux imports a bare `"nstructjs"`, and nstructjs keeps its registry in a module-level
    `manager`, so two copies would mean two registries.
  - Fix: an esbuild `alias` points every import at `extern/nstructjs/build/nstructjs_es6.js`,
    which is committed and free of tinyeval/acorn.
  - For types, the `link:` dependency already resolves from `extern/path.ux` by walking up the
    directory tree. The package `types` points at `build/structjs.d.ts`. No tsconfig `paths`
    entry is needed.
  - Never run `pnpm install` inside `extern/path.ux`.
- **esbuild:** settings copied from path.ux's `buildtools/esbuild.mjs`.
  - `bundle`, `esm`, `es2022`, `treeShaking: false`.
  - `fs`, `path` and `electron` stay external.
  - WGSL files load as text.
- **Node modules at runtime.**
  - NW.js can't resolve bare ES-module specifiers like `import fs from "fs"`.
  - App code reaches Node only through `globalThis.require("fs")`, wrapped in
    `src/core/platform.ts`.
- **tsconfig:**
  - `target ES2022`, `moduleResolution bundler`, `strict`.
  - `lib: esnext, DOM, DOM.Iterable, esnext.disposable`.
  - Types from `@webgpu/types`.
- **NW.js:**
  - `app/package.json` is the manifest. `index.html` sets `window.haveNwjs = true` before
    `import("./dist/app.js")`.
  - `tools/nw.mjs` is adapted from path.ux's `buildtools/nwjs.mjs` and launches with
    `--remote-debugging-port`.
  - `tools/cdp.mjs` is a small DevTools-protocol client using Node 24's built-in `WebSocket`.
    It can evaluate, take screenshots and read console output, with no Playwright.
  - The `nw` version is pinned to whatever proves to have `navigator.gpu`. 0.112-sdk was
    verified on this machine; try 0.120 first and fall back.
- **Lint and format:** `lintrix.config.json` extends `lintrix:recommended`. Prettier is
  `@pathtx/prettier`.

## Data model

- **`Mesh`** (`sa3d.Mesh`):
  - Topology vertices: positions (`arraybuffer(float)`).
  - Triangles: vertex indices (`arraybuffer(int)`).
  - Per-corner UVs (`arraybuffer(float)`). UVs live on corners, so seams need no vertex
    splitting.
  - The correction map: `c_abs` and `c_rel` per vertex, `arraybuffer(float)`.
  - Primitive type and parameters.
  - `isAnalytic`: true for an unsculpted analytic primitive. Sculpting clears it.
  - Derived and not saved: normals, adjacency, BVH, the curvature tensor, PN control points,
    `wmax`.
- **`PaintMaps`** (`sa3d.PaintMaps`):
  - One `rgba16float` texture, default 1024².
  - Channels: R = line width (px at the reference height), G = `wFront`, B = `wProfile`,
    A = spare.
  - The CPU mirror is a `Uint16Array` of half floats (`arraybuffer(ushort)`). Every stroke end
    downloads its tiles, so the mirror stays exact.
- **`Scene`** (`sa3d.Scene`):
  - Holds the mesh, the maps, the camera, the object's front axis, and render/clip settings.
  - It is the nstructjs root and the path.ux data API root.
- **Naming:** all struct names are prefixed `sa3d.`.
- **Derived data after load:** rebuilt once the whole file has loaded, never in `loadSTRUCT`.
  Binary and JSON run migrations in different orders, so `loadSTRUCT` can't assume either.

## Primitives

- **Shapes:** cube (subdivided faces), UV sphere, icosphere, cylinder, torus.
- **Density:** each primitive has a density parameter.
- **Creases:** the cube has sharp creases, so it is the stress case for the smooth-surface
  assumption.
- **Analytic projection:** sphere, cylinder and torus keep analytic parameters so the
  reference can project onto the true surface.
- **Undo:** changing a primitive, its density, or re-unwrapping is an explicit ToolOp
  (`SetPrimitiveOp`, `UnwrapOp`). Its undo stores the whole previous mesh and paint mirror.
  It is not a data-path property edit, because undoing those would regenerate the mesh and
  lose sculpt and paint work.

## UV unwrapper (`src/uv/`)

1. **Charts:**
   - Each triangle goes to the cube face (±X/±Y/±Z) its normal is most aligned with.
   - Charts are the connected components within each face group.
   - Initial UVs come from the planar projection, which can't flip a triangle because
     n·axis ≥ 1/√3.
2. **Area correction:** a few rounds of local relaxation per chart.
   - Each triangle's target UV area is proportional to its 3D area.
   - Each vertex moves toward the average of the positions that match its incident triangles
     to their targets.
   - A round is reverted if it flips a triangle.
3. **Packing:**
   - Charts are scaled to a common texel density, then shelf-packed by bounding box,
     tallest first, into the unit square.
   - There is a gutter of at least 4 texels at 1024².
4. **Re-unwrap:** happens in `SetPrimitiveOp` and `UnwrapOp`, and resets paint (undoable).

## GPU painting (`src/paint/`)

- **Brush:**
  - A sphere in world space. The screen radius is converted at the hit point, which a CPU
    BVH raycast finds.
  - Channel (R/G/B), value, strength, falloff, mode (set, add, smooth).
- **Dab:**
  - The mesh is rendered in UV space into the paint texture, which is a render target.
  - Falloff comes from the 3D distance between the interpolated surface point and the brush
    center.
  - Blending is source-alpha, with a write mask on the selected channel.
  - Because falloff is 3D, both sides of a UV seam are painted.
  - Smooth mode reads a copy of the touched tiles.
- **Gutters:**
  - Dilation copies edge texels outward into the gutter.
  - It ping-pongs between a sampled copy and the target, because read-write `rgba16float`
    storage is not core WebGPU. It runs as a render pass into the target.
- **Tile undo:**
  - Tiles are 64×64.
  - Before each dab, the CPU computes the touched tile set from the UV bounding boxes of
    BVH triangles intersecting the brush sphere, **expanded by the gutter width** so
    dilation writes stay inside saved tiles.
  - Each tile seen for the first time in the stroke is copied (`copyTextureToTexture`) into a
    stroke-local "before" atlas first.
  - **At stroke end:** before and final tiles are copied to a buffer with
    `copyTextureToBuffer` (a 64-texel row is 512 B, which meets the 256 B alignment) and
    mapped. The op stores the readback **promise**, and `undo`/`redo` await it before
    touching anything.
  - **Cancel (Esc):** restores straight from the GPU atlas, which is still alive at that
    point.
  - `undo` uploads the before-tiles; the overridden `redo` uploads the final tiles. Both patch
    the CPU mirror.
  - `calcUndoMem` returns the tile bytes.
- **Per-vertex conservative width `wmax`:**
  - A compute pass computes it for each vertex: the maximum of R·max(G, B) over the texels
    in the UV bounding box of the vertex's 1-ring corners.
  - It runs after every dab on the touched vertices, so the shell never undershoots
    mid-stroke, whatever the brush mode.
  - On load and after unwrap it runs for all vertices.

## Sculpting (`src/sculpt/`)

- **Brushes:** draw (displace along the average normal, with falloff) and smooth (Laplacian
  toward the 1-ring centroid). Both run on the CPU, querying the BVH.
- **After each dab:**
  - Recompute normals for touched vertices plus their 1-ring.
  - Recompute the curvature tensor and the PN control points out to the **2-ring**, because
    face tensors depend on the neighbouring normals.
  - Refit the BVH and re-upload the affected buffer ranges.
- **Deferred to stroke end:** the reference-surface rebuild and the "correction map stale"
  flag. The reference rebuild is too slow to run per dab.
- **Undo:** `SculptStrokeOp` stores original and final positions for touched vertices.
- **Analytic flag:** a stroke clears `isAnalytic`.

## Width model

- **Target width at a surface point (px):**
  `w = R(uv) · lerp(G(uv), B(uv), 1 − |v_obj · f|)`.
  - `v_obj` is the view direction in the object frame and `f` is the object's front axis (a
    Scene setting, default +Y). G is `wFront`, B is `wProfile`.
  - Head-on (looking along f) gives `wFront`; side-on gives `wProfile`.
  - It can't be blended on `n·v`, which is 0 at every contour.
- **Converting px to world units:** `r = w · pixelWorld(z)`, where
  `pixelWorld(z) = 2·z·tan(fov/2)/H_ref` for perspective, `orthoHeight/H_ref` for
  orthographic, and `H_ref` is the reference resolution height (default 1080).
- `r` is the offset radius. The line is the band of the offset surface that is visible
  outside the base surface.

## Rendering (`src/render/`)

- **Vertex pulling:** all mesh passes read from storage buffers. A draw is non-indexed with
  3 vertices per triangle, and `tri = vertex_index / 3`. That gives every fragment its source
  triangle ID.
- **Buffer packing:** the default limit is 8 storage buffers per stage, so data is packed
  into 3 buffers:
  - **per-vertex record:** position, normal, H, `c_abs`, `c_rel`, `wmax`
  - **per-triangle record:** indices, corner UVs
  - **PN control points:** per triangle
- **Device limits:** the device still requests the adapter's
  `maxStorageBuffersPerShaderStage` for headroom.

Passes, in order:

1. **Base:** toon-shaded mesh, with an optional overlay of a painted channel. Writes the
   base depth.
2. **Shell (model line):**
   - Front faces are culled. Each vertex is extruded along its normal by
     `e = wmax(v)·pixelWorld(z)·(1 + c_rel(v)) + c_abs(v)`.
   - A per-vertex barycentric varying recovers the base point on the source triangle,
     using perspective-correct interpolation.
   - The active clip model's `clipKeep(...)` runs; rejected fragments are discarded.
   - Survivors write the line colour and 1 into a model mask (`r8unorm`).
   - **"Raw hull" model:** no clipping. This is the baseline.
3. **Reference:** described below. It renders its own base depth from the refined reference
   surface.
4. **Compare:** a full-screen pass.
   - Colours: black = both, red = in the reference but missing from the model, blue = extra
     in the model.
   - A compute pass counts each class with atomics; the counts show in the UI.

### Clip model 1: osculating (algebraic) sphere

- **Per vertex, in the vertex shader:** build the algebraic sphere through the vertex in view
  space, which keeps magnitudes small:
  `s(x) = (H/2)|x|² + (N − H·P)·x + (H/2·|P|² − N·P)`.
  - This is the APSS form (Guennebaud & Gross 2007). It degenerates smoothly to the tangent
    plane as H → 0, with no 1/H anywhere.
- **Fragment:**
  1. Linearly interpolate the 5 coefficients. Interpolating them, rather than a base point
     on the flat triangle, removes the faceting-sag error: on a sphere every vertex gives
     the same sphere, so the result is exact.
  2. If `|u4| > ε`, convert to center/radius and keep the fragment if
     `dist(ray, C) < R + r`.
  3. Otherwise, use the plane's ray test. A crossing counts as distance 0, so the fragment is
     kept and base depth occludes it.
- **Curvature:** the tensor is estimated per vertex by Rusinkiewicz (2004), and H = trace/2.
- **Known model limitation:** where the radial curvature differs from H (a cylinder seen
  obliquely), the sphere extrapolates with the wrong curvature, and more so the further the
  shell extrudes. The heatmap is supposed to show this; it is the gap the quadric model would
  close later.

### Clip model 2: PN-triangle patch

- **Precomputed per triangle:** the 10 cubic Bézier control points (Vlachos et al. 2001),
  refreshed by a compute pass after edits.
- **Per fragment:**
  1. Minimise `f(u,v) = |P⊥(B(u,v) − O)|²` (distance to the ray) from the base barycentrics.
     - Use **full-Hessian Newton with Levenberg-Marquardt damping**, keeping the best iterate,
       6 iterations.
     - Plain Gauss-Newton is singular at the contour, because det J ∝ N·D = 0 there.
  2. Barycentrics may extrapolate down to −0.5 for the geometry.
  3. The UV used to sample `r` is computed from barycentrics **clamped to the triangle**, so
     extrapolation never reads another chart or the gutter.
  4. Keep the fragment if `dist < r`.
- **Known approximation:** r is taken at the closest point, not as min over p of
  (dist − r(p)), so it's slightly off where width changes sharply.

### Ground-truth reference (WebGPU)

- **Definition:**
  - The line pixels are those where the ray **exits the first interval** of the union of
    balls `B(p, r(p))` (p on the smooth surface) before reaching the base surface.
  - The first-interval exit is the nearest ball far point that **no other ball contains**.
  - A ball's far point that lies inside a neighbouring ball isn't on the union's boundary and
    must be ignored. Without that check almost every pixel on a tilted surface would be
    flagged.
- **Reference surface:**
  - 3 levels of **modified butterfly** subdivision (Zorin et al. 1996) on the CPU, cached and
    rebuilt at stroke end.
  - Butterfly interpolates the mesh vertices. Loop doesn't, and shrinks the surface by more
    than a line width on typical meshes.
  - For an unsculpted analytic primitive, subdivided points are projected onto the true
    surface.
  - UVs are interpolated linearly per subdivided triangle.
  - The reference draws its own base depth from this refined mesh.
- **Sampling, per frame, in compute:**
  - Each refined triangle near a contour emits samples on a barycentric grid with **3D
    spacing h ≤ r/2**. The sag between balls is about h²/(8r) ≤ r/32.
  - "Near a contour" means `|n·v| < sqrt(2·r·κ_max) + margin`, using the triangle's maximum
    curvature.
  - Samples are appended atomically to a storage buffer and also inserted into a **spatial
    hash** with cell size equal to the maximum r. If either buffer overflows, the frame is
    flagged in the UI.
- **Impostors:**
  - Each sample becomes a screen-aligned quad drawn with `drawIndirect`.
  - The fragment shader computes the pixel ray's far intersection with its ball.
  - It **discards the point if any neighbouring sample's ball contains it** (a spatial hash
    lookup).
  - Otherwise it writes the point with `frag_depth`, using a `less` depth test into the
    reference depth texture.
  - The compare pass marks reference-line pixels where `refExit < refBaseDepth`.

## Correction-map solver (`src/solver/`)

- **Output:** two values per vertex.
  - `c_abs` (world units) covers faceting.
  - `c_rel` (a multiplier) covers curvature shrinkage, which is proportional to the extrusion.
- **Method:** CPU, in a worker.
  1. **Sampling by surface point, not by global view direction.** For each triangle, take M
     points (default 6). At each, take M′ view directions perpendicular to the reference
     normal there (default 8 around the tangent circle).
     - Every point is therefore tested while it is on a contour.
     - Global Fibonacci view sampling left vertices with no contour sample.
  2. For each (point, view) pair, measure the deficit: the screen-space reach the shell needs
     (r(p) beyond the smooth contour) minus the reach it has from the base triangle under p.
  3. Split the deficit:
     - the world-space offset between the mesh contour and the smooth contour goes to
       `c_abs`
     - the remaining relative shortfall goes to `c_rel`.
  4. Each vertex keeps the maximum over the samples on its incident triangles, plus a 5%
     safety band.
  5. Outputs are clamped to finite values; JSON turns NaN and ±Inf into 0.
- **Undo:** `SolveCorrectionOp` stores the old maps.

## path.ux integration (`src/core/`, `src/editors/`)

- **App state and context:**
  - `AppState` holds the `ToolStack`, the `DataAPI`, the screen, the scene and the GPU
    renderer.
  - `Context` subclasses with overlays, following path.ux's `example/core/context.ts`
    (including `toLocked`/`saveProperty`).
  - Call `toolstack.setRestrictedToolContext`.
- **Default undo:**
  - `ToolOp.prototype.undoPre`/`undo` are patched to whole-scene snapshots, without paint
    textures. This follows `example/core/toolop.ts`, because path.ux's
    `setDefaultUndoHandlers` is dead code.
  - Paint, sculpt, primitive, unwrap and solve ops override both hooks.
  - Each op overrides `calcUndoMem`.
- **Editors:**
  - Menu bar: File (New, Open, Save binary, Save JSON), Edit (Undo, Redo).
  - Viewport: a WebGPU canvas. Camera ops are `NO_UNDO` modal ops; strokes are modal ToolOps
    that use the `on_pointer*` handler names.
  - Properties: primitive and density, brush, clip model, front axis, render toggles,
    solver, and stats.
- **Rendering loop:** driven by `requestAnimationFrame` from the app, because the Screen
  doesn't call `draw()` itself.
- **Startup:**
  - `nstructjs.validateStructs()`.
  - The icon sheet from `simple.loadDefaultIconSheet()`.
  - path.ux's default theme.

## Serialization (`src/core/fileio.ts`)

- **Binary:** `nstructjs.filehelper.FileHelper`.
  - Magic `SA3D`, plus a version.
  - It embeds `write_scripts()` and threads the version into migration.
  - Blocks: `SCEN` (the Scene), and optionally `SCRN` (the path.ux screen).
  - Bytes read with `fs.readFileSync` are copied into a fresh `ArrayBuffer` first, because
    `FileHelper.read` ignores `byteOffset`.
- **JSON:**
  `{ magic: "SA3D", version: [maj, min, mic], structScripts: write_scripts(), scene:
  writeJSON(scene) }`.
  - Load runs
    `readJSON(json.scene, Scene, { version: filehelper.versionToInt(json.version) })`.
    `MigrateOptions.version` must be a number; an array silently disables every guard.
  - `structScripts` is kept so migration code can parse the old schema when needed.
- **Migration pattern:**
  - `docs/file-format.md` documents how to bump the version.
  - Rule: one `migrateSTRUCT` guard per historical step, and always call the finisher.
  - Write migrations to work on both a half-loaded instance (binary) and raw JSON.
- **Size:** a 1024² map is about 24.5 MB as JSON (measured), so JSON is for debugging and
  diffing.

## Testing

- **vitest, for everything except the GPU:**
  - Mesh adjacency.
  - Curvature on a sphere (exact H) and a cylinder (`k1 = 1/R`, `k2 = 0`).
  - The unwrapper: no flips, charts inside [0,1]², no overlap.
  - Butterfly: it interpolates the original vertices.
  - PN evaluation, and LM convergence on the cylinder case that defeated Gauss-Newton.
  - The `math/` mirrors of both clip tests, including a 16-segment sphere where the
    algebraic sphere must match the exact contour.
  - The reference's first-interval-exit logic on a 1D/2D CPU mirror.
  - Solver coverage: every vertex receives samples.
  - Tile-set computation including the gutter expansion.
  - Binary and JSON round trips, plus a migration test with a v1 fixture on both paths.
- **WGSL:** the clip math is ported line for line from `src/math/`. A debug "probe pixel"
  mode reads back a pixel's GPU result next to the TS result.

## Milestones (each one commits)

Status: 1-5 done.

1. [done] Scaffold: submodules, pnpm, esbuild, NW.js launcher, CDP tool, lint/format/tests, and a
   path.ux screen whose viewport clears a WebGPU canvas.
2. [done] Mesh, primitives (capsule replaces cylinder, so the reference can project onto it), camera, base render.
3. [done] Serialization, binary and JSON (native dialogs not yet clicked through by hand).
4. [done] UV unwrap, paint textures, GPU painting, tile undo, `wmax` compute. Curvature and butterfly modules landed early.
5. [done] Shell pass with the width model and the raw-hull baseline; curvature and the sphere model (with frag_depth from the exit point).
6. PN-patch model.
7. Butterfly reference, reference and compare passes, with stats.
8. Correction-map solver.
9. Sculpt brushes.

## Pressure-test results (round 1, 2026-11-19)

A fresh subagent was given this plan and the code, and tried to falsify it. Its experiment
scripts were scratch files and were not kept.

**Broke, and how the plan changed:**

- **Reference test.** "The nearest far point of any ball is before the base" over-flags
  pixels on tilted surfaces, because most far points lie inside neighbouring balls.
  - Change: first-interval exit using a spatial-hash containment check, with 3D spacing
    h ≤ r/2.
- **Loop reference surface.** Loop subdivision shrinks the surface by 2–19 px on typical
  meshes.
  - Change: modified butterfly, which interpolates the vertices, and the reference draws its
    own base depth.
- **Sphere model base point.** Interpolating S on the flat triangle loses the faceting sag
  (0.0085R at 32 segments, about a line width).
  - Change: interpolate algebraic-sphere coefficients, which also removes the 1/H blow-up
    near H = 0.
- **Gauss-Newton.** It is singular at the contour.
  - Change: full-Hessian Newton with LM damping, keeping the best iterate.
- **Blending on `n·v`.** It is 0 at every contour, so `wFront` was dead.
  - Change: blend on the view direction in the object frame against a front axis.
- **JSON migration version.** It must be an integer. Change: `filehelper.versionToInt`.
- **`import fs`.** Fails in NW.js. Change: `globalThis.require` behind `platform.ts`.
- **tsconfig `paths` to the `.js` build.** Fails type checking (TS7016). Change: rely on the
  `link:` dependency's `types`.
- **Primitive change by property edit.** Its undo would regenerate the mesh and lose sculpt
  and paint work. Change: explicit `SetPrimitiveOp` and `UnwrapOp` with full snapshots.
- **Minor:**
  - `FileHelper` lives under `nstructjs.filehelper`.
  - The CDP tool no longer needs Playwright.
  - `analyticDirty` was used inconsistently and is renamed to `isAnalytic`.

**Risky items folded in:**

- The undo/redo readback race: undo and redo await the readback promise, and cancel restores
  from the GPU atlas.
- Gutter writes outside the saved tiles: tile bounding boxes are expanded by the gutter.
- The storage-buffer limit: data is packed into 3 buffers.
- No read-write `rgba16float` storage: dilation ping-pongs.
- Binary and JSON run migrations in different orders: derived data is rebuilt after load.
- `FileHelper` ignores `byteOffset`: bytes are copied into a fresh buffer.
- NaN and ±Inf in JSON: solver outputs are clamped.
- Global view sampling left vertices without a contour sample: the solver samples per surface
  point.
- The reference cutoff ignored curvature: it now uses curvature.
- PN extrapolation could read another UV chart: barycentrics are clamped for UV sampling.
- Curvature could go stale: it is refreshed out to the 2-ring.
- The mid-stroke `wmax` rule was wrong for add and smooth modes: `wmax` is now a GPU compute
  pass per dab.
- The reference rebuild is too slow per dab: it is deferred to stroke end.
- Workspace globs: they exclude `extern/*`.

**Survived:**

- The committed nstructjs build is current and exports everything used here.
- `arraybuffer` round-trips through JSON (finite values).
- Binary migration through `FileHelper` and the embedded scripts works.
- path.ux bundles with the alias and no `node_modules` of its own.
- NW.js 0.112-sdk exposes `navigator.gpu` without flags here.
- `rgba16float` can be rendered and blended with a write mask, and its tile rows meet the
  copy alignment.
- `haveNwjs` set before the dynamic import works.
- ToolStack awaits async undo; a modal cancel calls undo, then pops the op.
- The planar projection can't flip a triangle.
- The `c_abs`/`c_rel` split is well defined.
- Barycentric recovery on the shell works through vertex pulling.

**Accepted as known limitations, to be measured rather than fixed:**

- The sphere model's isotropy error on anisotropic regions.
- PN's closest-point width approximation.
- Undershoot when the shell extrudes much further than r.

## Pressure-test results (round 2, 2026-11-19)

A second fresh subagent targeted the reference, the clip models, the solver and wmax. These
results override the sections above where they conflict.

**Broke, and how the plan changed:**

- **Fragment attribution (affects every model).**
  - The back-facing shell fragment covering a line pixel comes from a triangle about
    ψ ≈ √(2(e − s)/ρ) behind the contour, which is 2–5 edges on dense meshes when
    e = 2–4r.
  - PN extrapolation (even to −3) then discards 50–97% of the true line at 64–256 segments.
  - Change: **PN walks patches.** When Newton leaves the triangle, it hops to the edge
    neighbour's patch, using a per-triangle edge-adjacency buffer, and continues there.
    A walk takes at most 8 hops.
  - Change: **r is sampled at the model's closest point.** For PN that is the walked point.
    For the sphere model it is still the source fragment's base point: a known error for
    painted tapers that the heatmap will show.
  - Add a test at 128+ segments with e = 2r.
- **Depth at inner contours.**
  - The shell's back-face depth is about √(2ρe) behind the silhouette plane, but the true
    exit is √(2ρr) behind it. For e > r, a surface sitting in that window hides the line.
  - Raising c_abs/c_rel makes this worse.
  - Change: **the shell fragment writes `frag_depth`** from the clip model's exit point,
    the far intersection of the ray with the model's offset surface.
- **Reference false exits.**
  - First source: a grazing ray leaves through a sampling dimple between balls.
  - Second source: in hyperbolic regions, the containing ball can lie outside the sampled
    band.
  - Changes, validated at 5 extra and 21 missing pixels out of 5698:
    - Also discard a far point F if F + 2h·D is inside another ball.
    - Fill the containment hash from a band wider than the impostor band (cutoff + about
      2rκ_max).
    - Inflating the containment radius instead erases the real line, so don't.
- **Solver.**
  - Point sampling misses the worst faceting deficit, which is in the face-normal
    direction: 6 points capture only 75% of it.
  - "Reach from the base triangle under p" is ill-defined (see attribution above).
  - Changes:
    - Define reach as the support of the shell's projection: max over nearby vertices of
      (x_i + e_i·N_i)·n⊥.
    - Always sample each face's normal direction.
    - Divide the faceting term by the projection factor N_i·n before storing it as `c_abs`.

**Risky items folded in:**

- **Sphere model:**
  - Where H ≤ 0 it degenerates to the raw hull. That is expected, and the heatmap will show
    it.
  - Use ε = 5e-5 on |u4| in view space; that was measured as the f32-safe threshold.
- **The 16-segment sphere test** uses estimated N and H, not analytic ones. Expect about a
  1 px contour shift at 16 segments and much less at 32+.
- **Impostor quads:** sized from the exact projected-sphere bounds. A screen-aligned r/z
  quad under-covers by up to 1.37× at the corners.
- **Sample cost:**
  - h has a floor of 0.5 px.
  - The hash has one level per r class (so cost doesn't scale with r_max/r_min squared).
  - The sag is h²/(4r) on a square grid, not h²/(8r).
- **wmax:** per-triangle bounding boxes with 1 texel of slack (already the case). Painted
  values are clamped to at least 0 where read.

**Open decision (user):**

- Where two sheets of the surface come within r of each other, union-of-balls ("the line
  merges") and per-sheet hulls ("each sheet keeps its own line") disagree.
- They differed on 20–60% of the band in a torso-over-arm test.
- Options:
  - limit containment to geodesic neighbours (per-sheet)
  - add an "ambiguous" class to the compare pass
  - accept the union.
- Until decided: the union, with ambiguous pixels flagged if that is cheap.

**Survived:**

- The first-interval-exit equivalence (given the full ball set).
- Edge-duplicate samples (exactly one survives).
- The algebraic-sphere Pratt norm (|N|² = 1 per vertex; interpolated 0.88–1, never
  imaginary).
- Interpolating in view space is valid.
- f32 thresholds at the stated ε.
- The 1-ring wmax bound.
- Perspective handling in the per-pixel tests.
