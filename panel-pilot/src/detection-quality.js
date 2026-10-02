const SUPPORTED_FORMATS = new Set(["manga", "comic", "webtoon"]);
const SUPPORTED_VERDICTS = new Set(["good", "bad", "unrated"]);
const SUPPORTED_ISSUES = new Set([
  "missed-panel",
  "extra-split",
  "bubble-crop",
  "reading-order",
  "spread",
  "bad-fallback",
  "other",
]);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function countOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizedIssues(issues) {
  return [...new Set((Array.isArray(issues) ? issues : [])
    .map((issue) => String(issue || "").trim())
    .filter((issue) => SUPPORTED_ISSUES.has(issue)))];
}

/** Build a compact, privacy-safe record for local quality comparisons. */
export function detectionQualityEntry(input = {}) {
  const decision = input.decision && typeof input.decision === "object" ? input.decision : {};
  const metrics = decision.metrics && typeof decision.metrics === "object" ? decision.metrics : {};
  const format = SUPPORTED_FORMATS.has(input.format) ? input.format : "manga";
  const verdict = SUPPORTED_VERDICTS.has(input.verdict) ? input.verdict : "unrated";
  const detected = countOrNull(input.detectedCount);
  const expected = countOrNull(input.expectedCount);
  const confidence = clamp(finite(decision.confidence) ?? 0);
  const strategy = ["panels", "full-page", "full-width"].includes(decision.strategy)
    ? decision.strategy
    : "unknown";
  const issues = normalizedIssues(input.issues);
  const countDelta = detected === null || expected === null ? null : detected - expected;
  const countMatch = countDelta === null ? null : countDelta === 0;
  const automaticallyRisky = (
    strategy === "unknown"
    || confidence < 0.6
    || (finite(metrics.overlapRatio) ?? 0) > 0.38
    || (finite(metrics.readingOrderViolationRatio) ?? 0) > 0.34
  );
  const accepted = verdict === "good" || (verdict === "unrated" && countMatch === true && !automaticallyRisky);

  return {
    schemaVersion: 1,
    format,
    verdict,
    issues,
    strategy,
    confidence: Math.round(confidence * 1000) / 1000,
    detectedCount: detected,
    expectedCount: expected,
    countDelta,
    countMatch,
    accepted,
    automaticallyRisky,
    reasonCodes: [...new Set((Array.isArray(decision.reasonCodes) ? decision.reasonCodes : [])
      .map((reason) => String(reason || "").trim())
      .filter(Boolean))].slice(0, 20),
    metrics: {
      coverage: finite(metrics.coverage),
      overlapRatio: finite(metrics.overlapRatio),
      readingOrderViolations: countOrNull(metrics.readingOrderViolations),
      pageAspect: finite(metrics.pageAspect),
    },
  };
}

export function aggregateDetectionQuality(entries) {
  const rows = (Array.isArray(entries) ? entries : []).filter((entry) => entry && typeof entry === "object");
  const labeled = rows.filter((entry) => entry.verdict === "good" || entry.verdict === "bad");
  const expected = rows.filter((entry) => entry.countMatch !== null);
  const confidences = rows.map((entry) => finite(entry.confidence)).filter((value) => value !== null);
  const fallbacks = rows.filter((entry) => entry.strategy === "full-page" || entry.strategy === "full-width");
  const risky = rows.filter((entry) => entry.automaticallyRisky || entry.verdict === "bad");
  const accepted = rows.filter((entry) => entry.accepted);
  const issueCounts = {};
  rows.flatMap((entry) => normalizedIssues(entry.issues)).forEach((issue) => {
    issueCounts[issue] = (issueCounts[issue] || 0) + 1;
  });
  return {
    schemaVersion: 1,
    pages: rows.length,
    labeled: labeled.length,
    accepted: accepted.length,
    risky: risky.length,
    fallbacks: fallbacks.length,
    averageConfidence: confidences.length
      ? Math.round((confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 1000) / 1000
      : null,
    countAccuracy: expected.length
      ? Math.round((expected.filter((entry) => entry.countMatch).length / expected.length) * 1000) / 1000
      : null,
    verdictAccuracy: labeled.length
      ? Math.round((labeled.filter((entry) => entry.verdict === "good").length / labeled.length) * 1000) / 1000
      : null,
    issueCounts: Object.fromEntries(Object.entries(issueCounts).sort(([left], [right]) => left.localeCompare(right))),
  };
}

/**
 * Validate a user-created suite without retaining titles, URLs, or credentials
 * in the returned summary. The full manifest remains local to the Test Lab.
 */
export function summarizeDetectionSuite(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("Detection suite must be an object.");
  }
  const cases = Array.isArray(manifest.cases) ? manifest.cases : [];
  if (!cases.length || cases.length > 100) throw new TypeError("Detection suite must contain 1 to 100 cases.");
  const formats = { manga: 0, comic: 0, webtoon: 0 };
  let pageLimit = 0;
  for (const item of cases) {
    if (!item || typeof item !== "object" || !SUPPORTED_FORMATS.has(item.format)) {
      throw new TypeError("Every suite case needs a supported format.");
    }
    const hasSuwayomi = Number.isSafeInteger(Number(item.chapterId)) && Number(item.chapterId) > 0;
    const hasComick = typeof item.url === "string" && /^https:\/\/(?:www\.)?comick\.(?:live|io)\//i.test(item.url);
    if (!hasSuwayomi && !hasComick) throw new TypeError("Every suite case needs a valid chapterId or allowlisted Comick URL.");
    const limit = item.maxPages === undefined ? 0 : Number(item.maxPages);
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 500) throw new TypeError("maxPages must be an integer from 0 to 500.");
    formats[item.format] += 1;
    pageLimit += limit;
  }
  return {
    schemaVersion: 1,
    caseCount: cases.length,
    formats,
    declaredPageLimit: pageLimit,
  };
}

export const detectionQualityContract = Object.freeze({
  schemaVersion: 1,
  formats: Object.freeze([...SUPPORTED_FORMATS]),
  verdicts: Object.freeze([...SUPPORTED_VERDICTS]),
  issues: Object.freeze([...SUPPORTED_ISSUES]),
});
