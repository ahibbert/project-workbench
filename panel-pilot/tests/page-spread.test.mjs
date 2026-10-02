import assert from "node:assert/strict";
import test from "node:test";

import { classifyPageSpread, orderSpreadPanels, pageSpreadPolicy } from "../src/page-spread.js";

const spreadPanels = [
  { id: "left-top", x: 0.03, y: 0.04, w: 0.42, h: 0.4 },
  { id: "right-top", x: 0.55, y: 0.04, w: 0.42, h: 0.4 },
  { id: "left-bottom", x: 0.03, y: 0.52, w: 0.42, h: 0.42 },
  { id: "right-bottom", x: 0.55, y: 0.52, w: 0.42, h: 0.42 },
];

test("a wide image with separated content on both halves is a safe spread", () => {
  const result = classifyPageSpread({ pageWidth: 2400, pageHeight: 1600, panels: spreadPanels });
  assert.equal(result.isSpread, true);
  assert.equal(result.safeToReorder, true);
  assert.equal(result.leftCount, 2);
  assert.equal(result.rightCount, 2);
  assert.ok(result.confidence >= pageSpreadPolicy.minimumConfidence);
});

test("a portrait comic page is never classified as a spread", () => {
  const result = classifyPageSpread({ pageWidth: 1000, pageHeight: 1500, panels: spreadPanels });
  assert.equal(result.isSpread, false);
  assert.equal(result.safeToReorder, false);
});

test("an artistic wide composition with crossing panels is not reordered", () => {
  const panels = [
    ...spreadPanels.slice(0, 2),
    { id: "splash", x: 0.08, y: 0.46, w: 0.84, h: 0.48 },
    { id: "caption", x: 0.42, y: 0.02, w: 0.16, h: 0.18 },
  ];
  const result = classifyPageSpread({ pageWidth: 2400, pageHeight: 1500, panels });
  assert.equal(result.isSpread, true);
  assert.equal(result.safeToReorder, false);
  assert.deepEqual(orderSpreadPanels(panels, { classification: result, direction: "ltr" }), panels);
});

test("LTR spreads finish the left page before entering the right page", () => {
  const result = orderSpreadPanels(spreadPanels, {
    pageWidth: 2400,
    pageHeight: 1600,
    direction: "ltr",
  });
  assert.deepEqual(result.map((panel) => panel.id), ["left-top", "left-bottom", "right-top", "right-bottom"]);
});

test("RTL spreads finish the right page before entering the left page", () => {
  const result = orderSpreadPanels(spreadPanels, {
    pageWidth: 2400,
    pageHeight: 1600,
    direction: "rtl",
  });
  assert.deepEqual(result.map((panel) => panel.id), ["right-top", "right-bottom", "left-top", "left-bottom"]);
});

test("classification and ordering leave inputs untouched", () => {
  const snapshot = structuredClone(spreadPanels);
  classifyPageSpread({ pageWidth: 2400, pageHeight: 1600, panels: spreadPanels });
  orderSpreadPanels(spreadPanels, { pageWidth: 2400, pageHeight: 1600, direction: "rtl" });
  assert.deepEqual(spreadPanels, snapshot);
});
