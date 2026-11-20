# Debugging guide

Running notes on how to diagnose problems in this project. Add an entry whenever a bug
took real effort to find, or when you learn a diagnostic technique worth reusing.

## Entry format

- **Symptom:** what you saw
- **Cause:** what was actually wrong
- **Fix:** what changed (commit hash if useful)
- **How to spot it next time:** the check, log, or tool that reveals it

## GPU debugging toolkit

Strategies, roughly cheapest first:

- **Compare pass.** Turn on Compare To Reference. Red pixels are missing from the model and
  blue pixels are extra; the counts sit in the viewport's corner. The reference is ground
  truth, so it finds wrong pixels without guessing where to look.
- **Colour-coded experiments.** In a fragment shader, disable clipping (or a single test)
  and write the quantity under suspicion as a colour, then `pnpm run cdp screenshot`. Good
  for seeing a field over the whole image, such as walk hop counts or `dist / r`.
- **CPU replays.** Copy GPU buffers back (`ReferencePass.debugRead()` is an example) and
  replay the per-pixel rule in doubles in a CDP eval. If the CPU result is right and the GPU
  result is wrong, suspect f32 precision (see "speckled holes" below).
- **RenderDoc pixel debugging.** Steps the real shader for one pixel and reports its WGSL
  locals by name:

  ```bash
  pnpm run start -- --renderdoc                          # captures every frame, ~9 MB each
  pnpm run rd capture --setup "_appstate.scene.settings.clipModel = 2"
  pnpm run rd actions                                    # event ids (base, shell, ...)
  pnpm run rd pick 33 1046 140:160                       # render targets after event 33
  pnpm run rd debug 33 1046 152 "pc.,pr,res.keep"        # locals at that pixel
  ```

  - Coordinates are render-target pixels: CSS pixels times `devicePixelRatio`.
  - `debug` reports each local's last assignment, so a loop variable shows its final
    iteration. For a mid-loop value, copy it into a new local or write it to an output.
  - Integers and booleans print as integers (`res.keep = [1]`).
  - Dawn's HLSL keeps WGSL names because of `disable_symbol_renaming`; nested struct values
    can still appear under generated names such as `v_11.dist`.
  - `rd capture` deletes every other per-frame capture in `.gpu-captures/`. Navigating the
    view while launched with `--renderdoc` fills the disk quickly.

- **GPU timing with Nsight Systems.** No setup in the app:

  ```bash
  nsys profile --trace=dx12 --duration=30 -o trace <nw.exe> app --force_high_performance_gpu
  nsys export --type sqlite -o trace.sqlite trace.nsys-rep   # DX12_WORKLOAD: per-submit GPU time
  ```

  It follows Chromium's child processes on its own and finds Dawn in the GPU process. It
  wants an administrator shell for its OS-level GPU-scheduling (`wddm`) and CPU traces.

### Nsight Graphics (2026.4): not working yet

- `ngfx-capture` injected into every NW.js process, but the app hung during startup and
  never presented a frame. That matches NVIDIA's forum reports for Chromium's Dawn backend.
- **`ngfx-capture` kills "interfering" applications** (it closed Steam) when its yes/no
  prompt gets no answer. Always pass `--no-block-on-interfering-application`.
- Nsight Graphics ships an MCP server, `ngfx-mcp.exe`, which has not been tried yet.

## Entries

## WebGPU runs on the integrated GPU

- **Symptom:** frame times several times slower than expected. Nsight tools see no GPU work
  from the app.
- **Cause:** on a hybrid laptop (Intel + RTX 5050 here), Chromium on Windows gives WebGPU the
  integrated GPU and ignores `powerPreference: "high-performance"`.
- **Fix:** `tools/nw.mjs` passes `--force_high_performance_gpu` unless run with `--igpu`.
- **How to spot it next time:**
  `node tools/cdp.mjs eval "(async () => (await navigator.gpu.requestAdapter()).info.vendor)()"`
  prints `intel`.

### Editor or screen class "is not a function" at startup

- **Symptom:** `TypeError: screen.newScreenArea is not a function` (or an editor that never
  appears). `document.createElement(tag)` returns a plain `HTMLElement`.
- **Cause:** the module that calls `UIBase.register` / `Area.register` was never bundled.
  `app.ts` imported the class but used it only as a type, so TypeScript semantics let
  esbuild drop the whole import.
- **Fix:** import registering modules for their side effects (`import "../editors/screen";`)
  as well as for their bindings. `src/core/app.ts` keeps a block of these.
- **How to spot it next time:** `grep -n "register(ClassName)" app/dist/app.js` finds
  nothing. Or, in the page, `customElements.get("<tag>")` is undefined.

### CDP input events hang and the app stops redrawing

- **Symptom:** `node tools/cdp.mjs drag ...` never returns; `Input.dispatchMouseEvent` gets
  no response. Screenshots still work, but `requestAnimationFrame` redraws don't happen.
