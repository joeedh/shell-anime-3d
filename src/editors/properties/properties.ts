import { nstructjs } from "../../pathux";
import { Editor } from "../editor_base";

/** Side panel holding scene, brush and render settings. */
export class PropertiesEditor extends Editor {
  init() {
    super.init();

    const c = this.container;
    const render = c.panel("Render");
    render.prop("scene.settings.clipModel");
    render.prop("scene.settings.showReference");
    render.prop("scene.settings.showCompare");
    render.prop("scene.settings.refHeight");

    this.setCSS();
  }

  static define() {
    return {
      tagname: "sa3d-properties-editor-x",
      areaname: "sa3d_properties",
      uiname: "Properties",
      icon: -1,
    };
  }
}
Editor.register(PropertiesEditor);
PropertiesEditor.STRUCT =
  nstructjs.STRUCT.inherit(PropertiesEditor, Editor, "sa3d.PropertiesEditor") + "\n}\n";
nstructjs.register(PropertiesEditor);
