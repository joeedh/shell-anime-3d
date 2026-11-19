import * as nstructjs from "nstructjs";
import { PaintChannel } from "./paintmaps";

export const BrushMode = {
  SET: 0,
  ADD: 1,
  SMOOTH: 2,
} as const;
export type BrushMode = (typeof BrushMode)[keyof typeof BrushMode];

/** What the viewport's left button does. */
export const ToolMode = {
  PAINT: 0,
  SCULPT_DRAW: 1,
  SCULPT_SMOOTH: 2,
} as const;
export type ToolMode = (typeof ToolMode)[keyof typeof ToolMode];

/** Brush settings shared by painting and sculpting. */
export class BrushSettings {
  mode: BrushMode = BrushMode.SET;
  channel: PaintChannel = PaintChannel.WIDTH;
  /** Value painted in SET mode; amount added per dab in ADD mode. */
  value = 6;
  strength = 0.5;
  /** Screen-space radius, CSS pixels. */
  radius = 40;
  /** 0 = soft falloff, 1 = hard edge. */
  hardness = 0.3;
  /** Dab spacing as a fraction of the radius. */
  spacing = 0.25;
  /** Sculpt draw strength, as a fraction of the brush's world radius per dab. */
  sculptStrength = 0.05;

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  sa3d.BrushSettings {
    mode           : int;
    channel        : int;
    value          : float;
    strength       : float;
    radius         : float;
    hardness       : float;
    spacing        : float;
    sculptStrength : float;
  }`,
  );

  loadSTRUCT(reader: (obj: this) => void) {
    reader(this);
  }
}
