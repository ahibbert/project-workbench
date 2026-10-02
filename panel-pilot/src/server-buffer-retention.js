export const SERVER_BUFFER_LEDGER_SCHEMA_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1_000;
const MANAGED_PURPOSES = Object.freeze(["reading-ahead", "plan-to-read", "source-test"]);
const MANAGED_PURPOSE_SET = new Set(MANAGED_PURPOSES);
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const DEFAULT_SERVER_BUFFER_RETENTION = Object.freeze({
  readRetentionDays: 30,
  keepRecentCount: 2,
  sourceTestRetentionDays: 1,
});

function safeId(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  const id = value.trim();
  return SAFE_ID_PATTERN.test(id) ? id : null;
}

function timestampMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const milliseconds = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function timestamp(value, label) {
  const milliseconds = value === undefined ? Date.now() : timestampMs(value);
  if (milliseconds === null) throw new TypeError(`${label} must be a valid date.`);
  return milliseconds;
}

function dayCount(value, fallback, label) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 36_500) {
    throw new TypeError(`${label} must be a number from 0 to 36500.`);
  }
  return number;
}

function count(value, fallback, label) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 10_000) {
    throw new TypeError(`${label} must be an integer from 0 to 10000.`);
  }
  return number;
}

function normalizePolicy(policy = {}) {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("policy must be an object.");
  }
  return {
    readRetentionDays: dayCount(
      policy.readRetentionDays,
      DEFAULT_SERVER_BUFFER_RETENTION.readRetentionDays,
      "policy.readRetentionDays",
    ),
    keepRecentCount: count(
      policy.keepRecentCount,
      DEFAULT_SERVER_BUFFER_RETENTION.keepRecentCount,
      "policy.keepRecentCount",
    ),
    sourceTestRetentionDays: dayCount(
      policy.sourceTestRetentionDays,
      DEFAULT_SERVER_BUFFER_RETENTION.sourceTestRetentionDays,
      "policy.sourceTestRetentionDays",
    ),
  };
}

function indexByChapterId(records) {
  const index = new Map();
  for (const record of records) {
    const chapterId = safeId(record?.chapterId);
    if (!chapterId) continue;
    const existing = index.get(chapterId);
    if (existing) existing.push(record);
    else index.set(chapterId, [record]);
  }
  return index;
}

