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
