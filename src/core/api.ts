import { DataAPI, DataStruct, buildToolSysAPI } from "../pathux";
import { ClipModel, RenderSettings, Scene } from "./scene";

const redraw = () => window.redraw_all?.();

function defineRenderSettings(api: DataAPI) {
  const st = api.mapStruct(RenderSettings, true);

  st.enum("clipModel", "clipModel", ClipModel, "Clip Model").on("change", redraw);
  st.bool("showReference", "showReference", "Show Reference").on("change", redraw);
  st.bool("showCompare", "showCompare", "Compare To Reference").on("change", redraw);
  st.float("refHeight", "refHeight", "Reference Height")
    .range(64, 8192)
    .decimalPlaces(0)
    .noUnits()
    .on("change", redraw);
}

function defineScene(api: DataAPI) {
  const st = api.mapStruct(Scene, true);
  st.struct("settings", "settings", "Settings", api.mapStruct(RenderSettings));
}

/** Builds the data API the UI binds to; the root is the context. */
export function defineAPI() {
  const api = new DataAPI();
  const root = new DataStruct();
  api.setRoot(root);

  defineRenderSettings(api);
  defineScene(api);

  root.struct("scene", "scene", "Scene", api.mapStruct(Scene));
  root.dynamicStruct("last_tool", "last_tool", "Last Tool");
  buildToolSysAPI(api, false, root);

  return api;
}
