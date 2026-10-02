import { applyRestrainedUnsharpRgba, resampleLanczosRgba } from "./lanczos-resampler.js";

self.addEventListener("message", (event) => {
  const { id, source, width, height, targetWidth, targetHeight } = event.data || {};
  try {
    const resized = resampleLanczosRgba({
      data: new Uint8ClampedArray(source),
      width,
      height,
      targetWidth,
      targetHeight,
      lobes: 2,
    });
    const enhanced = applyRestrainedUnsharpRgba(resized, targetWidth, targetHeight);
    self.postMessage({ id, width: targetWidth, height: targetHeight, pixels: enhanced.buffer }, [enhanced.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error?.message || "High-zoom enhancement failed." });
  }
});
