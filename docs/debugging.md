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
