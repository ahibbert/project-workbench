const SCHEMA_VERSION = 1;
const MAX_HISTORY_ENTRIES = 2_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

function finiteTimestamp(value, fallback = 0) {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function safeMomentId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,200}$/.test(id) ? id : "";
}

function safeNow(value) {
  const now = finiteTimestamp(value, Date.now());
  return now > 0 ? now : Date.now();
}

/**
 * Normalize locally persisted rediscovery history. The returned structure only
 * contains opaque moment IDs, timestamps, and counters; titles, source names,
 * image URLs, and other content metadata are intentionally never copied.
 */
export function normalizeMomentRediscoveryState(raw = {}) {
  const source = raw && typeof raw === "object" && raw.moments && typeof raw.moments === "object"
    ? raw.moments
    : {};
  const entries = [];
  for (const [rawId, rawEntry] of Object.entries(source)) {
    const id = safeMomentId(rawId);
    if (!id || !rawEntry || typeof rawEntry !== "object") continue;
    const lastShownAt = finiteTimestamp(rawEntry.lastShownAt);
    const showCount = Math.max(0, Math.min(1_000_000, Math.floor(Number(rawEntry.showCount) || 0)));
    if (!lastShownAt && !showCount) continue;
    entries.push([id, { lastShownAt, showCount }]);
  }
  entries.sort((left, right) => right[1].lastShownAt - left[1].lastShownAt || left[0].localeCompare(right[0]));
  return {
    schemaVersion: SCHEMA_VERSION,
    moments: Object.fromEntries(entries.slice(0, MAX_HISTORY_ENTRIES)),
  };
}

export function recordMomentRediscovery(state, momentId, { now = Date.now() } = {}) {
  const id = safeMomentId(momentId);
  const normalized = normalizeMomentRediscoveryState(state);
  if (!id) return normalized;
  const previous = normalized.moments[id] || { lastShownAt: 0, showCount: 0 };
  return normalizeMomentRediscoveryState({
    schemaVersion: SCHEMA_VERSION,
    moments: {
      ...normalized.moments,
      [id]: {
        lastShownAt: safeNow(now),
        showCount: Math.min(1_000_000, previous.showCount + 1),
      },
    },
  });
}

function rediscoveryWeight(entry, now) {
  if (!entry) return 12;
  const unseenDays = Math.max(0, now - entry.lastShownAt) / DAY_MS;
  const recencyWeight = 0.08 + Math.min(8, unseenDays / 14);
  const frequencyPenalty = 1 / Math.sqrt(1 + entry.showCount * 0.35);
  return Math.max(0.01, recencyWeight * frequencyPenalty);
}

/**
 * Pick a moment without mutating either input. Pass a seeded RNG in tests or
 * when a repeatable daily card is desired. Invalid/duplicate IDs are ignored.
 */
export function chooseMomentForRediscovery(
  moments,
  { state = {}, now = Date.now(), rng = Math.random } = {},
) {
  if (!Array.isArray(moments) || !moments.length) return null;
  const candidates = [];
  const seen = new Set();
  for (const moment of moments) {
    const id = safeMomentId(moment?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    candidates.push({ id, moment });
  }
  if (!candidates.length) return null;

  const normalized = normalizeMomentRediscoveryState(state);
  const timestamp = safeNow(now);
  if (candidates.length === 1) {
    return {
      moment: candidates[0].moment,
      reason: normalized.moments[candidates[0].id] ? "only-moment" : "never-shown",
      nextState: recordMomentRediscovery(normalized, candidates[0].id, { now: timestamp }),
    };
  }

  const weighted = candidates.map((candidate) => ({
    ...candidate,
    weight: rediscoveryWeight(normalized.moments[candidate.id], timestamp),
  }));
  const totalWeight = weighted.reduce((sum, candidate) => sum + candidate.weight, 0);
  const randomValue = Math.min(0.999999999999, Math.max(0, Number(rng?.()) || 0));
  let cursor = randomValue * totalWeight;
  let selected = weighted[weighted.length - 1];
  for (const candidate of weighted) {
    cursor -= candidate.weight;
    if (cursor < 0) {
      selected = candidate;
      break;
    }
  }
  const history = normalized.moments[selected.id];
  return {
    moment: selected.moment,
    reason: history ? "long-unseen-weighted" : "never-shown",
    nextState: recordMomentRediscovery(normalized, selected.id, { now: timestamp }),
  };
}

export const momentRediscoveryModel = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  maximumHistoryEntries: MAX_HISTORY_ENTRIES,
});
