function sinc(value) {
  if (Math.abs(value) < 1e-7) return 1;
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

function lanczosWeight(value, lobes) {
  const distance = Math.abs(value);
  if (distance >= lobes) return 0;
  return sinc(value) * sinc(value / lobes);
}

function contributions(sourceSize, targetSize, lobes) {
  const indices = new Int32Array(targetSize * lobes * 2);
  const weights = new Float32Array(targetSize * lobes * 2);
  const scale = targetSize / sourceSize;
  const support = lobes;
  const taps = lobes * 2;

  for (let target = 0; target < targetSize; target += 1) {
    const center = (target + 0.5) / scale - 0.5;
    const first = Math.floor(center) - lobes + 1;
    let total = 0;
    for (let tap = 0; tap < taps; tap += 1) {
      const source = first + tap;
      const weight = lanczosWeight(center - source, support);
      const offset = target * taps + tap;
      indices[offset] = Math.max(0, Math.min(sourceSize - 1, source));
      weights[offset] = weight;
      total += weight;
    }
    if (Math.abs(total) < 1e-7) continue;
    for (let tap = 0; tap < taps; tap += 1) {
      weights[target * taps + tap] /= total;
    }
  }
  return { indices, weights, taps };
}

export function resampleLanczosRgba({ data, width, height, targetWidth, targetHeight, lobes = 2 }) {
  const sourceWidth = Math.max(1, Math.round(Number(width) || 0));
  const sourceHeight = Math.max(1, Math.round(Number(height) || 0));
  const outputWidth = Math.max(1, Math.round(Number(targetWidth) || 0));
  const outputHeight = Math.max(1, Math.round(Number(targetHeight) || 0));
  const kernelLobes = Math.max(2, Math.min(3, Math.round(Number(lobes) || 2)));
  if (!data || data.length !== sourceWidth * sourceHeight * 4) {
    throw new TypeError("Lanczos input must contain one RGBA value for every source pixel.");
  }

  const horizontalKernel = contributions(sourceWidth, outputWidth, kernelLobes);
  const verticalKernel = contributions(sourceHeight, outputHeight, kernelLobes);
  const horizontal = new Float32Array(outputWidth * sourceHeight * 4);

  for (let y = 0; y < sourceHeight; y += 1) {
    for (let x = 0; x < outputWidth; x += 1) {
      const outputOffset = (y * outputWidth + x) * 4;
      const kernelOffset = x * horizontalKernel.taps;
      for (let tap = 0; tap < horizontalKernel.taps; tap += 1) {
        const sourceX = horizontalKernel.indices[kernelOffset + tap];
        const weight = horizontalKernel.weights[kernelOffset + tap];
        const sourceOffset = (y * sourceWidth + sourceX) * 4;
        horizontal[outputOffset] += data[sourceOffset] * weight;
        horizontal[outputOffset + 1] += data[sourceOffset + 1] * weight;
        horizontal[outputOffset + 2] += data[sourceOffset + 2] * weight;
        horizontal[outputOffset + 3] += data[sourceOffset + 3] * weight;
      }
    }
  }

  const output = new Uint8ClampedArray(outputWidth * outputHeight * 4);
  for (let y = 0; y < outputHeight; y += 1) {
    const kernelOffset = y * verticalKernel.taps;
    for (let x = 0; x < outputWidth; x += 1) {
      const outputOffset = (y * outputWidth + x) * 4;
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let tap = 0; tap < verticalKernel.taps; tap += 1) {
        const sourceY = verticalKernel.indices[kernelOffset + tap];
        const weight = verticalKernel.weights[kernelOffset + tap];
        const sourceOffset = (sourceY * outputWidth + x) * 4;
        red += horizontal[sourceOffset] * weight;
        green += horizontal[sourceOffset + 1] * weight;
        blue += horizontal[sourceOffset + 2] * weight;
        alpha += horizontal[sourceOffset + 3] * weight;
      }
      output[outputOffset] = red;
      output[outputOffset + 1] = green;
      output[outputOffset + 2] = blue;
      output[outputOffset + 3] = alpha;
    }
  }
  return output;
}

function luminance(data, offset) {
  return data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
}

export function applyRestrainedUnsharpRgba(data, width, height, { amount = 0.16, threshold = 3 } = {}) {
  const output = new Uint8ClampedArray(data);
  if (width < 3 || height < 3 || amount <= 0) return output;
  const source = new Uint8ClampedArray(data);
  const row = width * 4;
  const gaussian = [1, 2, 1, 2, 4, 2, 1, 2, 1];

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const offset = (y * width + x) * 4;
      let blurred = 0;
      let kernel = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          blurred += luminance(source, offset + dy * row + dx * 4) * gaussian[kernel];
          kernel += 1;
        }
      }
      const difference = luminance(source, offset) - blurred / 16;
      if (Math.abs(difference) < threshold) continue;
      const adjustment = difference * amount;
      output[offset] = source[offset] + adjustment;
      output[offset + 1] = source[offset + 1] + adjustment;
      output[offset + 2] = source[offset + 2] + adjustment;
    }
  }
  return output;
}
