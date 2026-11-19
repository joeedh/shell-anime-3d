/*
 * Bundles src/main.ts into app/dist/app.js for NW.js.
 *
 *   node tools/build.mjs [--watch]
 *
 * Every import of "nstructjs" (ours and path.ux's) is aliased to the one committed
 * build in extern/nstructjs, so there is exactly one struct registry.
 */
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");

const options = {
  entryPoints: [{ in: path.join(root, "src/main.ts"), out: "app" }],
  outdir: path.join(root, "app/dist"),
  bundle: true,
  target: "es2022",
  format: "esm",
  sourcemap: "linked",
  treeShaking: false,
  external: ["fs", "path", "electron"],
  loader: { ".wgsl": "text" },
  jsx: "transform",
  jsxFactory: "jsx",
  jsxFragment: "Fragment",
  alias: {
    nstructjs: path.join(root, "extern/nstructjs/build/nstructjs_es6.js"),
  },
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
