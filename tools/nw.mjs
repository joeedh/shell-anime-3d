/*
 * Launches app/ under NW.js with the Chrome DevTools Protocol enabled.
 * Adapted from path.ux's buildtools/nwjs.mjs.
 *
 *   node tools/nw.mjs [--port=9222] [--no-wait] [--devtools] [-- <extra chromium args>]
 *
 * Drive the running app with `node tools/cdp.mjs <command>`.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "app");

let port = 9222;
let wait = true;
let devtools = false;
const extraArgs = [];

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--port=")) {
    port = parseInt(arg.slice("--port=".length));
  } else if (arg === "--no-wait") {
    wait = false;
  } else if (arg === "--devtools") {
    devtools = true;
  } else if (arg !== "--") {
    extraArgs.push(arg);
  }
}

if (!fs.existsSync(path.join(appDir, "dist", "app.js"))) {
  const res = spawnSync(process.execPath, [path.join(root, "tools", "build.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

const nwModule = await import("nw");
const findpath = nwModule.findpath ?? nwModule.default.findpath;
const nwPath = await findpath("nwjs", { flavor: "sdk" });

if (!fs.existsSync(nwPath)) {
  console.error(`NW.js binary missing: ${nwPath}; run \`pnpm rebuild nw\`.`);
  process.exit(1);
}

const args = [appDir, `--remote-debugging-port=${port}`];
if (devtools) {
  args.push("--auto-open-devtools-for-tabs");
}
args.push(...extraArgs);

console.log(`Launching NW.js: ${nwPath}`);
console.log(`  CDP: http://127.0.0.1:${port}`);

const child = spawn(nwPath, args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));

if (wait) {
  const deadline = Date.now() + 30000;
  let version;
  while (Date.now() < deadline) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  console.log(version ? `CDP ready: ${version.Browser}` : "CDP endpoint did not come up within 30s.");
}
