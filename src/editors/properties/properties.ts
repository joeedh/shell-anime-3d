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
    prim.tool("mesh.unwrap()");
    prim.tool("mesh.subdivide_smooth()");
    prim.tool("mesh.solve_correction()");
    prim.tool("mesh.clear_correction()");

    const brush = c.panel("Brush");
    brush.prop("scene.toolMode");
    brush.prop("scene.brush.mode");
    brush.prop("scene.brush.channel");
    brush.prop("scene.brush.value");
    brush.prop("scene.brush.strength");
    brush.prop("scene.brush.radius");
    brush.prop("scene.brush.hardness");
    brush.prop("scene.brush.spacing");
    brush.prop("scene.brush.sculptStrength");

    const render = c.panel("Render");
    render.prop("scene.settings.clipModel");
    render.prop("scene.settings.showReference");
    render.prop("scene.settings.showCompare");
    render.prop("scene.settings.refHeight");
    render.prop("scene.settings.showWireframe");
    render.prop("scene.settings.overlay");
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
