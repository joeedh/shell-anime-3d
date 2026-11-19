import { HotKey, KeyMap, Screen, UIBase, nstructjs } from "../pathux";

export class AppScreen extends Screen {
  constructor() {
    super();

    this.keymap = new KeyMap([
      new HotKey("Z", ["ctrl"], () => void _appstate.toolstack.undo()),
      new HotKey("Z", ["ctrl", "shift"], () => void _appstate.toolstack.redo()),
      new HotKey("Y", ["ctrl"], () => void _appstate.toolstack.redo()),
    ]);
  }

  static define() {
    return { tagname: "sa3d-screen-x" };
  }
}
AppScreen.STRUCT = nstructjs.STRUCT.inherit(AppScreen, Screen, "sa3d.AppScreen") + "\n}";
nstructjs.register(AppScreen);
UIBase.register(AppScreen);
