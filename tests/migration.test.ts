import { describe, expect, it } from "vitest";
import * as nstructjs from "nstructjs";

/**
 * The migration pattern from docs/file-format.md, on a test-only struct.
 * v0.0.1 stored `oldWidth` in millimetres; v0.1.0 stores `width` in metres.
 */
class MigTest {
  width = 0;
  declare oldWidth?: number;

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  sa3d.test.MigTest {
    width : float;
  }`,
  );

  loadSTRUCT(reader: (obj: this) => void) {
    reader(this);
  }

  /** Runs on raw JSON (before load) and on a loaded instance (binary); handle both. */
  static migrateSTRUCT(version: number, data: Record<string, unknown>, finish?: () => void) {
    if (version < nstructjs.filehelper.versionToInt([0, 1, 0]) && data.oldWidth !== undefined) {
      data.width = (data.oldWidth as number) / 1000;
      delete data.oldWidth;
    }
    finish?.();
  }
}

const OLD_ID = 4242;
const OLD_SCRIPTS = `sa3d.test.MigTest id=${OLD_ID} {\n  oldWidth : float;\n}\n`;

/** Hand-builds a v0.0.1 FileHelper file holding one MigTest block. */
function oldBinaryFile(oldWidth: number) {
  const bp = nstructjs.binpack;
  const w = new bp.BinWriter();
  bp.pack_static_string(w, "TEST", 4);
  bp.pack_short(w, 0);
  bp.pack_byte(w, 0);
  bp.pack_byte(w, 1);
  bp.pack_string(w, OLD_SCRIPTS);

  const body = new bp.BinWriter();
  bp.pack_float(body, oldWidth);
  const bytes = body.finish();

  bp.pack_static_string(w, "MIGT", 4);
  bp.pack_int(w, bytes.length);
  bp.pack_int(w, OLD_ID);
  w.pushBytes(bytes);
  return new DataView(w.toBytes().buffer);
}

describe("migration", () => {
  it("binary: an old file's renamed field is migrated through the embedded scripts", () => {
    const helper = new nstructjs.filehelper.FileHelper({ magic: "TEST", blocktypes: ["MIGT"] });
    const blocks = helper.read(oldBinaryFile(2500));
    const obj = blocks[0].data as MigTest;
    expect(obj).toBeInstanceOf(MigTest);
    expect(obj.width).toBeCloseTo(2.5, 5);
    expect(obj.oldWidth).toBeUndefined();
  });

  it("JSON: the version must be passed as an integer", () => {
    const json = { oldWidth: 2500 };
    const obj = nstructjs.readJSON(json, MigTest, {
      version: nstructjs.filehelper.versionToInt([0, 0, 1]),
    }) as MigTest;
    expect(obj.width).toBeCloseTo(2.5, 5);
  });

  it("JSON: current-version data is left alone", () => {
    const obj = nstructjs.readJSON({ width: 3 }, MigTest, {
      version: nstructjs.filehelper.versionToInt([0, 1, 0]),
    }) as MigTest;
    expect(obj.width).toBe(3);
  });
});
