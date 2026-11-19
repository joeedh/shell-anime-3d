# Debugging guide

Running notes on how to diagnose problems in this project. Add an entry whenever a bug
took real effort to find, or when you learn a diagnostic technique worth reusing.

## Entry format

- **Symptom:** what you saw
- **Cause:** what was actually wrong
- **Fix:** what changed (commit hash if useful)
- **How to spot it next time:** the check, log, or tool that reveals it

## Entries

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
