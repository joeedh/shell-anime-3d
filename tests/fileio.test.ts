import { describe, expect, it } from "vitest";
import { Scene, ClipModel } from "../src/core/scene";
import {
  readSceneAuto,
  readSceneBinary,
  readSceneJSON,
  writeSceneBinary,
  writeSceneJSON,
} from "../src/core/fileio";
import { PrimitiveType } from "../src/mesh/mesh";
import { makePrimitive } from "../src/mesh/primitives";

function makeScene() {
  const scene = new Scene();
  scene.pendingPrimitive.type = PrimitiveType.TORUS;
  scene.pendingPrimitive.density = 5;
  scene.setMesh(makePrimitive(scene.pendingPrimitive));
  scene.mesh.cAbs.fill(0.25);
  scene.mesh.uvs[3] = 0.5;
  scene.settings.clipModel = ClipModel.PN_PATCH;
  scene.settings.showWireframe = true;
  scene.camera.yaw = 1.25;
  scene.frontAxis = [0, 1, 0];
  return scene;
}

// JSON writes -0 as 0, which is harmless; compare with signed zeros folded
const arr = (a: ArrayLike<number>) => Array.from(a, (x) => x + 0);

function expectSameScene(a: Scene, b: Scene) {
  expect(b.settings.clipModel).toBe(a.settings.clipModel);
  expect(b.settings.showWireframe).toBe(a.settings.showWireframe);
  expect(b.camera.yaw).toBeCloseTo(a.camera.yaw, 6);
  expect(b.frontAxis).toEqual(a.frontAxis);
  expect(b.pendingPrimitive.type).toBe(a.pendingPrimitive.type);
  expect(b.mesh.primitive.type).toBe(PrimitiveType.TORUS);
  expect(arr(b.mesh.positions)).toEqual(arr(a.mesh.positions));
  expect(arr(b.mesh.tris)).toEqual(arr(a.mesh.tris));
  expect(arr(b.mesh.uvs)).toEqual(arr(a.mesh.uvs));
  expect(arr(b.mesh.cAbs)).toEqual(arr(a.mesh.cAbs));
  // derived data is rebuilt after load
  expect(b.mesh.normals.length).toBe(a.mesh.positions.length);
  expect(b.mesh.vertTriStart.length).toBe(b.mesh.vertCount + 1);
}

describe("scene files", () => {
  it("round-trips through binary", () => {
    const a = makeScene();
    const b = readSceneBinary(writeSceneBinary(a));
    expectSameScene(a, b);
  });

  it("reads binary from a view into a larger pooled buffer", () => {
    const a = makeScene();
    const bytes = writeSceneBinary(a);
    const pool = new Uint8Array(bytes.byteLength + 100);
    pool.set(bytes, 37);
    expectSameScene(a, readSceneBinary(pool.subarray(37, 37 + bytes.byteLength)));
  });

  it("round-trips through JSON", () => {
    const a = makeScene();
    const text = writeSceneJSON(a);
    const doc = JSON.parse(text);
    expect(doc.structScripts).toContain("sa3d.Scene");
    expectSameScene(a, readSceneJSON(text));
  });

  it("detects the format", () => {
    const a = makeScene();
    expectSameScene(a, readSceneAuto(writeSceneBinary(a)));
    expectSameScene(a, readSceneAuto(new TextEncoder().encode(writeSceneJSON(a))));
  });
});
