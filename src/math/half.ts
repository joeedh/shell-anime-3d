// IEEE 754 half-precision conversion, for the rgba16float paint maps' CPU mirror.

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function toHalf(value: number): number {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;

  if (exp === 0xff) {
    return sign | 0x7c00 | (mant ? 0x200 : 0);
  }
  let e = exp - 127 + 15;
  if (e >= 0x1f) {
    return sign | 0x7c00;
  }
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let h = mant >> shift;
    if ((mant >> (shift - 1)) & 1) h++;
    return sign | h;
  }
  let h = sign | (e << 10) | (mant >> 13);
  // round to nearest; a carry into the exponent is still correct
  if (mant & 0x1000) h++;
  return h;
}

export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}
