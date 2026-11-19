import {
  IconManager,
  ToolStack,
  UIBase,
  contextWrangler,
  nstructjs,
  setIconManager,
  setIconMap,
  simple,
} from "../pathux";
import type { ContextLike, DataAPI } from "../pathux";
import "./undo";
// Side-effect imports: these modules register elements, areas and structs, and
// esbuild drops an import whose bindings are only used as types.
import "../editors/screen";
import "../editors/menu/menu";
import "../editors/viewport/viewport";
import "../editors/properties/properties";
import "../mesh/mesh_ops";
import { defineAPI } from "./api";
import { ToolContext, ViewContext } from "./context";
import { Scene } from "./scene";
import { AppScreen } from "../editors/screen";
import { MenuBarEditor } from "../editors/menu/menu";
import { ViewportEditor } from "../editors/viewport/viewport";
import { PropertiesEditor } from "../editors/properties/properties";
import { Renderer } from "../render/renderer";
import { initGPU } from "../gpu/device";
import { nodeFs, pickOpenPath, pickSavePath } from "./platform";
import { readSceneAuto, writeSceneBinary, writeSceneJSON } from "./fileio";

export class AppState {
  toolstack = new ToolStack();
  api: DataAPI;
  scene = new Scene();
  renderer = new Renderer();
  viewctx: ViewContext;
  toolctx: ToolContext;
  screen: AppScreen | undefined;

  constructor() {
    this.api = defineAPI();
    this.viewctx = new ViewContext(this);
    this.toolctx = new ToolContext(this);
    this.toolstack.setRestrictedToolContext(this.toolctx as unknown as ContextLike);
  }

  /** Swaps in a new document; resetUndo clears history (new file / file load). */
  setScene(scene: Scene, resetUndo: boolean) {
    this.scene = scene;
    if (resetUndo) {
      this.toolstack.reset();
    }
    this.api.notifyChange();
    window.redraw_all();
  }

  newScene() {
    this.setScene(new Scene(), true);
  }

  loadSceneFile(path: string) {
    const fs = nodeFs();
    if (!fs) throw new Error("File access needs NW.js");
    this.setScene(readSceneAuto(fs.readFileSync(path)), true);
  }

  saveSceneFile(path: string, format: "binary" | "json") {
    const fs = nodeFs();
    if (!fs) throw new Error("File access needs NW.js");
    const data = format === "json" ? writeSceneJSON(this.scene) : writeSceneBinary(this.scene);
    fs.writeFileSync(path, data);
  }

  async openSceneDialog() {
    const path = await pickOpenPath(".sa3d,.json");
    if (!path) return;
    try {
      this.loadSceneFile(path);
    } catch (error) {
      console.error(error);
      this.viewctx.report(`Could not open ${path}: ${(error as Error).message}`, "red");
    }
  }

  async saveSceneDialog(format: "binary" | "json") {
    const name = format === "json" ? "scene.sa3d.json" : "scene.sa3d";
    const path = await pickSavePath(name, format === "json" ? ".json" : ".sa3d");
    if (!path) return;
    try {
      this.saveSceneFile(path, format);
      this.viewctx.report(`Saved ${path}`, "green");
    } catch (error) {
      console.error(error);
      this.viewctx.report(`Could not save ${path}: ${(error as Error).message}`, "red");
    }
  }

  genScreen() {
    const screen = UIBase.createElement<AppScreen>("sa3d-screen-x");
    this.screen = screen;
    screen.ctx = this.viewctx as unknown as ContextLike;

    const viewArea = screen.newScreenArea();
    viewArea.switch_editor(ViewportEditor);
    screen.add(viewArea);

    const menuArea = screen.splitArea(viewArea, 0.05, true);
    viewArea.switchEditor(MenuBarEditor);
    // splitArea returns the new lower area; the original (now top) holds the menu
    screen.splitArea(menuArea, 0.75, false).switchEditor(PropertiesEditor);

    screen.solveAreaConstraints();
    screen.regenBorders();
    screen.update();
    screen.setCSS();
    return screen;
  }

  start() {
    const screen = this.genScreen();
    document.body.appendChild(screen);
    screen.update();
    screen.listen();
  }
}

function setupIcons() {
  const sheet = simple.loadDefaultIconSheet();
  const sizes: [number, number][] = [
    [32, 16],
    [32, 32],
    [32, 48],
  ];
  setIconManager(new IconManager([sheet, sheet, sheet], sizes, 16));
  setIconMap(simple.Icons);
}

function showFatal(message: string) {
  const div = document.createElement("div");
  div.style.cssText = "position:fixed;inset:0;padding:2em;font:16px sans-serif;background:#fee;color:#600";
  div.textContent = message;
  document.body.appendChild(div);
}

export async function start() {
  try {
    await initGPU();
  } catch (error) {
    showFatal(String(error));
    throw error;
  }

  setupIcons();
  window._appstate = new AppState();
  nstructjs.validateStructs();

  let animreq: number | undefined;
  window.redraw_all = () => {
    if (animreq !== undefined) return;
    animreq = requestAnimationFrame(() => {
      animreq = undefined;
      for (const sarea of _appstate.screen?.sareas ?? []) {
        sarea.draw?.();
      }
    });
  };

  contextWrangler.reset();
  _appstate.start();
  window.redraw_all();
}
