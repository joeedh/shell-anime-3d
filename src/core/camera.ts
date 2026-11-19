import * as nstructjs from "nstructjs";
import { lookAt, multiply, invert, orthographic, perspective } from "../math/mat4";
import type { Mat4 } from "../math/mat4";

/** Orbit camera around `target`; saved with the scene. */
export class Camera {
  target = [0, 0, 0];
  distance = 4;
  /** Radians around +Y. */
  yaw = 0.6;
  /** Radians above the XZ plane. */
  pitch = 0.35;
  /** Vertical field of view, degrees. */
  fovy = 35;
  ortho = false;
  near = 0.01;
  far = 100;

  eye(): [number, number, number] {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.cos(this.yaw),
    ];
  }

  /** Half the visible height at the target; also the ortho half-height. */
  halfHeightAtTarget() {
    return this.distance * Math.tan((this.fovy * Math.PI) / 360);
  }

  matrices(aspect: number): { view: Mat4; proj: Mat4; viewProj: Mat4; invViewProj: Mat4 } {
    const view = lookAt(this.eye(), this.target, [0, 1, 0]);
    const proj = this.ortho
      ? orthographic(this.halfHeightAtTarget(), aspect, this.near, this.far)
      : perspective((this.fovy * Math.PI) / 180, aspect, this.near, this.far);
    const viewProj = multiply(proj, view);
    return { view, proj, viewProj, invViewProj: invert(viewProj) };
  }

  /**
   * World size of one reference pixel is `pixelScale * depth` (perspective) or `pixelScale`
   * (ortho), where depth is the view-space distance along the view axis.
   */
  pixelScale(refHeight: number) {
    const halfTan = Math.tan((this.fovy * Math.PI) / 360);
    return this.ortho ? (2 * this.halfHeightAtTarget()) / refHeight : (2 * halfTan) / refHeight;
  }

  orbit(dx: number, dy: number) {
    this.yaw -= dx;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch + dy));
  }

  /** Moves the target in the view plane; dx, dy are fractions of the view height. */
  pan(dx: number, dy: number) {
    const h = 2 * this.halfHeightAtTarget();
    const cy = Math.cos(this.yaw),
      sy = Math.sin(this.yaw);
    const sp = Math.sin(this.pitch),
      cp = Math.cos(this.pitch);
    // camera right and up vectors
    const right = [cy, 0, -sy];
    const up = [-sp * sy, cp, -sp * cy];
    for (let i = 0; i < 3; i++) {
      this.target[i] += (-dx * right[i] + dy * up[i]) * h;
    }
  }

  zoom(factor: number) {
    this.distance = Math.max(0.05, Math.min(50, this.distance * factor));
  }

  copy() {
    const c = Object.assign(new Camera(), this);
    c.target = this.target.slice();
    return c;
  }

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  sa3d.Camera {
    target   : array(float);
    distance : float;
    yaw      : float;
    pitch    : float;
    fovy     : float;
    ortho    : bool;
    near     : float;
    far      : float;
  }`,
  );

  loadSTRUCT(reader: (obj: this) => void) {
    reader(this);
  }
}
