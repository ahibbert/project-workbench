import assert from "node:assert/strict";
import test from "node:test";

import { choosePanelDetectionFallback, panelDetectionPolicy } from "../src/detection-policy.js";


function regularGrid({ scores = true } = {}) {
  return [
    { id: "top-left", x: 0.04, y: 0.04, w: 0.43, h: 0.27, ...(scores ? { score: 0.89 } : {}) },
    { id: "top-right", x: 0.53, y: 0.04, w: 0.43, h: 0.27, ...(scores ? { score: 0.86 } : {}) },
    { id: "middle", x: 0.04, y: 0.35, w: 0.92, h: 0.25, ...(scores ? { score: 0.83 } : {}) },
    { id: "bottom-left", x: 0.04, y: 0.64, w: 0.43, h: 0.3, ...(scores ? { score: 0.81 } : {}) },
    { id: "bottom-right", x: 0.53, y: 0.64, w: 0.43, h: 0.3, ...(scores ? { score: 0.78 } : {}) },
  ];
}

test("high-confidence model detections remain panels and retain detector order", () => {
  const panels = regularGrid();
  const snapshot = structuredClone(panels);

  const decision = choosePanelDetectionFallback({
    panels,
    pageWidth: 1000,
    pageHeight: 1500,
    direction: "ltr",
    viewportAspect: 0.75,
  });

  assert.equal(decision.strategy, "panels");
  assert.equal(decision.primaryReason, "confident-layout");
  assert.ok(decision.reasonCodes.includes("model-scores-strong"));
  assert.deepEqual(decision.panels.map((panel) => panel.id), panels.map((panel) => panel.id));
  assert.deepEqual(panels, snapshot, "policy must not mutate detector results");
  assert.equal(decision.fallback, null);
  assert.ok(decision.confidence > 0.85);
});

test("sound unscored heuristic layouts remain eligible for panel mode", () => {
  const decision = choosePanelDetectionFallback({
    panels: regularGrid({ scores: false }),
    pageWidth: 1000,
    pageHeight: 1500,
    direction: "ltr",
  });

  assert.equal(decision.strategy, "panels");
  assert.deepEqual(decision.reasonCodes, ["confident-layout", "heuristic-unscored"]);
  assert.equal(decision.metrics.scoredPanelCount, 0);
});

test("no detections choose a full-page fallback for a normal comic page", () => {
  const decision = choosePanelDetectionFallback({
    panels: [],
    pageWidth: 1000,
    pageHeight: 1500,
    viewportAspect: 0.75,
  });

  assert.equal(decision.strategy, "full-page");
  assert.equal(decision.primaryReason, "no-valid-panels");
  assert.deepEqual(decision.reasonCodes, ["no-valid-panels", "page-fit-safer"]);
  assert.equal(decision.fallback.fit, "page");
});

test("a very tall page falls back to full width so text remains readable", () => {
  const decision = choosePanelDetectionFallback({
    panels: [],
    pageWidth: 800,
    pageHeight: 3000,
    viewportAspect: 0.75,
  });

  assert.equal(decision.strategy, "full-width");
  assert.ok(decision.reasonCodes.includes("tall-page-width-fit"));
  assert.equal(decision.fallback.fit, "width");
  assert.equal(decision.fallback.pageWidth, 800);
});

test("a detector full-page rectangle does not masquerade as a panel", () => {
  const decision = choosePanelDetectionFallback({
    panels: [{ id: "whole-page", x: 0, y: 0, w: 1, h: 1, score: 0.98 }],
    pageWidth: 1000,
    pageHeight: 1500,
  });

  assert.equal(decision.strategy, "full-page");
  assert.equal(decision.primaryReason, "single-page-region");
});

