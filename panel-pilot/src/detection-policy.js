const POLICY_SCHEMA_VERSION = 1;
const DEFAULT_VIEWPORT_ASPECT = 0.75;
const EPSILON = 1e-7;

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function rounded(value, precision = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

function validPanelShape(panel) {
  return Boolean(
    panel
    && Number.isFinite(Number(panel.x))
    && Number.isFinite(Number(panel.y))
    && Number.isFinite(Number(panel.w))
    && Number.isFinite(Number(panel.h))
    && Number(panel.w) > 0
    && Number(panel.h) > 0
  );
}

function normalizedRect(panel) {
  const x = clamp(Number(panel.x));
  const y = clamp(Number(panel.y));
  return {
    x,
    y,
    w: clamp(Number(panel.w), 0, 1 - x),
    h: clamp(Number(panel.h), 0, 1 - y),
  };
}

function plausiblePanel(panel) {
  const x = Number(panel.x);
  const y = Number(panel.y);
  const width = Number(panel.w);
  const height = Number(panel.h);
  const area = width * height;
  const aspect = width / height;
  return (
    x >= -0.01
    && y >= -0.01
    && x + width <= 1.01
    && y + height <= 1.01
    && width >= 0.045
    && height >= 0.035
    && area >= 0.004
    && area <= 0.94
    && aspect >= 0.08
    && aspect <= 12
  );
}

function unionArea(rectangles) {
  if (!rectangles.length) return 0;
  const xs = [...new Set(rectangles.flatMap((rect) => [rect.x, rect.x + rect.w]))]
    .sort((left, right) => left - right);
  let total = 0;
  for (let index = 0; index < xs.length - 1; index += 1) {
    const x0 = xs[index];
    const x1 = xs[index + 1];
    if (x1 - x0 <= EPSILON) continue;
    const intervals = rectangles
      .filter((rect) => rect.x < x1 - EPSILON && rect.x + rect.w > x0 + EPSILON)
      .map((rect) => [rect.y, rect.y + rect.h])
      .sort((left, right) => left[0] - right[0]);
    if (!intervals.length) continue;
    let coveredY = 0;
    let [start, end] = intervals[0];
    for (let intervalIndex = 1; intervalIndex < intervals.length; intervalIndex += 1) {
      const [nextStart, nextEnd] = intervals[intervalIndex];
      if (nextStart <= end + EPSILON) {
        end = Math.max(end, nextEnd);
      } else {
        coveredY += end - start;
        start = nextStart;
        end = nextEnd;
      }
    }
    coveredY += end - start;
    total += (x1 - x0) * coveredY;
  }
  return clamp(total);
}

function oneDimensionalOverlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function readingTransitionViolation(current, next, direction) {
  const tolerance = 0.035;
  const currentCenterX = current.x + current.w / 2;
  const nextCenterX = next.x + next.w / 2;
  const currentCenterY = current.y + current.h / 2;
  const nextCenterY = next.y + next.h / 2;
  const verticalOverlap = oneDimensionalOverlap(current.y, current.y + current.h, next.y, next.y + next.h);
  const horizontalOverlap = oneDimensionalOverlap(current.x, current.x + current.w, next.x, next.x + next.w);
  const sameRow = verticalOverlap >= Math.min(current.h, next.h) * 0.42;
  const sameColumn = horizontalOverlap >= Math.min(current.w, next.w) * 0.42;

  if (direction === "rtl" && sameRow && nextCenterX > currentCenterX + tolerance) return true;
  if (direction === "ltr" && sameRow && nextCenterX < currentCenterX - tolerance) return true;
  if (sameColumn && nextCenterY < currentCenterY - tolerance) return true;
  return false;
}

function countReadingOrderViolations(rectangles, direction) {
  let count = 0;
  for (let index = 0; index < rectangles.length - 1; index += 1) {
    if (readingTransitionViolation(rectangles[index], rectangles[index + 1], direction)) count += 1;
  }
  return count;
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function countQuality(count) {
  if (count < 1) return 0;
  if (count === 1) return 0.2;
  if (count === 2) return 0.68;
  if (count <= 12) return 1;
  if (count <= 16) return 0.78;
  if (count <= 20) return 0.45;
  return 0.15;
}

function coverageQuality(coverage) {
  if (coverage < 0.18) return clamp((coverage / 0.18) * 0.35);
  if (coverage < 0.35) return 0.35 + ((coverage - 0.18) / 0.17) * 0.65;
  if (coverage <= 0.96) return 1;
  return 0.82;
}

function isFullPageRegion(panel) {
  return (
    panel.x <= 0.04
    && panel.y <= 0.04
    && panel.x + panel.w >= 0.96
    && panel.y + panel.h >= 0.96
  );
}

function chooseSafeFallback(pageAspect, viewportAspect) {
  const tallThreshold = Math.min(0.58, viewportAspect * 0.72);
  return pageAspect > 0 && pageAspect < tallThreshold
    ? { strategy: "full-width", reason: "tall-page-width-fit", fit: "width", label: "Full width" }
    : { strategy: "full-page", reason: "page-fit-safer", fit: "page", label: "Full page" };
}

function uniqueReasonCodes(codes) {
  return [...new Set(codes.filter(Boolean))];
}

/**
 * Assess already ordered normalized panel detections without mutating or sorting
 * them. The reader remains the authority for sanitizing and drawing rectangles.
 *
 * @param {object} input
 * @param {Array<object>} input.panels Detection rectangles in reading order.
 * @param {number} input.pageWidth Natural image width.
 * @param {number} input.pageHeight Natural image height.
 * @param {"ltr"|"rtl"} [input.direction="ltr"] Existing reading direction.
 * @param {number} [input.viewportAspect=0.75] Viewport width divided by height.
 * @returns {object} A deterministic presentation decision and diagnostics.
 */
export function choosePanelDetectionFallback(input = {}) {
  const rawPanels = Array.isArray(input.panels) ? input.panels : [];
  const panels = rawPanels.filter(validPanelShape).map((panel) => ({ ...panel }));
  const rectangles = panels.map(normalizedRect);
  const direction = input.direction === "rtl" ? "rtl" : "ltr";
  const pageWidth = Number(input.pageWidth);
  const pageHeight = Number(input.pageHeight);
  const pageAspect = pageWidth > 0 && pageHeight > 0 ? pageWidth / pageHeight : 0;
  const requestedViewportAspect = Number(input.viewportAspect);
  const viewportAspect = requestedViewportAspect > 0 ? requestedViewportAspect : DEFAULT_VIEWPORT_ASPECT;

  const coverage = unionArea(rectangles);
  const summedArea = rectangles.reduce((sum, rect) => sum + rect.w * rect.h, 0);
  const overlapRatio = summedArea > EPSILON ? clamp((summedArea - coverage) / summedArea) : 0;
  const plausibleCount = panels.filter(plausiblePanel).length;
  const plausibleRatio = rawPanels.length ? plausibleCount / rawPanels.length : 0;
  const scores = panels
    .map((panel) => Number(panel.score))
    .filter((score) => Number.isFinite(score) && score >= 0 && score <= 1);
  const scoreRatio = panels.length ? scores.length / panels.length : 0;
  const meanScore = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
  const medianScore = median(scores);
  const orderViolations = countReadingOrderViolations(rectangles, direction);
  const orderTransitions = Math.max(0, panels.length - 1);
  const orderViolationRatio = orderTransitions ? orderViolations / orderTransitions : 0;

  const detectorQuality = scoreRatio >= 0.5
    ? clamp(((meanScore ?? 0) - 0.25) / 0.5)
    : 0.65;
  const overlapQuality = 1 - clamp(overlapRatio / 0.42);
  const orderQuality = 1 - orderViolationRatio;
  const confidence = clamp(
    countQuality(panels.length) * 0.18
    + coverageQuality(coverage) * 0.26
    + clamp(plausibleRatio) * 0.2
    + overlapQuality * 0.14
    + orderQuality * 0.1
    + detectorQuality * 0.12,
  );

  const problems = [];
  const observations = [];
  if (panels.length < rawPanels.length) observations.push("invalid-regions-dropped");
  if (!panels.length) problems.push("no-valid-panels");
  if (panels.length === 1 && isFullPageRegion(rectangles[0])) problems.push("single-page-region");
  if (panels.length > 20) problems.push("too-many-regions");
  if (panels.length > 0 && coverage < (panels.length <= 2 ? 0.2 : 0.24)) problems.push("sparse-page-coverage");
  if (rawPanels.length > 0 && plausibleRatio < 0.7) problems.push("implausible-panel-geometry");
  if (overlapRatio > 0.38) problems.push("excessive-panel-overlap");
  if (scoreRatio >= 0.7 && ((meanScore ?? 0) < 0.38 || (medianScore ?? 0) < 0.34)) {
    problems.push("low-detector-scores");
  }
  if (orderViolations >= 2 && orderViolationRatio > 0.34) problems.push("reading-order-conflict");
  if (panels.length > 0 && confidence < 0.6) problems.push("low-layout-confidence");

  const useDetectedPanels = problems.length === 0;
  const safeFallback = useDetectedPanels ? null : chooseSafeFallback(pageAspect, viewportAspect);
  const supportingReason = useDetectedPanels
    ? scoreRatio >= 0.7 && (meanScore ?? 0) >= 0.65
      ? "model-scores-strong"
      : scoreRatio === 0 ? "heuristic-unscored" : "layout-signals-consistent"
    : safeFallback.reason;
  const primaryReason = useDetectedPanels ? "confident-layout" : problems[0];
  const reasonCodes = uniqueReasonCodes([
    primaryReason,
    ...problems.slice(1),
    ...observations,
    supportingReason,
  ]);

  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    strategy: useDetectedPanels ? "panels" : safeFallback.strategy,
    confidence: rounded(confidence),
    primaryReason,
    reasonCodes,
    panels,
    fallback: safeFallback ? {
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      label: safeFallback.label,
      fit: safeFallback.fit,
      pageWidth: Number.isFinite(pageWidth) && pageWidth > 0 ? pageWidth : 0,
      pageHeight: Number.isFinite(pageHeight) && pageHeight > 0 ? pageHeight : 0,
    } : null,
    metrics: {
      inputPanelCount: rawPanels.length,
      validPanelCount: panels.length,
      plausiblePanelCount: plausibleCount,
      scoredPanelCount: scores.length,
      coverage: rounded(coverage),
      overlapRatio: rounded(overlapRatio),
      plausibleRatio: rounded(plausibleRatio),
      meanDetectorScore: rounded(meanScore),
      medianDetectorScore: rounded(medianScore),
      readingOrderViolations: orderViolations,
      readingOrderViolationRatio: rounded(orderViolationRatio),
      pageAspect: rounded(pageAspect),
      viewportAspect: rounded(viewportAspect),
    },
  };
}

export const panelDetectionPolicy = Object.freeze({
  schemaVersion: POLICY_SCHEMA_VERSION,
  strategies: Object.freeze(["panels", "full-page", "full-width"]),
});
