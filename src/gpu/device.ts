/** The app's single WebGPU device and the canvas format it presents in. */
export interface GPUState {
  adapter: GPUAdapter;
  device: GPUDevice;
  format: GPUTextureFormat;
}

let gpuState: GPUState | undefined;

/** Creates the device once; requests the adapter's storage-buffer limit for headroom. */
export async function initGPU(): Promise<GPUState> {
  if (gpuState) {
    return gpuState;
  }
  if (!navigator.gpu) {
    throw new Error("WebGPU is unavailable (navigator.gpu missing)");
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    throw new Error("No WebGPU adapter");
  }

  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });

  device.lost.then((info) => console.error("WebGPU device lost:", info.message));
  device.addEventListener("uncapturederror", (e) => {
    console.error("WebGPU error:", (e as GPUUncapturedErrorEvent).error.message);
  });

  gpuState = { adapter, device, format: navigator.gpu.getPreferredCanvasFormat() };
  return gpuState;
}

/** The device, once initGPU has resolved. */
export function getGPU(): GPUState {
  if (!gpuState) {
    throw new Error("initGPU() has not completed");
  }
  return gpuState;
}
