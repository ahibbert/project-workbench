import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPanelCalibration,
  bubbleOwnerIndex,
  framePanelForBubbles,
  learnPanelCalibration,
  makePanelCalibrationSeriesId,
  normalizePanelCalibration,
  panelCalibrationModel,
} from "../src/panel-calibration.js";


const SERIES_ID = makePanelCalibrationSeriesId("fixture-source-id", "fixture-title-id");
const detectedPanels = [
  { id: "left", x: 0.1, y: 0.1, w: 0.35, h: 0.32 },
  { id: "right", x: 0.55, y: 0.1, w: 0.35, h: 0.32 },
];
const acceptedPanels = [
  { x: 0.09, y: 0.09, w: 0.37, h: 0.34 },
  { x: 0.54, y: 0.09, w: 0.37, h: 0.34 },
];

function acceptedObservation(overrides = {}) {
  return {
    seriesId: SERIES_ID,
    accepted: true,
    strategy: "panels",
    confidenceFallback: false,
    reportedBad: false,
    detectorConfidence: 0.91,
    detectedPanels,
    acceptedPanels,
    ...overrides,
  };
}

test("accepted detector outcomes learn a conservative opaque per-series profile", () => {
  const result = learnPanelCalibration({}, acceptedObservation());

  assert.equal(result.learned, true);
  assert.equal(result.reasonCode, "accepted-panel-outcome");
  assert.deepEqual(Object.keys(result.calibration.series), [SERIES_ID]);
  const profile = result.calibration.series[SERIES_ID];
  assert.equal(profile.sampleCount, 1);
  assert.ok(profile.padding.x > 0 && profile.padding.x <= panelCalibrationModel.maximumPadding);
  assert.ok(profile.padding.y > 0 && profile.padding.y <= panelCalibrationModel.maximumPadding);
  assert.deepEqual(Object.keys(profile).sort(), ["edgeBias", "padding", "sampleCount"]);
  assert.match(SERIES_ID, /^series_[0-9a-f]{16}$/);
  assert.doesNotMatch(SERIES_ID, /fixture/);
});

test("fallback, bad, unaccepted, and low-confidence pages never train calibration", () => {
  const cases = [
    [acceptedObservation({ confidenceFallback: true }), "confidence-fallback"],
    [acceptedObservation({ strategy: "full-page" }), "confidence-fallback"],
    [acceptedObservation({ reportedBad: true }), "reported-bad"],
    [acceptedObservation({ accepted: false }), "not-accepted"],
    [acceptedObservation({ detectorConfidence: 0.4 }), "low-confidence"],
  ];

  for (const [observation, reasonCode] of cases) {
    const result = learnPanelCalibration({}, observation);
    assert.equal(result.learned, false);
    assert.equal(result.reasonCode, reasonCode);
    assert.deepEqual(result.calibration.series, {});
  }
});

test("invalid or suspicious panel pairings are rejected", () => {
  const mismatched = learnPanelCalibration({}, acceptedObservation({ acceptedPanels: acceptedPanels.slice(0, 1) }));
  const hugeCorrection = learnPanelCalibration({}, acceptedObservation({
    acceptedPanels: detectedPanels.map(() => ({ x: 0, y: 0, w: 1, h: 1 })),
  }));
  const titledKey = learnPanelCalibration({}, acceptedObservation({ seriesId: "Saga Volume One" }));

  assert.equal(mismatched.reasonCode, "invalid-panel-pairs");
  assert.equal(hugeCorrection.reasonCode, "invalid-panel-pairs");
  assert.equal(titledKey.reasonCode, "invalid-series-id");
});

test("calibration application expands and biases a crop within page bounds", () => {
  const learned = learnPanelCalibration({}, acceptedObservation()).calibration;
  const original = { x: 0, y: 0.2, w: 0.35, h: 0.3 };
  const framed = applyPanelCalibration(original, learned, SERIES_ID);

  assert.equal(framed.x, 0);
  assert.ok(framed.w > original.w);
  assert.ok(framed.y < original.y);
  assert.ok(framed.x + framed.w <= 1);
  assert.equal(framed.calibrationSamples, 1);
  assert.deepEqual(original, { x: 0, y: 0.2, w: 0.35, h: 0.3 });
});

test("normalization clamps forged profiles to conservative limits", () => {
  const normalized = normalizePanelCalibration({ series: {
    [SERIES_ID]: {
      sampleCount: 999,
      padding: { x: 5, y: -2 },
      edgeBias: { x: 4, y: -4 },
      title: "Must not persist",
    },
  } });
  const profile = normalized.series[SERIES_ID];

  assert.equal(profile.sampleCount, panelCalibrationModel.maximumSamplesPerSeries);
  assert.equal(profile.padding.x, panelCalibrationModel.maximumPadding);
  assert.equal(profile.padding.y, 0);
  assert.equal(profile.edgeBias.x, panelCalibrationModel.maximumEdgeBias);
  assert.equal(profile.edgeBias.y, -panelCalibrationModel.maximumEdgeBias);
  assert.doesNotMatch(JSON.stringify(normalized), /title|Must not persist/);
});

test("bubble ownership follows center and overlap rather than list order", () => {
  const panels = [
    { x: 0.05, y: 0.1, w: 0.4, h: 0.4 },
    { x: 0.55, y: 0.1, w: 0.4, h: 0.4 },
  ];
  assert.equal(bubbleOwnerIndex({ x: 0.42, y: 0.2, w: 0.08, h: 0.1 }, panels), 0);
  assert.equal(bubbleOwnerIndex({ x: 0.51, y: 0.2, w: 0.08, h: 0.1 }, panels), 1);
});

test("bubble framing expands for clipped bubbles and respects page edges", () => {
  const panel = { id: "edge", x: 0, y: 0.1, w: 0.45, h: 0.4 };
  const framed = framePanelForBubbles({
    panel,
    panels: [panel],
    bubbles: [{ x: 0, y: 0.06, w: 0.18, h: 0.1 }],
  });

  assert.equal(framed.x, 0);
  assert.ok(framed.y < panel.y);
  assert.equal(framed.bubbleCount, 1);
  assert.equal(framed.clippedBubbleCount, 0);
  assert.equal(framed.neighborLimited, false);
});

test("neighbor barriers cap expansion and report bubbles that remain clipped", () => {
  const left = { id: "left", x: 0.05, y: 0.1, w: 0.4, h: 0.45 };
  const right = { id: "right", x: 0.5, y: 0.1, w: 0.45, h: 0.45 };
  const framed = framePanelForBubbles({
    panel: left,
    panels: [left, right],
    bubbles: [{ x: 0.34, y: 0.2, w: 0.2, h: 0.12 }],
    maxNeighborOverlap: 0.02,
  });

  assert.equal(framed.bubbleCount, 1);
  assert.equal(framed.neighborLimited, true);
  assert.ok(framed.x + framed.w <= right.x + right.w * 0.02 + 1e-9);
  assert.equal(framed.clippedBubbleCount, 1);
});

test("fully contained bubbles do not enlarge an already safe crop", () => {
  const panel = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  const framed = framePanelForBubbles({
    panel,
    panels: [panel],
    bubbles: [{ x: 0.3, y: 0.3, w: 0.2, h: 0.2 }],
  });

  assert.deepEqual(framed, { ...panel, bubbleCount: 0, clippedBubbleCount: 0, neighborLimited: false });
});
