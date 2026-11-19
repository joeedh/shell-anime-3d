import { Area, Context, ContextFlags, ContextOverlay, getLastToolStruct, sendNote } from "../pathux";
import type { ContextLike, DataAPI, ToolStack } from "../pathux";
import type { AppState } from "./app";
import type { Scene } from "./scene";
import type { AppScreen } from "../editors/screen";
import { ViewportEditor } from "../editors/viewport/viewport";
import { Editor } from "../editors/editor_base";

/** The context members tools and editors read; forwarded from the overlays below. */
export interface AppContext extends ContextLike<AppState, ToolStack> {
  scene: Scene;
  viewport: ViewportEditor | undefined;
}

export class BaseOverlay extends ContextOverlay {
  static contextDefine() {
    return { name: "base", flag: 0 };
  }

  get toolstack() {
    return (this.state as AppState).toolstack;
  }

  get api() {
    return (this.state as AppState).api;
  }

  /** Used by path.ux's tool system (see buildToolSysAPI). */
  get toolDefaults() {
    return this.api.toolDefaults;
  }

  toolDefaults_save() {
    return this.toolDefaults;
  }

  toolDefaults_load() {
    return this.toolDefaults;
  }

  get last_tool() {
    return getLastToolStruct(this as unknown as ContextLike);
  }

  get scene() {
    return (this.state as AppState).scene;
  }

  get viewport() {
    return Area.getActiveArea(ViewportEditor);
  }

  viewport_save() {
    return Area.getActiveArea(ViewportEditor);
  }

  viewport_load(_ctx: unknown, data: unknown) {
    return data;
  }
}
Context.register(BaseOverlay);

export class ViewOverlay extends ContextOverlay {
  static contextDefine() {
    return { name: "view", flag: ContextFlags.IS_VIEW };
  }

  get screen() {
    return (this.state as AppState).screen;
  }

  get editor() {
    return Area.getActiveArea();
  }
}
Context.register(ViewOverlay);

export class ContextBase extends Context {
  declare state: AppState;
  declare api: DataAPI;
  declare toolstack: ToolStack;
  declare screen: AppScreen;
  declare scene: Scene;
  declare viewport: ViewportEditor | undefined;

  /** Editors are saved by area id so a locked (undo) context never holds a stale one. */
  saveProperty(k: string) {
    const v = (this as unknown as Record<string, unknown>)[k];
    if (v instanceof Editor) {
      return ["Editor", k, v._area_id];
    }
    return ["object", k];
  }

  loadProperty(ctx: unknown, _key: string, data: unknown) {
    const arr = data as [string, string, number?];
    const context = ctx as ContextLike & Record<string, unknown>;

    if (arr[0] === "Editor") {
      for (const sarea of context.screen.sareas) {
        for (const area of sarea.editors) {
          if (area._area_id === arr[2]) {
            return area;
          }
        }
      }
    }
    return context[arr[1]];
  }

  report(message: string, color = "orange", timeout?: number) {
    sendNote(this.state.screen!, message, color, timeout);
  }
}

export class ToolContext extends ContextBase {
  constructor(appstate: AppState) {
    super(appstate);
    this.reset();
  }

  reset(haveNewFile = false) {
    super.reset(haveNewFile);
    this.pushOverlay(new BaseOverlay(this.state));
  }
}

export class ViewContext extends ContextBase {
  constructor(appstate: AppState) {
    super(appstate);
    this.reset();
  }

  reset(haveNewFile = false) {
    super.reset(haveNewFile);
    this.pushOverlay(new BaseOverlay(this.state));
    this.pushOverlay(new ViewOverlay(this.state));
  }
}
