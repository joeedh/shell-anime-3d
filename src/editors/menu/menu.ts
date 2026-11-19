import { AreaFlags, Menu, nstructjs } from "../../pathux";
import { Editor } from "../editor_base";

/** Top menu bar: File and Edit. */
export class MenuBarEditor extends Editor {
  _height = 0;

  constructor() {
    super();
    this.borderLock = 1 | 2 | 4 | 8;
    this.areaDragToolEnabled = false;
  }

  init() {
    super.init();
    this.background = this.getDefault("AreaHeaderBG");

    const row = this.header!.row();
    row.menu("File", [
      ["New", () => void _appstate.newScene()],
      Menu.SEP,
      ["Open...", () => void _appstate.openSceneDialog()],
      ["Save Binary...", () => void _appstate.saveSceneDialog("binary")],
      ["Save JSON...", () => void _appstate.saveSceneDialog("json")],
    ]);
    row.menu("Edit", [
      ["Undo", () => void this.ctx.toolstack.undo(this.ctx), "CTRL-Z"],
      ["Redo", () => void this.ctx.toolstack.redo(this.ctx), "CTRL-SHIFT-Z"],
    ]);

    this.setCSS();
  }

  /** Pins the area to the header's height. */
  updateHeight() {
    if (!this.header) return;

    const rect = this.header.getClientRects()[0];
    if (rect) {
      this._height = rect.height;
    }

    const changed = this._height !== this.minSize[1];
    this.minSize[1] = this.maxSize[1] = this._height;

    if (changed && this.ctx?.screen) {
      this.ctx.screen.solveAreaConstraints();
    }
  }

  update() {
    super.update();
    this.updateHeight();
  }

  static define() {
    return {
      tagname: "sa3d-menu-editor-x",
      areaname: "sa3d_menu",
      uiname: "Menu Bar",
      icon: -1,
      flag: AreaFlags.HIDDEN | AreaFlags.NO_SWITCHER,
    };
  }
}
Editor.register(MenuBarEditor);
MenuBarEditor.STRUCT = nstructjs.STRUCT.inherit(MenuBarEditor, Editor, "sa3d.MenuBarEditor") + "\n}\n";
nstructjs.register(MenuBarEditor);
