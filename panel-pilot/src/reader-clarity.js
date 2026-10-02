const clarityProfiles = Object.freeze({
  off: Object.freeze({ maxDeviceScale: Number.POSITIVE_INFINITY, maxExpansion: 1 }),
  balanced: Object.freeze({ maxDeviceScale: 1.8, maxExpansion: 1.18 }),
  maximum: Object.freeze({ maxDeviceScale: 1.3, maxExpansion: 1.75 }),
});

function bounded(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

export function normalizeHighZoomClarity(value) {
  return Object.hasOwn(clarityProfiles, value) ? value : "balanced";
}

export function cameraScaleForRect(rect, {
  pageWidth,
  pageHeight,
  stageWidth,
  stageHeight,
} = {}) {
  const sourceWidth = Math.max(1, Number(pageWidth) * Math.max(0.001, Number(rect?.w) || 0));
  const sourceHeight = Math.max(1, Number(pageHeight) * Math.max(0.001, Number(rect?.h) || 0));
  return Math.min(
    Math.max(1, Number(stageWidth) || 0) / sourceWidth,
    Math.max(1, Number(stageHeight) || 0) / sourceHeight,
  );
}

function centeredRect(rect, factor) {
  const width = bounded((Number(rect.w) || 0.001) * factor, 0.001, 1);
  const height = bounded((Number(rect.h) || 0.001) * factor, 0.001, 1);
  const centerX = bounded((Number(rect.x) || 0) + (Number(rect.w) || 0) / 2, 0, 1);
  const centerY = bounded((Number(rect.y) || 0) + (Number(rect.h) || 0) / 2, 0, 1);
  return {
    ...rect,
    x: bounded(centerX - width / 2, 0, 1 - width),
    y: bounded(centerY - height / 2, 0, 1 - height),
    w: width,
    h: height,
  };
}

export function clarityAwarePanelRect(rect, dimensions = {}, mode = "balanced") {
  const normalizedMode = normalizeHighZoomClarity(mode);
  const profile = clarityProfiles[normalizedMode];
  const devicePixelRatio = bounded(dimensions.devicePixelRatio || 1, 1, 4);
  const scaleBefore = cameraScaleForRect(rect, dimensions);
  const deviceScaleBefore = scaleBefore * devicePixelRatio;
  const requiredExpansion = deviceScaleBefore / profile.maxDeviceScale;

  if (normalizedMode === "off" || requiredExpansion <= 1.025) {
    return {
      rect,
      applied: false,
      mode: normalizedMode,
      expansionFactor: 1,
      deviceScaleBefore,
      deviceScaleAfter: deviceScaleBefore,
    };
  }

  const expansionFactor = bounded(requiredExpansion, 1, profile.maxExpansion);
  const expanded = centeredRect(rect, expansionFactor);
  const deviceScaleAfter = cameraScaleForRect(expanded, dimensions) * devicePixelRatio;
  return {
    rect: expanded,
    applied: expanded.w > rect.w + 0.0005 || expanded.h > rect.h + 0.0005,
    mode: normalizedMode,
    expansionFactor,
    deviceScaleBefore,
    deviceScaleAfter,
  };
}

export function highZoomClarityProfile(mode = "balanced") {
  return { ...clarityProfiles[normalizeHighZoomClarity(mode)] };
}
