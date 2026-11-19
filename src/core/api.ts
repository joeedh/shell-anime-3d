import { DataAPI, DataStruct, buildToolSysAPI } from "../pathux";
import { ClipModel, RenderSettings, Scene } from "./scene";
import { Camera } from "./camera";
import { PrimitiveParams, PrimitiveType } from "../mesh/mesh";

const redraw = () => window.redraw_all?.();

function defineRenderSettings(api: DataAPI) {
  const st = api.mapStruct(RenderSettings, true);

  st.enum("clipModel", "clipModel", ClipModel, "Clip Model").on("change", redraw);
  st.bool("showReference", "showReference", "Show Reference").on("change", redraw);
  st.bool("showCompare", "showCompare", "Compare To Reference").on("change", redraw);
  st.bool("showWireframe", "showWireframe", "Wireframe").on("change", redraw);
  st.float("refHeight", "refHeight", "Reference Height")
    .range(64, 8192)
    .decimalPlaces(0)
    .noUnits()
    .on("change", redraw);
}

function defineCamera(api: DataAPI) {
  const st = api.mapStruct(Camera, true);
  st.bool("ortho", "ortho", "Orthographic").on("change", redraw);
  st.float("fovy", "fovy", "Field of View").range(5, 120).decimalPlaces(1).noUnits().on("change", redraw);
}

function definePrimitiveParams(api: DataAPI) {
  // edits here are a pending choice; SetPrimitiveOp is the undoable step
  const st = api.mapStruct(PrimitiveParams, true);
  st.enum("type", "type", PrimitiveType, "Type").noUndo();
  st.int("density", "density", "Density").range(1, 128).noUndo();
  st.float("radius", "radius", "Radius").range(0.05, 10).decimalPlaces(2).noUnits().noUndo();
  st.float("radius2", "radius2", "Radius 2").range(0.01, 10).decimalPlaces(2).noUnits().noUndo();
}

function defineScene(api: DataAPI) {
  const st = api.mapStruct(Scene, true);
  st.struct("settings", "settings", "Settings", api.mapStruct(RenderSettings));
  st.struct("camera", "camera", "Camera", api.mapStruct(Camera));
  st.struct("pendingPrimitive", "pendingPrimitive", "Primitive", api.mapStruct(PrimitiveParams));
}

/** Builds the data API the UI binds to; the root is the context. */
export function defineAPI() {
  const api = new DataAPI();
  const root = new DataStruct();
  api.setRoot(root);

  defineRenderSettings(api);
  defineCamera(api);
  definePrimitiveParams(api);
  defineScene(api);

  root.struct("scene", "scene", "Scene", api.mapStruct(Scene));
  root.dynamicStruct("last_tool", "last_tool", "Last Tool");
  buildToolSysAPI(api, false, root);

  return api;
}