- **Cause:** Windows occlusion detection marked the NW.js window hidden
  (`document.visibilityState === "hidden"`) while other windows covered it. Chromium then
  throttles rendering and input.
- **Fix:** `tools/nw.mjs` launches with `--disable-features=CalculateNativeWinOcclusion`,
  `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding` and
  `--disable-background-timer-throttling`.
- **How to spot it next time:**
  `node tools/cdp.mjs eval "document.visibilityState"` prints `hidden`.

## `cdp logs` shows errors that were already fixed

- **Symptom:** after fixing a WGSL error and rebuilding, `pnpm run cdp logs` still prints the
  old error, even though the bundle contains the fixed shader.
- **Cause:** `Runtime.enable` replays the console messages already buffered for the page, so
  the output mixed messages from before the reload with messages from after it.
- **Fix:** `tools/cdp.mjs` ignores console events until `Runtime.enable` and `Page.enable`
  have returned, and only then reloads.
- **How to spot it next time:** grep `app/dist/app.js` for the fixed line. If the bundle is
  right and the log is not, the log is stale.

## WGSL: `from` is a reserved word

- **Symptom:** `Error while parsing WGSL: 'from' is a reserved keyword` on a parameter name.
- **Cause:** WGSL reserves many words that are ordinary identifiers in TypeScript, and
  `from` is one of them.
- **Fix:** rename. Check the WGSL spec's reserved-word list when porting TS to WGSL line for
  line.

## Reference line full of speckled holes

- **Symptom:** in compare mode the reference line had scattered missing pixels across the
  whole band. A CPU replay of the same balls and the same per-pixel rule, in doubles, had
  none.
- **Cause:** f32 cancellation. The impostor solved the ray-sphere intersection as
  `b*b - c` with `|O - C|^2` around 16 (the eye is about 4 units away). That put an error
  of about 0.5% of r into the far point F, far more than the containment tolerance, so real
  exits tested as "inside a neighbouring ball" and were discarded.
- **Fix:** `ref_draw.wgsl` computes F as an offset from the ball's center
  (`-perp + D * sqrt(r^2 - |perp|^2)`), and the containment test adds the small offsets
  `(p_own - p_j) + rel` instead of differencing absolute positions.
- **How to spot it next time:** holes that disappear when containment is disabled
  (`_appstate.renderer.reference.debugFlags = 2`) while the CPU replay shows none. Any
  test with a tolerance below about 1e-5 relative, on positions several units from the
  origin, needs relative coordinates in f32.

## PN outline loses whole segments on a sculpted mesh with painted width

- **Symptom:** in `tests/scenes/scene.sa3d`, the outline breaks where a wide painted patch
  crosses the silhouette of a sculpted bulge, with both clip models. Compare mode shows
  long red runs.
- **Cause:** two, in the PN model.
  - The fragment kept its pixel if the distance to the _closest_ patch point was below the
    radius _there_. The reference keeps it if _any_ point's ball reaches it, which is a
    farther point with a bigger radius where the width jumps.
  - PN patches are only C0, so along a grazing ray a shared edge can be its own local
    minimum of distance. At (1260, 660) the search bounced between triangles 676 and 677
    until its hop budget ran out; the right point was on 675.
- **Fix:** the envelope search in `pn_envelope.ts` / `pn.wgsl` (plan:
  `docs/plans/pn-envelope.md`). Missing PN pixels fell from 509 to 38. The sphere model is
  local by construction and keeps its misses there.
- **How to spot it next time:**
  - `pnpm run rd debug <shell event> x y "pc.,pr,hops"` on a red compare pixel: a search
    that ends with `hops` at its limit and a large `pc.dist` is stuck in the wrong basin.
  - For a search-quality question, use the CPU harness (`tests/pn_envelope.test.ts`). It
    emulates the shell pass against a saved compare mask and includes a dense-sampling
    oracle, which tells search failures apart from surface differences.
  - Clearing the width map (`scene.maps.clear()`) separates width-gradient problems from
    geometry problems.

## Compare mode loses the GPU device on dense meshes with wide lines

- **Symptom:** after turning on Compare To Reference, the stats never appear and the
  canvas freezes. No WebGPU error is logged (the device-lost message can come before a
  console hook is installed). `mapAsync` rejects with `[Device] is lost`.
- **Cause:** the reference pass takes too long and Windows resets the GPU. UV sphere
  density 64 survives a 4 px line, loses the device after one frame at 8 px, and loses it
  at once at 16 px.
- **Fix:** none yet; the acceptance runs use 4 px on that mesh.
- **How to spot it next time:** wrap `reference.readback.mapAsync` in a CDP eval and log
  the rejection; reload the app (`cdp reload`, then wait for `_appstate`) to get a new device.
