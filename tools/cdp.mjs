/*
 * Minimal Chrome DevTools Protocol client for the running NW.js app.
 * Uses Node's built-in WebSocket; no Playwright.
 *
 *   node tools/cdp.mjs pages
 *   node tools/cdp.mjs eval "<expression>"     (awaits promises, prints JSON)
 *   node tools/cdp.mjs screenshot out.png
 *   node tools/cdp.mjs logs [seconds]          (console + exceptions after a reload)
 *   node tools/cdp.mjs reload
 *   node tools/cdp.mjs drag x0 y0 x1 y1 [steps] [button] [modifiers]
 *                                              (CSS px; button left|middle; modifiers bitmask)
 *   node tools/cdp.mjs key <key>
 *   node tools/cdp.mjs close
 *
 * Options: --port=9222
 */
import fs from "node:fs";

let port = 9222;
const argv = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith("--port=")) port = parseInt(a.slice(7));
  else argv.push(a);
}
const [cmd, ...rest] = argv;

async function listPages() {
  const resp = await fetch(`http://127.0.0.1:${port}/json/list`);
  return (await resp.json()).filter((t) => t.type === "page");
}

async function connect() {
  const pages = await listPages();
  const page = pages.find((p) => p.url.includes("index.html")) ?? pages[0];
  if (!page) throw new Error("no page target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
    } else {
      for (const l of listeners) l(msg);
    }
  };

  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  return { ws, send, listeners };
}

function fmtRemote(o) {
  if (o.type === "string") return o.value;
  if (o.value !== undefined) return JSON.stringify(o.value);
  return o.description ?? o.type;
}

async function main() {
  switch (cmd) {
    case "pages": {
      for (const p of await listPages()) console.log(p.id, p.url, p.title);
      return;
    }
    case "eval": {
      const { ws, send } = await connect();
      const r = await send("Runtime.evaluate", {
        expression: rest.join(" "),
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) {
        console.error("EXCEPTION:", r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        process.exitCode = 1;
      } else {
        const v = r.result.value;
        console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
      }
      ws.close();
      return;
    }
    case "screenshot": {
      const { ws, send } = await connect();
      const r = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(rest[0] ?? "screenshot.png", Buffer.from(r.data, "base64"));
      console.log("wrote", rest[0] ?? "screenshot.png");
      ws.close();
      return;
    }
    case "reload":
    case "logs": {
      const { ws, send, listeners } = await connect();
      const seconds = cmd === "logs" ? parseFloat(rest[0] ?? "4") : 0;
      listeners.push((msg) => {
        if (msg.method === "Runtime.consoleAPICalled") {
          const p = msg.params;
          console.log(`[${p.type}]`, p.args.map(fmtRemote).join(" "));
        } else if (msg.method === "Runtime.exceptionThrown") {
          const d = msg.params.exceptionDetails;
          console.log("[exception]", d.exception?.description ?? d.text);
        }
      });
      await send("Runtime.enable");
      await send("Page.enable");
      await send("Page.reload", { ignoreCache: true });
      await new Promise((r) => setTimeout(r, seconds * 1000));
      ws.close();
      return;
    }
    case "drag": {
      const { ws, send } = await connect();
      const [x0, y0, x1, y1] = rest.slice(0, 4).map(Number);
      const steps = parseInt(rest[4] ?? "10");
      const button = rest[5] ?? "left";
      const modifiers = parseInt(rest[6] ?? "0");
      const buttons = button === "middle" ? 4 : 1;
      const ev = (type, x, y, extra = {}) =>
        send("Input.dispatchMouseEvent", { type, x, y, button, modifiers, ...extra });
      await ev("mouseMoved", x0, y0, { button: "none" });
      await ev("mousePressed", x0, y0, { clickCount: 1, buttons });
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await ev("mouseMoved", x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, { buttons });
        await new Promise((r) => setTimeout(r, 16));
      }
      await ev("mouseReleased", x1, y1, { clickCount: 1, buttons: 0 });
      ws.close();
      return;
    }
    case "key": {
      const { ws, send } = await connect();
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: rest[0] });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: rest[0] });
      ws.close();
      return;
    }
    case "close": {
      const { ws, send } = await connect();
      await send("Runtime.evaluate", { expression: "nw.App.quit()" }).catch(() => {});
      ws.close();
      return;
    }
    default:
      console.log("usage: cdp.mjs pages|eval <expr>|screenshot [file]|logs [seconds]|reload|close");
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
