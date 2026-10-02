const WIDTH_TARGETS = Object.freeze({ manga: 1400, comic: 1600, webtoon: 1080 });

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function finiteScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? clamp(score, 0, 100) : null;
}

export function representativePageIndices(pageCount, preferredRatio = 0.5, sampleCount = 2) {
  const count = Math.max(0, Math.floor(Number(pageCount) || 0));
  const limit = Math.max(1, Math.min(3, Math.floor(Number(sampleCount) || 2)));
  if (!count) return [];
  const ratios = [clamp(preferredRatio), 0.5, 0.2, 0.8, 0];
  const indices = [];
  ratios.forEach((ratio) => {
    const index = Math.round((count - 1) * ratio);
    if (!indices.includes(index) && indices.length < limit) indices.push(index);
  });
  return indices;
}

export function rgbaEdgeClarity(data, width, height) {
  const imageWidth = Math.max(0, Math.floor(Number(width) || 0));
  const imageHeight = Math.max(0, Math.floor(Number(height) || 0));
  if (!data || imageWidth < 3 || imageHeight < 3 || data.length < imageWidth * imageHeight * 4) return 0;
  const luminance = new Float32Array(imageWidth * imageHeight);
  for (let pixel = 0, offset = 0; pixel < luminance.length; pixel += 1, offset += 4) {
    luminance[pixel] = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
  }
  let laplacianTotal = 0;
  let edgePixels = 0;
  let samples = 0;
  for (let y = 1; y < imageHeight - 1; y += 1) {
    for (let x = 1; x < imageWidth - 1; x += 1) {
      const index = y * imageWidth + x;
      const laplacian = Math.abs(
        luminance[index] * 4
        - luminance[index - 1]
        - luminance[index + 1]
        - luminance[index - imageWidth]
        - luminance[index + imageWidth]
      ) / 255;
      laplacianTotal += laplacian;
      if (laplacian >= 0.08) edgePixels += 1;
      samples += 1;
    }
  }
  const averageLaplacian = laplacianTotal / Math.max(1, samples);
  const edgeDensity = edgePixels / Math.max(1, samples);
  return Number(clamp(
    0.65 * (averageLaplacian / 0.12)
    + 0.35 * (edgeDensity / 0.18)
  ).toFixed(4));
}

export function scoreImageSample(sample, mediaFormat = "manga") {
  const width = Math.max(0, Number(sample?.width) || 0);
  const height = Math.max(0, Number(sample?.height) || 0);
  const byteCount = Math.max(0, Number(sample?.byteCount) || 0);
  const clarity = clamp(sample?.clarity ?? 0.5);
  const target = WIDTH_TARGETS[mediaFormat] || WIDTH_TARGETS.manga;
  const resolution = clamp(width / target);
  const pixels = width * height;
  const density = pixels && byteCount ? clamp((byteCount / pixels) / 0.18) : 0.5;
  const score = 100 * (0.6 * resolution + 0.2 * clarity + 0.2 * density);
  return {
    score: Number(score.toFixed(1)),
    resolution: Number(resolution.toFixed(4)),
    clarity: Number(clarity.toFixed(4)),
    density: Number(density.toFixed(4)),
    possibleUpscale: resolution >= 0.9 && clarity < 0.24 && density < 0.34,
  };
}

export function summarizeSeriesSamples(samples, mediaFormat = "manga") {
  const usable = (Array.isArray(samples) ? samples : [])
    .filter((sample) => Number(sample?.width) > 0 && Number(sample?.height) > 0)
    .map((sample) => ({ ...sample, quality: scoreImageSample(sample, mediaFormat) }));
  if (!usable.length) return { quality: null, consistency: null, possibleUpscale: false, samples: [] };
  const scores = usable.map((sample) => sample.quality.score);
  const widths = usable.map((sample) => Number(sample.width));
  const meanWidth = widths.reduce((sum, width) => sum + width, 0) / widths.length;
  const variance = widths.reduce((sum, width) => sum + ((width - meanWidth) ** 2), 0) / widths.length;
  const consistency = clamp(1 - Math.sqrt(variance) / Math.max(1, meanWidth));
  const sampleQuality = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  return {
    quality: Number((sampleQuality * 0.9 + consistency * 10).toFixed(1)),
    consistency: Number((consistency * 100).toFixed(1)),
    possibleUpscale: usable.some((sample) => sample.quality.possibleUpscale),
    samples: usable,
  };
}

export function rankSeriesSource(candidate) {
  const quality = finiteScore(candidate?.quality);
  const reliability = finiteScore(candidate?.reliability);
  const coverage = finiteScore(candidate?.coverage);
  const speed = finiteScore(candidate?.speed);
  const dimensions = [
    [quality, 0.45],
    [reliability, 0.25],
    [coverage, 0.20],
    [speed, 0.10],
  ].filter(([value]) => value !== null);
  const overall = dimensions.length
    ? dimensions.reduce((sum, [value, weight]) => sum + value * weight, 0)
      / dimensions.reduce((sum, [, weight]) => sum + weight, 0)
    : null;
  const evidence = Math.max(0, Number(candidate?.evidenceCount) || 0);
  const sampleCount = Math.max(0, Number(candidate?.sampleCount) || 0);
  const confidence = sampleCount >= 2 && evidence >= 10
    ? "established"
    : sampleCount >= 2 || evidence >= 3 ? "developing" : "early";
  return {
    overall: overall === null ? null : Number(overall.toFixed(1)),
    confidence,
  };
}

export function sourceCoverageScore({ chapterCount = 0, referenceChapterCount = 0, matchedChapter = false } = {}) {
  const reference = Math.max(1, Number(referenceChapterCount) || 1);
  const relativeCoverage = clamp((Number(chapterCount) || 0) / reference);
  return Number((100 * (0.6 * Number(Boolean(matchedChapter)) + 0.4 * relativeCoverage)).toFixed(1));
}

