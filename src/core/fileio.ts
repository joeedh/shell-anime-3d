import * as nstructjs from "nstructjs";
import { FILE_MAGIC, FILE_VERSION } from "./const";
import { Scene } from "./scene";

/**
 * Scene files, binary or JSON. Both embed `write_scripts()`, the schema the file was
 * written with, so migration code can see old struct layouts. See docs/file-format.md.
 */

const SCENE_BLOCK = "SCEN";

function makeHelper() {
  return new nstructjs.filehelper.FileHelper({
    magic: FILE_MAGIC,
    ext: ".sa3d",
    blocktypes: [SCENE_BLOCK],
    version: { ...FILE_VERSION },
  });
}

export function writeSceneBinary(scene: Scene): Uint8Array {
  const view = makeHelper().write([new nstructjs.filehelper.Block(SCENE_BLOCK, scene)]);
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** `bytes` may be a view into a pooled buffer (Node's readFileSync); it is copied first. */
export function readSceneBinary(bytes: Uint8Array): Scene {
  // FileHelper.read ignores byteOffset and reads to the end of the underlying buffer
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);

  const blocks = makeHelper().read(new DataView(copy.buffer));
  const block = blocks.find((b) => b.type === SCENE_BLOCK);
  if (!block) {
    throw new Error("File has no scene block");
  }
  const scene = block.data as Scene;
  scene.afterLoad();
  return scene;
}

interface SceneJSON {
  magic: string;
  version: [number, number, number];
  structScripts: string;
  scene: unknown;
}

export function writeSceneJSON(scene: Scene): string {
  const doc: SceneJSON = {
    magic: FILE_MAGIC,
    version: [FILE_VERSION.major, FILE_VERSION.minor, FILE_VERSION.micro],
    structScripts: nstructjs.write_scripts(),
    scene: nstructjs.writeJSON(scene),
  };
  return JSON.stringify(doc);
}

export function readSceneJSON(text: string): Scene {
  const doc = JSON.parse(text) as SceneJSON;
  if (doc.magic !== FILE_MAGIC) {
    throw new Error("Not a scene file");
  }
  // MigrateOptions.version must be an integer; an array silently disables every migration guard
  const version = nstructjs.filehelper.versionToInt(doc.version);
  const scene = nstructjs.readJSON(doc.scene, Scene, { version }) as Scene;
  scene.afterLoad();
  return scene;
}

/** Binary files start with the magic; JSON files start with "{". */
export function readSceneAuto(bytes: Uint8Array): Scene {
  const head = String.fromCharCode(...bytes.subarray(0, 4));
  if (head === FILE_MAGIC) {
    return readSceneBinary(bytes);
  }
  return readSceneJSON(new TextDecoder().decode(bytes));
}
