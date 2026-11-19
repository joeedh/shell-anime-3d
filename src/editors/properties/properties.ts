import { nstructjs } from "../../pathux";
import { Editor } from "../editor_base";

/** Side panel holding scene, brush and render settings. */
export class PropertiesEditor extends Editor {
  init() {
    super.init();

    const c = this.container;

    const prim = c.panel("Mesh");
    prim.prop("scene.pendingPrimitive.type");
    prim.prop("scene.pendingPrimitive.density");
    prim.prop("scene.pendingPrimitive.radius");
    prim.prop("scene.pendingPrimitive.radius2");
    prim.tool("mesh.set_primitive()");

    const render = c.panel("Render");
    render.prop("scene.settings.clipModel");
    render.prop("scene.settings.showReference");
    render.prop("scene.settings.showCompare");
    render.prop("scene.settings.refHeight");
    render.prop("scene.settings.showWireframe");
    render.prop("scene.camera.ortho");
    render.prop("scene.camera.fovy");

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