function reasonCounts(decisions) {
  const counts = {};
  for (const decision of decisions) counts[decision.reason] = (counts[decision.reason] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function publicDecision(decision) {
  const result = {
    chapterId: decision.chapterId,
    decision: decision.decision,
    reason: decision.reason,
  };
  if (decision.scopeId) result.scopeId = decision.scopeId;
  if (decision.purpose) result.purpose = decision.purpose;
  return result;
}

function protectedDecision(chapterId, reason, extra = {}) {
  return { chapterId, decision: "protect", reason, ...extra };
}

function managedCandidate(download, chapterId, ledgerRows, activeIds, now, policy) {
  if (activeIds.has(chapterId) || download.activeReader === true) {
    return protectedDecision(chapterId, "active-reader");
  }
  if (download.manual === true || download.origin === "manual" || download.managedBy === "manual") {
    return protectedDecision(chapterId, "manual-download");
  }
  if (download.legacy === true || download.origin === "legacy" || download.origin === "panels-legacy") {
    return protectedDecision(chapterId, "legacy-download");
  }
  if (!ledgerRows?.length) return protectedDecision(chapterId, "unmanaged-download");
  if (ledgerRows.length > 1) return protectedDecision(chapterId, "ambiguous-ledger");

  const ledger = ledgerRows[0];
  if (ledger.schemaVersion !== SERVER_BUFFER_LEDGER_SCHEMA_VERSION) {
    return protectedDecision(chapterId, "legacy-ledger");
  }
  if (ledger.managedBy !== "panels") return protectedDecision(chapterId, "unmanaged-download");

  const scopeId = safeId(ledger.scopeId);
  const purpose = MANAGED_PURPOSE_SET.has(ledger.purpose) ? ledger.purpose : null;
  if (!scopeId || !purpose) return protectedDecision(chapterId, "invalid-ledger");
  const identity = { scopeId, purpose };

  if (purpose === "source-test") {
    const managedAt = timestampMs(ledger.managedAt ?? download.downloadedAt);
    if (managedAt === null) return protectedDecision(chapterId, "missing-timestamp", identity);
    if (now - managedAt < policy.sourceTestRetentionDays * DAY_MS) {
      return protectedDecision(chapterId, "source-test-retention", identity);
    }
    return {
      chapterId,
      decision: "delete",
      reason: "source-test-expired",
      effectiveAt: managedAt,
      ...identity,
    };
  }

  const readAt = timestampMs(download.readAt ?? ledger.readAt);
  if (readAt === null) return protectedDecision(chapterId, "unread", identity);
  if (now - readAt < policy.readRetentionDays * DAY_MS) {
    return protectedDecision(chapterId, "read-retention", identity);
  }
  return {
    chapterId,
    decision: "delete",
    reason: "read-retention-expired",
    effectiveAt: readAt,
    ...identity,
  };
}

function applyKeepRecent(decisions, keepRecentCount) {
  if (keepRecentCount === 0) return;
  const byScope = new Map();
  for (const decision of decisions) {
    if (decision.decision !== "delete" || decision.purpose === "source-test") continue;
    const scope = byScope.get(decision.scopeId);
    if (scope) scope.push(decision);
    else byScope.set(decision.scopeId, [decision]);
  }
  for (const candidates of byScope.values()) {
    candidates.sort((left, right) => (
      right.effectiveAt - left.effectiveAt || left.chapterId.localeCompare(right.chapterId)
    ));
    for (const decision of candidates.slice(0, keepRecentCount)) {
      decision.decision = "protect";
      decision.reason = "keep-recent";
    }
  }
}

function orderedDecisions(decisions) {
  return decisions.slice().sort((left, right) => (
    (left.scopeId || "").localeCompare(right.scopeId || "")
    || left.chapterId.localeCompare(right.chapterId)
  ));
}

/**
 * Builds a conservative cleanup preview and an inert action plan. The caller is
 * responsible for revalidating server state and executing every dequeue before
 * any delete. No title, source, URL, or free-form ledger metadata is returned.
 */
export function planServerBufferRetention(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("input must be an object.");
  }
  const downloads = Array.isArray(input.downloads) ? input.downloads : [];
  const ledger = Array.isArray(input.ledger) ? input.ledger : [];
  const policy = normalizePolicy(input.policy);
  const now = timestamp(input.now, "now");
  const activeIds = new Set(
    (Array.isArray(input.activeReaderChapterIds) ? input.activeReaderChapterIds : [])
      .map(safeId)
      .filter(Boolean),
  );
  const downloadIndex = indexByChapterId(downloads);
  const ledgerIndex = indexByChapterId(ledger);
  const decisions = [];
  let omittedUnsafeIdentifiers = 0;

  for (const download of downloads) {
    const chapterId = safeId(download?.chapterId);
    if (!chapterId) {
      omittedUnsafeIdentifiers += 1;
      continue;
    }
    if (downloadIndex.get(chapterId)?.[0] !== download) continue;
    if (downloadIndex.get(chapterId).length > 1) {
      decisions.push(protectedDecision(chapterId, "ambiguous-download"));
      continue;
    }
    decisions.push(managedCandidate(download, chapterId, ledgerIndex.get(chapterId), activeIds, now, policy));
  }

  applyKeepRecent(decisions, policy.keepRecentCount);
  const ordered = orderedDecisions(decisions);
  const eligible = ordered.filter((decision) => decision.decision === "delete");
  const protectedItems = ordered.filter((decision) => decision.decision === "protect");
  const dequeueActions = eligible.map((decision, index) => ({
    actionId: `dequeue-${index + 1}`,
    type: "dequeue",
    chapterId: decision.chapterId,
  }));
  const deleteActions = eligible.map((decision, index) => ({
    actionId: `delete-${index + 1}`,
    type: "delete",
    chapterId: decision.chapterId,
    afterActionId: dequeueActions[index].actionId,
  }));

  return {
    schemaVersion: 1,
    evaluatedAt: new Date(now).toISOString(),
    policy,
    preview: {
      downloadRecords: downloads.length,
      uniqueSafeDownloads: decisions.length,
      eligible: eligible.length,
      protected: protectedItems.length,
      omittedUnsafeIdentifiers,
      reasons: reasonCounts(ordered),
    },
    eligible: eligible.map(publicDecision),
    protected: protectedItems.map(publicDecision),
    actions: [...dequeueActions, ...deleteActions],
  };
}

export const serverBufferRetentionPolicy = Object.freeze({
  schemaVersion: 1,
  ledgerSchemaVersion: SERVER_BUFFER_LEDGER_SCHEMA_VERSION,
  managedPurposes: MANAGED_PURPOSES,
  defaults: DEFAULT_SERVER_BUFFER_RETENTION,
});
