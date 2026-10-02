import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRestrainedUnsharpRgba,
  resampleLanczosRgba,
} from "../src/lanczos-resampler.js";

function solidPixels(width, height, rgba) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(rgba, offset);
  return pixels;
}

test("restrained Lanczos preserves a flat field while enlarging it", () => {
  const output = resampleLanczosRgba({
    data: solidPixels(3, 2, [72, 72, 72, 255]),
    width: 3,
    height: 2,
    targetWidth: 9,
    targetHeight: 6,
  });

  assert.equal(output.length, 9 * 6 * 4);
  for (let offset = 0; offset < output.length; offset += 4) {
    assert.deepEqual([...output.slice(offset, offset + 4)], [72, 72, 72, 255]);
  }
});

test("restrained Lanczos produces intermediate edge pixels instead of nearest-neighbour blocks", () => {
  const source = new Uint8ClampedArray([
    0, 0, 0, 255,
    255, 255, 255, 255,
  ]);
  const output = resampleLanczosRgba({
    data: source,
    width: 2,
    height: 1,
    targetWidth: 8,
    targetHeight: 1,
  });
  const values = Array.from({ length: 8 }, (_, index) => output[index * 4]);

  assert.ok(values.some((value) => value > 0 && value < 255));
  assert.ok(values[0] < values.at(-1));
});

test("light edge recovery leaves low-contrast noise alone and preserves alpha", () => {
  const source = solidPixels(5, 5, [120, 120, 120, 180]);
  const center = (2 * 5 + 2) * 4;
  source[center] = 121;
  source[center + 1] = 121;
  source[center + 2] = 121;
  const output = applyRestrainedUnsharpRgba(source, 5, 5, { amount: 0.16, threshold: 3 });

  assert.equal(output[center], 121);
  assert.equal(output[center + 3], 180);
});

