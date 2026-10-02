import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateDetectionQuality,
  detectionQualityContract,
  detectionQualityEntry,
  summarizeDetectionSuite,
} from "../src/detection-quality.js";

const goodDecision = {
  strategy: "panels",
  confidence: 0.91,
  reasonCodes: ["confident-layout", "model-scores-strong"],
  metrics: { coverage: 0.82, overlapRatio: 0.04, readingOrderViolations: 0, pageAspect: 0.68 },
};

test("an expected clean detection becomes an accepted privacy-safe record", () => {
  const entry = detectionQualityEntry({
    format: "comic",
    decision: goodDecision,
    detectedCount: 5,
    expectedCount: 5,
  });
  assert.equal(entry.accepted, true);
  assert.equal(entry.countMatch, true);
  assert.equal(entry.automaticallyRisky, false);
  assert.equal(JSON.stringify(entry).includes("title"), false);
  assert.equal(JSON.stringify(entry).includes("url"), false);
});

test("explicit bad feedback dominates otherwise strong automatic signals", () => {
  const entry = detectionQualityEntry({
    format: "manga",
    decision: goodDecision,
    detectedCount: 5,
    expectedCount: 5,
    verdict: "bad",
    issues: ["bubble-crop", "bubble-crop", "not-supported"],
  });
  assert.equal(entry.accepted, false);
  assert.deepEqual(entry.issues, ["bubble-crop"]);
});

test("weak fallbacks remain risky even without a manual verdict", () => {
  const entry = detectionQualityEntry({
    decision: { strategy: "full-page", confidence: 0.42, metrics: { overlapRatio: 0.5 } },
    detectedCount: 0,
  });
  assert.equal(entry.accepted, false);
  assert.equal(entry.automaticallyRisky, true);
});

test("aggregate summaries combine count, verdict, fallback, and issue signals", () => {
  const entries = [
    detectionQualityEntry({ decision: goodDecision, detectedCount: 5, expectedCount: 5, verdict: "good" }),
    detectionQualityEntry({
      decision: { strategy: "full-width", confidence: 0.4, metrics: {} },
      detectedCount: 2,
      expectedCount: 4,
      verdict: "bad",
      issues: ["missed-panel"],
    }),
  ];
  const summary = aggregateDetectionQuality(entries);
  assert.equal(summary.pages, 2);
  assert.equal(summary.accepted, 1);
  assert.equal(summary.risky, 1);
  assert.equal(summary.fallbacks, 1);
  assert.equal(summary.countAccuracy, 0.5);
  assert.equal(summary.verdictAccuracy, 0.5);
  assert.deepEqual(summary.issueCounts, { "missed-panel": 1 });
});

test("suite summaries validate format and allowlisted source shapes", () => {
  const summary = summarizeDetectionSuite({
    cases: [
      { format: "manga", chapterId: 123, maxPages: 12 },
      { format: "comic", url: "https://comick.live/comic/example", maxPages: 4 },
      { format: "webtoon", chapterId: "456" },
    ],
  });
  assert.deepEqual(summary, {
    schemaVersion: 1,
    caseCount: 3,
    formats: { manga: 1, comic: 1, webtoon: 1 },
    declaredPageLimit: 16,
  });
  assert.throws(
    () => summarizeDetectionSuite({ cases: [{ format: "comic", url: "https://evil.example/comic/x" }] }),
    /valid chapterId or allowlisted Comick URL/,
  );
  assert.deepEqual(detectionQualityContract.formats, ["manga", "comic", "webtoon"]);
});
