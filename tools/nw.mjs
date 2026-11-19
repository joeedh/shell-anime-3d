/*
 * Launches app/ under NW.js with the Chrome DevTools Protocol enabled.
 * Adapted from path.ux's buildtools/nwjs.mjs.
 *
 *   node tools/nw.mjs [--port=9222] [--no-wait] [--devtools] [--igpu] [--renderdoc]
 *                     [-- <extra chromium args>]
 *
 * --igpu       let Chromium pick the GPU (on hybrid laptops that is the integrated one;
 *              without this flag the high-performance GPU is forced)
 * --renderdoc  launch under RenderDoc with Dawn's injection toggle, capturing every
 *              presented frame into .gpu-captures/ (use tools/rd.mjs to take and read one)
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
let igpu = false;
let renderdoc = false;
const extraArgs = [];

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--port=")) {
    port = parseInt(arg.slice("--port=".length));
  } else if (arg === "--no-wait") {
    wait = false;
  } else if (arg === "--devtools") {
    devtools = true;
  } else if (arg === "--igpu") {
    igpu = true;
  } else if (arg === "--renderdoc") {
    renderdoc = true;
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

// keep rendering and input alive when the window is occluded, so CDP automation works
// while other windows cover it (Windows occlusion detection otherwise marks it hidden)
const args = [
  appDir,
  `--remote-debugging-port=${port}`,
  "--disable-features=CalculateNativeWinOcclusion",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
];
if (devtools) {
  args.push("--auto-open-devtools-for-tabs");
}
// Chromium on Windows ignores powerPreference, so WebGPU otherwise gets the integrated GPU
if (!igpu) {
  args.push("--force_high_performance_gpu");
}
if (renderdoc) {
  // Dawn's documented RenderDoc recipe (docs/dawn/debugging.md), plus HLSL debug info with
  // WGSL names so the pixel debugger shows source-level locals
  args.push(
    "--no-sandbox",
    "--disable-gpu-sandbox",
    "--disable-gpu-watchdog",
    "--disable-direct-composition",
    "--enable-dawn-features=enable_renderdoc_process_injection,emit_hlsl_debug_symbols,disable_symbol_renaming",
  );
}
args.push(...extraArgs);

console.log(`Launching NW.js: ${nwPath}`);
console.log(`  CDP: http://127.0.0.1:${port}`);

let child;
if (renderdoc) {
  const rdDir = process.env.RENDERDOC_DIR ?? "C:/Program Files/RenderDoc";
  const capDir = path.join(root, ".gpu-captures");
  fs.mkdirSync(capDir, { recursive: true });
  console.log(`  RenderDoc: every frame is captured into ${capDir}`);
  child = spawn(
    path.join(rdDir, "renderdoccmd.exe"),
    ["capture", "--opt-hook-children", "-w", "-c", path.join(capDir, "frame"), nwPath, ...args],
    { stdio: "inherit", env: { ...process.env, RENDERDOC_HOOK_EGL: "0" } },
  );
} else {
  child = spawn(nwPath, args, { stdio: "inherit" });
}
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
