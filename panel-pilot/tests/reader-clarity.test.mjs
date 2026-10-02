import assert from "node:assert/strict";
import test from "node:test";

import {
  cameraScaleForRect,
  clarityAwarePanelRect,
  normalizeHighZoomClarity,
} from "../src/reader-clarity.js";

const dimensions = {
  pageWidth: 1200,
  pageHeight: 1800,
  stageWidth: 768,
  stageHeight: 1024,
  devicePixelRatio: 2,
};

test("clarity modes normalize to the balanced default", () => {
  assert.equal(normalizeHighZoomClarity("off"), "off");
  assert.equal(normalizeHighZoomClarity("maximum"), "maximum");
  assert.equal(normalizeHighZoomClarity("unknown"), "balanced");
});

test("balanced clarity expands an excessively enlarged crop conservatively", () => {
  const original = { x: 0.2, y: 0.3, w: 0.28, h: 0.18 };
  const result = clarityAwarePanelRect(original, dimensions, "balanced");

  assert.equal(result.applied, true);
  assert.ok(result.expansionFactor > 1);
  assert.ok(result.expansionFactor <= 1.18);
  assert.ok(result.rect.w > original.w);
  assert.ok(result.rect.h > original.h);
  assert.ok(result.deviceScaleAfter < result.deviceScaleBefore);
});

test("maximum clarity preserves more source pixels than balanced", () => {
  const original = { x: 0.02, y: 0.01, w: 0.22, h: 0.12 };
  const balanced = clarityAwarePanelRect(original, dimensions, "balanced");
  const maximum = clarityAwarePanelRect(original, dimensions, "maximum");

  assert.ok(maximum.rect.w > balanced.rect.w);
  assert.ok(maximum.rect.h > balanced.rect.h);
  assert.ok(maximum.deviceScaleAfter < balanced.deviceScaleAfter);
  assert.ok(maximum.rect.x >= 0);
  assert.ok(maximum.rect.y >= 0);
  assert.ok(maximum.rect.x + maximum.rect.w <= 1);
  assert.ok(maximum.rect.y + maximum.rect.h <= 1);
});

test("off mode leaves framing and scale untouched", () => {
  const original = { x: 0.2, y: 0.3, w: 0.28, h: 0.18 };
  const result = clarityAwarePanelRect(original, dimensions, "off");

  assert.equal(result.rect, original);
  assert.equal(result.applied, false);
  assert.equal(result.deviceScaleAfter, result.deviceScaleBefore);
  assert.equal(cameraScaleForRect(original, dimensions) * 2, result.deviceScaleBefore);
});