test("sparse tiny detections choose the safer page presentation", () => {
  const decision = choosePanelDetectionFallback({
    panels: [
      { x: 0.1, y: 0.1, w: 0.2, h: 0.2, score: 0.9 },
      { x: 0.65, y: 0.7, w: 0.2, h: 0.2, score: 0.9 },
    ],
    pageWidth: 1000,
    pageHeight: 1500,
  });

  assert.equal(decision.strategy, "full-page");
  assert.equal(decision.primaryReason, "sparse-page-coverage");
  assert.equal(decision.metrics.coverage, 0.08);
});

test("uniformly weak model scores trigger fallback despite plausible geometry", () => {
  const panels = regularGrid().map((panel, index) => ({ ...panel, score: 0.27 + index * 0.005 }));
  const decision = choosePanelDetectionFallback({ panels, pageWidth: 1000, pageHeight: 1500 });

  assert.equal(decision.strategy, "full-page");
  assert.equal(decision.primaryReason, "low-detector-scores");
  assert.ok(decision.metrics.meanDetectorScore < 0.3);
});

test("overlapping duplicate regions trigger fallback", () => {
  const panels = Array.from({ length: 5 }, (_, index) => ({
    id: String(index),
    x: 0.08 + index * 0.005,
    y: 0.08 + index * 0.005,
    w: 0.82,
    h: 0.8,
    score: 0.9,
  }));
  const decision = choosePanelDetectionFallback({ panels, pageWidth: 1000, pageHeight: 1500 });

  assert.equal(decision.strategy, "full-page");
  assert.ok(decision.reasonCodes.includes("excessive-panel-overlap"));
  assert.ok(decision.metrics.overlapRatio > 0.7);
});

test("multiple reading-order conflicts choose fallback without reordering panels", () => {
  const panels = [
    { id: "left-1", x: 0.05, y: 0.05, w: 0.25, h: 0.25, score: 0.8 },
    { id: "right-1", x: 0.68, y: 0.05, w: 0.25, h: 0.25, score: 0.8 },
    { id: "left-2", x: 0.05, y: 0.37, w: 0.25, h: 0.25, score: 0.8 },
    { id: "right-2", x: 0.68, y: 0.37, w: 0.25, h: 0.25, score: 0.8 },
    { id: "left-3", x: 0.05, y: 0.69, w: 0.25, h: 0.25, score: 0.8 },
    { id: "right-3", x: 0.68, y: 0.69, w: 0.25, h: 0.25, score: 0.8 },
  ];

  const decision = choosePanelDetectionFallback({
    panels,
    pageWidth: 1000,
    pageHeight: 1500,
    direction: "rtl",
  });

  assert.equal(decision.strategy, "full-page");
  assert.ok(decision.reasonCodes.includes("reading-order-conflict"));
  assert.deepEqual(decision.panels.map((panel) => panel.id), panels.map((panel) => panel.id));
});

test("invalid regions are dropped without disturbing surviving relative order", () => {
  const panels = regularGrid();
  panels.splice(2, 0, { id: "invalid", x: "bad", y: 0, w: 1, h: 1 });
  const decision = choosePanelDetectionFallback({ panels, pageWidth: 1000, pageHeight: 1500 });

  assert.deepEqual(
    decision.panels.map((panel) => panel.id),
    ["top-left", "top-right", "middle", "bottom-left", "bottom-right"],
  );
  assert.equal(decision.metrics.inputPanelCount, 6);
  assert.equal(decision.metrics.validPanelCount, 5);
  assert.ok(decision.reasonCodes.includes("invalid-regions-dropped"));
});

test("policy output is deterministic and advertises its integration strategies", () => {
  const input = { panels: regularGrid(), pageWidth: 1000, pageHeight: 1500, direction: "ltr" };

  assert.deepEqual(choosePanelDetectionFallback(input), choosePanelDetectionFallback(input));
  assert.equal(panelDetectionPolicy.schemaVersion, 1);
  assert.deepEqual(panelDetectionPolicy.strategies, ["panels", "full-page", "full-width"]);
});
