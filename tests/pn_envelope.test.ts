/**
 * Measurement harness for docs/plans/pn-envelope.md: scores the PN envelope search against
 * the reference mask of the sculpted bulge in tests/scenes/scene.sa3d (see
 * tests/harness/pn_scene.ts), next to today's closest-point test and an exact oracle.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "fs";
import { pnClosest } from "../src/math/pn";
import type { Vec3 } from "../src/math/pn";
import { ENVELOPE_DEFAULTS, pnEnvelope } from "../src/math/pn_envelope";
import type { EnvelopeOptions } from "../src/math/pn_envelope";
import { SCENE, buildHarness } from "./harness/pn_scene";
import type { Frag } from "./harness/pn_scene";

type Variant = { name: string; oracle?: boolean; opt?: EnvelopeOptions };
type Score = { both: number; missing: number; extra: number; iters: number; searches: number };

describe.skipIf(!existsSync(SCENE))("PN envelope on the scene.sa3d bulge", () => {
  const H = existsSync(SCENE) ? buildHarness() : undefined!;

  const decide = (variant: Variant, D: Vec3, f: Frag) => {
    const { S, pm, em, radiusFor } = H;
    const pw = S.ps * S.depthOf(f.world);
    if (!variant.opt) {
      // the closest-point model this replaced: radius at the closest point
      const pc = pnClosest(pm, f.tri, f.u, f.v, f.world, D);
      const r = radiusFor(D, pw)(pc.tri, pc.u, pc.v, pc.point as Vec3).r;
      return { keep: pc.dist < r, iters: 0, searches: 1 };
    }
    return pnEnvelope(em, radiusFor(D, pw), pw, f.tri, f.world, D, variant.opt);
  };

  const score = (variant: Variant): Score => {
    const s: Score = { both: 0, missing: 0, extra: 0, iters: 0, searches: 0 };
    let frags = 0;
    for (const [pi, p] of H.pixels.entries()) {
      let keep = variant.oracle ? H.oracleKeep[pi] : false;
      for (const f of variant.oracle ? [] : p.frags) {
        const r = decide(variant, p.D, f);
        s.iters += r.iters;
        s.searches += r.searches;
        frags++;
        if (r.keep) {
          keep = true;
          break;
        }
      }
      if (keep && p.ref) s.both++;
      else if (p.ref) s.missing++;
      else if (keep) s.extra++;
    }
    s.iters /= frags || 1;
    s.searches /= frags || 1;
    return s;
  };

  it("finds nearly every pixel the exact PN envelope finds", () => {
    const variants: Variant[] = [
      { name: "oracle (dense PN envelope)", oracle: true },
      { name: "today (closest point)" },
      { name: "envelope, own search only", opt: { ...ENVELOPE_DEFAULTS, ring: false } },
      { name: "envelope + rings (final)", opt: ENVELOPE_DEFAULTS },
    ];
    const scores = variants.map(score);
    console.log(
      `${H.pixels.length} pixels outside the silhouette, ${H.pixels.filter((p) => p.ref).length} in the reference\n` +
        variants
          .map((v, i) => {
            const s = scores[i];
            return (
              `${v.name.padEnd(28)} both ${s.both}  missing ${s.missing}  extra ${s.extra}` +
              (v.oracle ? "" : `  iters/frag ${s.iters.toFixed(1)}  searches/frag ${s.searches.toFixed(2)}`)
            );
          })
          .join("\n"),
    );
    const [oracle, today, , final] = scores;
    expect(today.missing).toBeGreaterThan(400);
    expect(final.missing).toBeLessThan(oracle.missing + 15);
    expect(final.extra).toBeLessThan(today.extra * 1.15);
  }, 600000);

  it("keeps the pixel debugged in RenderDoc, which the closest-point search dropped", () => {
    // at (1260, 660) the closest-point search stalled on the crease between triangles 676
    // and 677; the envelope point is on 675, where the painted width is larger
    const p = H.pixels.find((q) => q.px === 1260 && q.py === 660)!;
    expect(p.ref).toBe(true);
    const keeps = (v: Variant) => p.frags.some((f) => decide(v, p.D, f).keep);
    expect(keeps({ name: "today" })).toBe(false);
    expect(keeps({ name: "final", opt: ENVELOPE_DEFAULTS })).toBe(true);
  });
});
