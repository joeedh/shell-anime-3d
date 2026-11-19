import { getGPU } from "../gpu/device";
import type { Scene } from "../core/scene";

/** Draws a scene into a viewport's canvas. */
export class Renderer {
  draw(context: GPUCanvasContext, _scene: Scene, _width: number, _height: number) {
    const { device } = getGPU();
    const encoder = device.createCommandEncoder();

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.72, g: 0.74, b: 0.78, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.end();

    device.queue.submit([encoder.finish()]);
  }
}
