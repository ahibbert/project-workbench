const SCHEMA_VERSION = 1;
const MAX_SERIES = 256;
const MAX_SAMPLES = 64;
const MAX_PADDING = 0.06;
const MAX_EDGE_BIAS = 0.03;
const MIN_DETECTOR_CONFIDENCE = 0.65;
const EPSILON = 1e-7;

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function rounded(value, precision = 6) {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

function opaqueSeriesId(value) {
  const id = String(value || "").trim();
  return /^series_[0-9a-f]{16}$/.test(id) ? id : "";
}

/** Derive a stable opaque storage key from existing non-secret source IDs. */
export function makePanelCalibrationSeriesId(...stableIds) {
  const material = stableIds.map((value) => String(value ?? "").trim()).filter(Boolean).join("\u001f");
  if (!material) return "";
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < material.length; index += 1) {
    const code = material.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  const hex = (value) => (value >>> 0).toString(16).padStart(8, "0");
  return `series_${hex(first)}${hex(second)}`;
}

function validRect(rect) {
  return Boolean(
    rect
    && Number.isFinite(Number(rect.x))
    && Number.isFinite(Number(rect.y))
    && Number.isFinite(Number(rect.w))
    && Number.isFinite(Number(rect.h))
    && Number(rect.w) > 0
    && Number(rect.h) > 0
  );
}

function normalizeRect(rect, bounds = { x: 0, y: 0, w: 1, h: 1 }) {
  const boundsX1 = bounds.x + bounds.w;
  const boundsY1 = bounds.y + bounds.h;
  const x0 = clamp(Number(rect.x), bounds.x, Math.max(bounds.x, boundsX1 - EPSILON));
  const y0 = clamp(Number(rect.y), bounds.y, Math.max(bounds.y, boundsY1 - EPSILON));
  const x1 = clamp(Number(rect.x) + Number(rect.w), x0 + EPSILON, boundsX1);
  const y1 = clamp(Number(rect.y) + Number(rect.h), y0 + EPSILON, boundsY1);
  return { ...rect, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function intersectionArea(one, two) {
  const x0 = Math.max(one.x, two.x);
  const y0 = Math.max(one.y, two.y);
  const x1 = Math.min(one.x + one.w, two.x + two.w);
  const y1 = Math.min(one.y + one.h, two.y + two.h);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeProfile(raw) {
  const padding = raw?.padding || {};
  const edgeBias = raw?.edgeBias || {};
  return {
    sampleCount: Math.max(0, Math.min(MAX_SAMPLES, Math.floor(Number(raw?.sampleCount) || 0))),
    padding: {
      x: rounded(clamp(padding.x, 0, MAX_PADDING)),
      y: rounded(clamp(padding.y, 0, MAX_PADDING)),
    },
    edgeBias: {
      x: rounded(clamp(edgeBias.x, -MAX_EDGE_BIAS, MAX_EDGE_BIAS)),
      y: rounded(clamp(edgeBias.y, -MAX_EDGE_BIAS, MAX_EDGE_BIAS)),
    },
  };
}

export function normalizePanelCalibration(raw = {}) {
  const source = raw && typeof raw === "object" && raw.series && typeof raw.series === "object"
    ? raw.series
    : {};
  const entries = Object.entries(source)
    .map(([id, profile]) => [opaqueSeriesId(id), normalizeProfile(profile)])
    .filter(([id, profile]) => id && profile.sampleCount > 0)
    .slice(0, MAX_SERIES);
  return { schemaVersion: SCHEMA_VERSION, series: Object.fromEntries(entries) };
}

function calibrationSample(detectedPanels, acceptedPanels) {
  if (
    !Array.isArray(detectedPanels)
    || !Array.isArray(acceptedPanels)
    || detectedPanels.length !== acceptedPanels.length
    || detectedPanels.length < 1
    || detectedPanels.length > 20
  ) return null;
  const xPadding = [];
  const yPadding = [];
  const xBias = [];
  const yBias = [];
  for (let index = 0; index < detectedPanels.length; index += 1) {
    if (!validRect(detectedPanels[index]) || !validRect(acceptedPanels[index])) return null;
    const detected = normalizeRect(detectedPanels[index]);
    const accepted = normalizeRect(acceptedPanels[index]);
    const detectedArea = detected.w * detected.h;
    const acceptedArea = accepted.w * accepted.h;
    const retained = intersectionArea(detected, accepted) / Math.max(EPSILON, detectedArea);
    if (retained < 0.85 || acceptedArea > detectedArea * 1.6) return null;
    const widthGrowth = Math.max(0, accepted.w / detected.w - 1) / 2;
    const heightGrowth = Math.max(0, accepted.h / detected.h - 1) / 2;
    const detectedCenterX = detected.x + detected.w / 2;
    const detectedCenterY = detected.y + detected.h / 2;
    const acceptedCenterX = accepted.x + accepted.w / 2;
    const acceptedCenterY = accepted.y + accepted.h / 2;
    xPadding.push(clamp(widthGrowth * 0.5, 0, MAX_PADDING));
    yPadding.push(clamp(heightGrowth * 0.5, 0, MAX_PADDING));
    xBias.push(clamp(((acceptedCenterX - detectedCenterX) / detected.w) * 0.4, -MAX_EDGE_BIAS, MAX_EDGE_BIAS));
    yBias.push(clamp(((acceptedCenterY - detectedCenterY) / detected.h) * 0.4, -MAX_EDGE_BIAS, MAX_EDGE_BIAS));
  }
  return {
    padding: { x: median(xPadding), y: median(yPadding) },
    edgeBias: { x: median(xBias), y: median(yBias) },
  };
}

/** Learn an immutable, bounded per-series profile from an explicitly accepted page. */
export function learnPanelCalibration(calibration, observation = {}) {
  const current = normalizePanelCalibration(calibration);
  const seriesId = opaqueSeriesId(observation.seriesId);
  if (!seriesId) return { calibration: current, learned: false, reasonCode: "invalid-series-id" };
  if (observation.reportedBad === true) return { calibration: current, learned: false, reasonCode: "reported-bad" };
  if (observation.confidenceFallback === true || observation.strategy !== "panels") {
    return { calibration: current, learned: false, reasonCode: "confidence-fallback" };
  }
  if (observation.accepted !== true) return { calibration: current, learned: false, reasonCode: "not-accepted" };
  if (Number(observation.detectorConfidence) < MIN_DETECTOR_CONFIDENCE) {
    return { calibration: current, learned: false, reasonCode: "low-confidence" };
  }
  const sample = calibrationSample(observation.detectedPanels, observation.acceptedPanels);
  if (!sample) return { calibration: current, learned: false, reasonCode: "invalid-panel-pairs" };

  const previous = current.series[seriesId] || normalizeProfile();
  const alpha = previous.sampleCount ? 0.2 : 1;
  const blend = (oldValue, nextValue, minimum, maximum) => rounded(clamp(
    oldValue * (1 - alpha) + nextValue * alpha,
    minimum,
    maximum,
  ));
  const profile = {
    sampleCount: Math.min(MAX_SAMPLES, previous.sampleCount + 1),
    padding: {
      x: blend(previous.padding.x, sample.padding.x, 0, MAX_PADDING),
      y: blend(previous.padding.y, sample.padding.y, 0, MAX_PADDING),
    },
    edgeBias: {
      x: blend(previous.edgeBias.x, sample.edgeBias.x, -MAX_EDGE_BIAS, MAX_EDGE_BIAS),
      y: blend(previous.edgeBias.y, sample.edgeBias.y, -MAX_EDGE_BIAS, MAX_EDGE_BIAS),
    },
  };
  return {
    calibration: normalizePanelCalibration({
      schemaVersion: SCHEMA_VERSION,
      series: { ...current.series, [seriesId]: profile },
    }),
    learned: true,
    reasonCode: "accepted-panel-outcome",
  };
}

export function applyPanelCalibration(panel, calibration, seriesId, pageBounds = { x: 0, y: 0, w: 1, h: 1 }) {
  if (!validRect(panel) || !validRect(pageBounds)) return panel;
  const bounds = normalizeRect(pageBounds, pageBounds);
  const base = normalizeRect(panel, bounds);
  const profile = normalizePanelCalibration(calibration).series[opaqueSeriesId(seriesId)];
  if (!profile) return base;
  const shiftX = base.w * profile.edgeBias.x;
  const shiftY = base.h * profile.edgeBias.y;
  const extraX = base.w * profile.padding.x;
  const extraY = base.h * profile.padding.y;
  const x0 = clamp(base.x - extraX + shiftX, bounds.x, bounds.x + bounds.w);
  const y0 = clamp(base.y - extraY + shiftY, bounds.y, bounds.y + bounds.h);
  const x1 = clamp(base.x + base.w + extraX + shiftX, x0 + EPSILON, bounds.x + bounds.w);
  const y1 = clamp(base.y + base.h + extraY + shiftY, y0 + EPSILON, bounds.y + bounds.h);
  return {
    ...panel,
    x: x0,
    y: y0,
    w: x1 - x0,
    h: y1 - y0,
    calibrationSamples: profile.sampleCount,
  };
}

export function bubbleOwnerIndex(bubble, panels) {
  if (!validRect(bubble) || !Array.isArray(panels)) return -1;
  const normalizedBubble = normalizeRect(bubble);
  const centerX = normalizedBubble.x + normalizedBubble.w / 2;
  const centerY = normalizedBubble.y + normalizedBubble.h / 2;
  const area = normalizedBubble.w * normalizedBubble.h;
  let best = { index: -1, score: 0 };
  panels.forEach((rawPanel, index) => {
    if (!validRect(rawPanel)) return;
    const panel = normalizeRect(rawPanel);
    const containsCenter = centerX >= panel.x && centerX <= panel.x + panel.w
      && centerY >= panel.y && centerY <= panel.y + panel.h;
    const overlap = intersectionArea(normalizedBubble, panel) / Math.max(EPSILON, area);
    if (!containsCenter && overlap < 0.15) return;
    const score = (containsCenter ? 2 : 0) + overlap;
    if (score > best.score) best = { index, score };
  });
  return best.index;
}

function overlapLength(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * Expand a panel for owned bubbles that cross its crop. Expansion is bounded by
 * the page, a conservative per-axis limit, and small neighbor-overlap barriers.
 */
export function framePanelForBubbles({
  panel,
  bubbles = [],
  panels = [panel],
  pageBounds = { x: 0, y: 0, w: 1, h: 1 },
  maxNeighborOverlap = 0.02,
} = {}) {
  if (!validRect(panel) || !validRect(pageBounds)) return panel || null;
  const bounds = normalizeRect(pageBounds, pageBounds);
  const base = normalizeRect(panel, bounds);
  const panelIndex = panels.indexOf(panel);
  if (panelIndex < 0) return base;
  const owned = (Array.isArray(bubbles) ? bubbles : [])
    .filter(validRect)
    .map((bubble) => normalizeRect(bubble, bounds))
    .filter((bubble) => bubbleOwnerIndex(bubble, panels) === panelIndex)
    .filter((bubble) => (
      bubble.x < base.x - EPSILON
      || bubble.y < base.y - EPSILON
      || bubble.x + bubble.w > base.x + base.w + EPSILON
      || bubble.y + bubble.h > base.y + base.h + EPSILON
    ));
  if (!owned.length) return { ...base, bubbleCount: 0, clippedBubbleCount: 0, neighborLimited: false };

  const maxX = Math.min(0.1, Math.max(0.02, base.w * 0.25));
  const maxY = Math.min(0.08, Math.max(0.015, base.h * 0.25));
  let x0 = base.x;
  let y0 = base.y;
  let x1 = base.x + base.w;
  let y1 = base.y + base.h;
  for (const bubble of owned) {
    const marginX = Math.min(0.012, Math.max(0.003, bubble.w * 0.08));
    const marginY = Math.min(0.01, Math.max(0.002, bubble.h * 0.08));
    x0 = Math.min(x0, Math.max(base.x - maxX, bubble.x - marginX));
    y0 = Math.min(y0, Math.max(base.y - maxY, bubble.y - marginY));
    x1 = Math.max(x1, Math.min(base.x + base.w + maxX, bubble.x + bubble.w + marginX));
    y1 = Math.max(y1, Math.min(base.y + base.h + maxY, bubble.y + bubble.h + marginY));
  }

  let neighborLimited = false;
  const baseCenterX = base.x + base.w / 2;
  const baseCenterY = base.y + base.h / 2;
  for (const rawNeighbor of panels) {
    if (rawNeighbor === panel || !validRect(rawNeighbor)) continue;
    const neighbor = normalizeRect(rawNeighbor, bounds);
    const neighborCenterX = neighbor.x + neighbor.w / 2;
    const neighborCenterY = neighbor.y + neighbor.h / 2;
    const verticalAffinity = overlapLength(base.y, base.y + base.h, neighbor.y, neighbor.y + neighbor.h)
      / Math.max(EPSILON, Math.min(base.h, neighbor.h));
    const horizontalAffinity = overlapLength(base.x, base.x + base.w, neighbor.x, neighbor.x + neighbor.w)
      / Math.max(EPSILON, Math.min(base.w, neighbor.w));
    if (verticalAffinity >= 0.2 && neighborCenterX < baseCenterX) {
      const limit = neighbor.x + neighbor.w - neighbor.w * clamp(maxNeighborOverlap, 0, 0.1);
      if (x0 < limit && limit < base.x) { x0 = limit; neighborLimited = true; }
    }
    if (verticalAffinity >= 0.2 && neighborCenterX > baseCenterX) {
      const limit = neighbor.x + neighbor.w * clamp(maxNeighborOverlap, 0, 0.1);
      if (x1 > limit && limit > base.x + base.w) { x1 = limit; neighborLimited = true; }
    }
    if (horizontalAffinity >= 0.2 && neighborCenterY < baseCenterY) {
      const limit = neighbor.y + neighbor.h - neighbor.h * clamp(maxNeighborOverlap, 0, 0.1);
      if (y0 < limit && limit < base.y) { y0 = limit; neighborLimited = true; }
    }
    if (horizontalAffinity >= 0.2 && neighborCenterY > baseCenterY) {
      const limit = neighbor.y + neighbor.h * clamp(maxNeighborOverlap, 0, 0.1);
      if (y1 > limit && limit > base.y + base.h) { y1 = limit; neighborLimited = true; }
    }
  }
  x0 = clamp(x0, bounds.x, bounds.x + bounds.w);
  y0 = clamp(y0, bounds.y, bounds.y + bounds.h);
  x1 = clamp(x1, x0 + EPSILON, bounds.x + bounds.w);
  y1 = clamp(y1, y0 + EPSILON, bounds.y + bounds.h);
  return {
    ...panel,
    x: x0,
    y: y0,
    w: x1 - x0,
    h: y1 - y0,
    bubbleCount: owned.length,
    clippedBubbleCount: owned.filter((bubble) => (
      bubble.x < x0 || bubble.y < y0 || bubble.x + bubble.w > x1 || bubble.y + bubble.h > y1
    )).length,
    neighborLimited,
  };
}

export const panelCalibrationModel = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  maximumSeries: MAX_SERIES,
  maximumSamplesPerSeries: MAX_SAMPLES,
  maximumPadding: MAX_PADDING,
  maximumEdgeBias: MAX_EDGE_BIAS,
  minimumDetectorConfidence: MIN_DETECTOR_CONFIDENCE,
});
