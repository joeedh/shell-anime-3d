import type { Mesh } from "../mesh/mesh";

/** Texels a gutter texel may be from its chart and still be filled by dilation. */
export const GUTTER_TEXELS = 4;

/**
 * For each texel: -1 if a UV triangle covers its center; otherwise the index of the
 * nearest covered texel within GUTTER_TEXELS (a gutter texel to fill), or -2 if none.
 * The GPU dilation pass copies each gutter texel's value from that source texel.
 */
export function buildDilationMap(mesh: Mesh, size: number): Int32Array {
  const map = new Int32Array(size * size).fill(-2);
  const uv = mesh.uvs;

  for (let t = 0; t < mesh.triCount; t++) {
    const ax = uv[t * 6] * size,
      ay = uv[t * 6 + 1] * size;
    const bx = uv[t * 6 + 2] * size,
      by = uv[t * 6 + 3] * size;
    const cx = uv[t * 6 + 4] * size,
      cy = uv[t * 6 + 5] * size;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0) continue;

    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
    const s = Math.sign(area);

    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const w0 = s * ((bx - px) * (cy - py) - (by - py) * (cx - px));
        const w1 = s * ((cx - px) * (ay - py) - (cy - py) * (ax - px));
        const w2 = s * ((ax - px) * (by - py) - (ay - py) * (bx - px));
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) map[y * size + x] = -1;
      }
    }
  }

  // breadth-first rings outward from covered texels, GUTTER_TEXELS deep
  let frontier: number[] = [];
  for (let i = 0; i < map.length; i++) {
    if (map[i] === -1) frontier.push(i);
  }
  const source = (i: number) => (map[i] === -1 ? i : map[i]);
  for (let ring = 0; ring < GUTTER_TEXELS; ring++) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % size,
        y = (i - x) / size;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const j = ny * size + nx;
          if (map[j] === -2) {
            map[j] = source(i);
            next.push(j);
          }
        }
      }
    }
    frontier = next;
  }
  return map;
}
