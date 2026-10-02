const EPSILON = 1e-7;

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function validPanel(panel) {
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

function normalizedPanel(panel) {
  const x = clamp(Number(panel.x));
  const y = clamp(Number(panel.y));
  return {
    ...panel,
    x,
    y,
    w: clamp(Number(panel.w), 0, 1 - x),
    h: clamp(Number(panel.h), 0, 1 - y),
  };
}

function panelSide(panel, gutterX, gutterWidth) {
  const leftEdge = gutterX - gutterWidth / 2;
  const rightEdge = gutterX + gutterWidth / 2;
  const panelRight = panel.x + panel.w;
  if (panelRight <= rightEdge) return "left";
  if (panel.x >= leftEdge) return "right";
  return "crossing";
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Conservatively classify a combined image as a two-page spread. Wide artwork
 * alone is not enough for a high-confidence classification: panel geometry on
 * both sides of a plausible centre gutter raises confidence, while several
 * gutter-crossing panels keep the original detector order intact.
 */
export function classifyPageSpread(input = {}) {
  const pageWidth = Number(input.pageWidth);
  const pageHeight = Number(input.pageHeight);
  const aspect = pageWidth > 0 && pageHeight > 0 ? pageWidth / pageHeight : 0;
  const panels = (Array.isArray(input.panels) ? input.panels : [])
    .filter(validPanel)
    .map(normalizedPanel);
  const gutterX = clamp(Number.isFinite(Number(input.gutterX)) ? Number(input.gutterX) : 0.5, 0.4, 0.6);
  const gutterWidth = clamp(Number.isFinite(Number(input.gutterWidth)) ? Number(input.gutterWidth) : 0.04, 0.01, 0.12);
  const sides = panels.map((panel) => panelSide(panel, gutterX, gutterWidth));
  const leftCount = sides.filter((side) => side === "left").length;
  const rightCount = sides.filter((side) => side === "right").length;
  const crossingCount = sides.filter((side) => side === "crossing").length;
  const hasBothPages = leftCount > 0 && rightCount > 0;
  const crossingRatio = panels.length ? crossingCount / panels.length : 0;

  let confidence = 0;
  const reasonCodes = [];
  if (aspect >= 1.55) {
    confidence += 0.7;
    reasonCodes.push("very-wide-page");
  } else if (aspect >= 1.28) {
    confidence += 0.52;
    reasonCodes.push("wide-page");
  } else if (aspect >= 1.12) {
    confidence += 0.25;
    reasonCodes.push("borderline-wide-page");
  } else {
    reasonCodes.push("portrait-or-square-page");
  }
  if (hasBothPages) {
    confidence += 0.3;
    reasonCodes.push("panels-on-both-sides");
  }
  if (panels.length >= 4 && crossingRatio <= 0.2) {
    confidence += 0.12;
    reasonCodes.push("clear-centre-separation");
  }
  if (crossingRatio >= 0.4) {
    confidence -= 0.22;
    reasonCodes.push("gutter-crossing-layout");
  }
  confidence = clamp(confidence);
  const isSpread = aspect >= 1.28 && confidence >= 0.68;
  const safeToReorder = isSpread && hasBothPages && crossingRatio <= 0.2;

  return {
    schemaVersion: 1,
    isSpread,
    safeToReorder,
    confidence: rounded(confidence),
    aspect: rounded(aspect),
    gutterX: rounded(gutterX),
    gutterWidth: rounded(gutterWidth),
    leftCount,
    rightCount,
    crossingCount,
    reasonCodes,
  };
}

function readingOrderWithinPage(panels, direction) {
  const horizontalSign = direction === "rtl" ? -1 : 1;
  return panels
    .map((panel, index) => ({ panel, index }))
    .sort((left, right) => {
      const a = left.panel;
      const b = right.panel;
      const rowTolerance = Math.max(0.025, Math.min(a.h, b.h) * 0.28);
      const yDelta = (a.y + a.h / 2) - (b.y + b.h / 2);
      if (Math.abs(yDelta) > rowTolerance) return yDelta;
      const xDelta = (a.x + a.w / 2) - (b.x + b.w / 2);
      if (Math.abs(xDelta) > EPSILON) return xDelta * horizontalSign;
      return left.index - right.index;
    })
    .map(({ panel }) => panel);
}

/**
 * Order panels page-by-page for a confidently classified combined spread.
 * Ambiguous/spanning layouts are returned unchanged so this helper cannot turn
 * artistic full-spread compositions into an invented reading sequence.
 */
export function orderSpreadPanels(panels, input = {}) {
  const original = Array.isArray(panels) ? panels.slice() : [];
  const classification = input.classification || classifyPageSpread({ ...input, panels: original });
  if (!classification.safeToReorder) return original;

  const gutterX = classification.gutterX ?? 0.5;
  const gutterWidth = classification.gutterWidth ?? 0.04;
  const groups = { left: [], right: [] };
  for (const panel of original) {
    if (!validPanel(panel)) return original;
    const side = panelSide(normalizedPanel(panel), gutterX, gutterWidth);
    if (side === "crossing") return original;
    groups[side].push(panel);
  }
  const direction = input.direction === "rtl" ? "rtl" : "ltr";
  const pageOrder = direction === "rtl" ? ["right", "left"] : ["left", "right"];
  return pageOrder.flatMap((side) => readingOrderWithinPage(groups[side], direction));
}

export const pageSpreadPolicy = Object.freeze({
  schemaVersion: 1,
  minimumAspect: 1.28,
  minimumConfidence: 0.68,
});
