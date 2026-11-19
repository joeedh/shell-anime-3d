import * as nstructjs from "nstructjs";
import { fromHalf, toHalf } from "../math/half";

/** Paint texture channels. */
export const PaintChannel = {
  WIDTH: 0,
  FRONT: 1,
  PROFILE: 2,
} as const;
export type PaintChannel = (typeof PaintChannel)[keyof typeof PaintChannel];

export const DEFAULT_TEXELS = [3, 1, 1, 0];

/**
 * The painted maps: one rgba16float texture. R = line width in reference pixels,
 * G = wFront, B = wProfile, A = spare. This is the CPU mirror; the GPU texture lives in
 * PaintGPU and is the one strokes write to. Stroke ends download their tiles back here.
 */
export class PaintMaps {
  size = 1024;
  /** Half floats, 4 per texel, rows top to bottom. */
  data: Uint16Array;
  /** Bumped when `data` is replaced wholesale, so the GPU copy re-uploads. */
  version = 0;

  constructor(size = 1024) {
    this.size = size;
    this.data = new Uint16Array(size * size * 4);
    this.clear();
  }

  clear(values = DEFAULT_TEXELS) {
    const h = values.map(toHalf);
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = h[0];
      this.data[i + 1] = h[1];
      this.data[i + 2] = h[2];
      this.data[i + 3] = h[3];
    }
    this.version++;
  }

  texel(x: number, y: number, channel: number) {
    return fromHalf(this.data[(y * this.size + x) * 4 + channel]);
  }

  copy() {
    const m = new PaintMaps(0);
    m.size = this.size;
    m.data = this.data.slice();
    m.version = this.version + 1;
    return m;
  }

  /** Copies a w x h block of texels (4 halfs each) into the mirror at (x, y). */
  writeBlock(x: number, y: number, w: number, h: number, block: Uint16Array) {
    for (let row = 0; row < h; row++) {
      const dst = ((y + row) * this.size + x) * 4;
      this.data.set(block.subarray(row * w * 4, (row + 1) * w * 4), dst);
    }
  }

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  sa3d.PaintMaps {
    size : int;
    data : arraybuffer(ushort);
  }`,
  );

  static newSTRUCT() {
    return new PaintMaps(0);
  }

  loadSTRUCT(reader: (obj: this) => void) {
    reader(this);
    this.version++;
  }
}
