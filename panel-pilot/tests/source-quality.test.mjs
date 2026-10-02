import assert from "node:assert/strict";
import test from "node:test";

import {
  rankSeriesSource,
  representativePageIndices,
  rgbaEdgeClarity,
  scoreImageSample,
  sourceCoverageScore,
  summarizeSeriesSamples,
} from "../src/source-quality.js";

test("representative sampling stays bounded and prioritizes reading position", () => {
  assert.deepEqual(representativePageIndices(20, 0.75, 2), [14, 10]);
  assert.deepEqual(representativePageIndices(1, 0.75, 3), [0]);
  assert.deepEqual(representativePageIndices(0), []);
});

test("edge clarity distinguishes a flat field from a hard manga edge", () => {
  const flat = new Uint8ClampedArray(5 * 5 * 4).fill(255);
  const edge = new Uint8ClampedArray(flat);
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 2; x += 1) {
      const offset = (y * 5 + x) * 4;
      edge[offset] = 0;
      edge[offset + 1] = 0;
      edge[offset + 2] = 0;
      edge[offset + 3] = 255;
    }
  }
  assert.equal(rgbaEdgeClarity(flat, 5, 5), 0);
  assert.ok(rgbaEdgeClarity(edge, 5, 5) > 0.2);
});

test("a genuinely larger detailed image outranks a small compressed sample", () => {
  const strong = scoreImageSample({ width: 1600, height: 2400, byteCount: 1_500_000, clarity: 0.72 }, "manga");
  const weak = scoreImageSample({ width: 700, height: 1050, byteCount: 90_000, clarity: 0.32 }, "manga");
  assert.ok(strong.score > weak.score + 30);
  assert.equal(strong.possibleUpscale, false);
});

test("series summaries include consistency and flag suspicious soft enlargement", () => {
  const summary = summarizeSeriesSamples([
    { width: 1600, height: 2400, byteCount: 120_000, clarity: 0.12 },
    { width: 1580, height: 2370, byteCount: 118_000, clarity: 0.14 },
  ], "manga");
  assert.equal(summary.samples.length, 2);
  assert.ok(summary.consistency > 95);
  assert.equal(summary.possibleUpscale, true);
});

test("hybrid ranking follows title quality while retaining reliability and coverage", () => {
  const ranked = rankSeriesSource({
    quality: 90,
    reliability: 80,
    coverage: 75,
    speed: 70,
    sampleCount: 2,
    evidenceCount: 12,
  });
  assert.equal(ranked.overall, 82.5);
  assert.equal(ranked.confidence, "established");
  assert.equal(sourceCoverageScore({ chapterCount: 80, referenceChapterCount: 100, matchedChapter: true }), 92);
});
