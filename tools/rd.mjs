/*
 * RenderDoc frame capture and replay queries for the running app.
 *
 *   pnpm run start -- --renderdoc          launch under RenderDoc (captures every frame)
 *   node tools/rd.mjs capture [--setup "<js>"] [-o file.rdc]
 *       run <js> in the app (awaited), present one frame, keep its capture
 *       (default .gpu-captures/latest.rdc) and delete the other per-frame captures
 *   node tools/rd.mjs actions [file.rdc]
 *       list draws, dispatches, clears, copies and presents with their event ids
 *   node tools/rd.mjs pick <eid> <x> <y|y0:y1> [file.rdc]
 *       render-target values after event <eid> at a pixel or a column range
 *   node tools/rd.mjs debug <eid> <x> <y> [filter,filter...] [file.rdc]
 *       step the pixel shader for the last fragment at (x, y) in event <eid> and print the
 *       final value of each source-level local (names come from Dawn's HLSL, which keeps
 *       WGSL names under disable_symbol_renaming); filters keep names containing them
 *
 * Pixel coordinates are render-target pixels (CSS pixels times devicePixelRatio).
 * The queries run inside qrenderdoc's embedded Python (tools/rd/rdtool.py).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const capDir = path.join(root, ".gpu-captures");
const rdDir = process.env.RENDERDOC_DIR ?? "C:/Program Files/RenderDoc";
const latest = path.join(capDir, "latest.rdc");

const [cmd, ...rest] = process.argv.slice(2);

function cdpEval(expr) {
  const res = spawnSync(process.execPath, [path.join(root, "tools", "cdp.mjs"), "eval", expr], {
    encoding: "utf8",
    timeout: 120000,
  });
  if (res.status !== 0) throw new Error(`cdp eval failed: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

const frameFiles = () =>
  fs.existsSync(capDir)
    ? fs.readdirSync(capDir).filter((f) => f.startsWith("frame") && f.endsWith(".rdc"))
    : [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function capture(args) {
  let setup;
  let out = latest;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--setup") setup = args[++i];
    else if (args[i] === "-o") out = path.resolve(args[++i]);
  }
  if (setup) cdpEval(`(async () => { ${setup}; })()`);
  // let frames triggered by the setup land before taking ours
  await sleep(1500);
  const before = new Set(frameFiles());
  cdpEval("(window.redraw_all(), 1)");

  const deadline = Date.now() + 30000;
  let file;
  while (Date.now() < deadline) {
    file = frameFiles().find((f) => !before.has(f));
    if (file) break;
    await sleep(200);
  }
  if (!file) {
    throw new Error("no new capture appeared; was the app launched with `pnpm run start -- --renderdoc`?");
  }
  // wait for RenderDoc to finish writing
  let size = -1;
  for (;;) {
    await sleep(300);
    const s = fs.statSync(path.join(capDir, file)).size;
    if (s === size && s > 0) break;
    size = s;
  }
  fs.copyFileSync(path.join(capDir, file), out);
  // every presented frame is captured; keep only the one asked for
  for (const f of frameFiles()) fs.rmSync(path.join(capDir, f), { force: true });
  console.log(`captured ${out} (${(size / 1e6).toFixed(1)} MB)`);
}

function query(env) {
  const outFile = path.join(os.tmpdir(), `rdtool-${process.pid}.txt`);
  const res = spawnSync(
    path.join(rdDir, "qrenderdoc.exe"),
    ["--python", path.join(root, "tools", "rd", "rdtool.py")],
    {
      env: { ...process.env, ...env, RD_OUT: outFile },
      timeout: 600000,
    },
  );
  if (!fs.existsSync(outFile)) {
    throw new Error(`qrenderdoc produced no output (status ${res.status})`);
  }
  process.stdout.write(fs.readFileSync(outFile, "utf8"));
  fs.rmSync(outFile, { force: true });
}

const capArg = (a) => path.resolve(a ?? latest);

switch (cmd) {
  case "capture":
    await capture(rest);
    break;
  case "actions":
    query({ RD_CMD: "actions", RD_CAP: capArg(rest[0]) });
    break;
  case "pick": {
    const [eid, x, y, file] = rest;
    query({ RD_CMD: "pick", RD_EID: eid, RD_X: x, RD_Y: y, RD_CAP: capArg(file) });
    break;
  }
  case "debug": {
    const [eid, x, y, ...more] = rest;
    const file = more.find((a) => a.endsWith(".rdc"));
    const filter = more.find((a) => !a.endsWith(".rdc")) ?? "";
    query({ RD_CMD: "debug", RD_EID: eid, RD_X: x, RD_Y: y, RD_FILTER: filter, RD_CAP: capArg(file) });
    break;
  }
  default:
    console.log("usage: node tools/rd.mjs capture|actions|pick|debug ... (see the header of this file)");
    process.exit(1);
}
