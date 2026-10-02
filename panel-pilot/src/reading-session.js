export const READING_SESSION_SCHEMA_VERSION = 1;
export const READING_SESSION_EXPIRY_MS = 30 * 60 * 1_000;
export const READING_SESSION_CHECK_IN_CHAPTERS = 3;
export const READING_SESSION_CHECK_IN_ACTIVE_MS = 45 * 60 * 1_000;

const MAX_RESTORED_KEYS = 50_000;
let fallbackId = 0;

function timestamp(value, label = "timestamp") {
  const milliseconds = value === undefined
    ? Date.now()
    : value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${label} must be a valid date.`);
  return new Date(milliseconds).toISOString();
}

function requiredKey(value, label) {
  const key = String(value ?? "").trim();
  if (!key) throw new TypeError(`${label} is required.`);
  if (key.length > 500) throw new TypeError(`${label} must be at most 500 characters.`);
  return key;
}

function optionalKey(value, label) {
  if (value === null || value === undefined || String(value).trim() === "") return "";
  return requiredKey(value, label);
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${label} must be a non-negative integer.`);
  return number;
}

function positiveThreshold(value, fallback, label) {
  if (value === null || value === false || Number(value) === 0) return null;
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${label} must be a positive integer or null.`);
  return number;
}

function normalizedCheckIn(checkIn = {}) {
  if (checkIn === false || checkIn?.enabled === false) {
    return { chapterThreshold: null, activeMsThreshold: null };
  }
  if (checkIn !== null && typeof checkIn !== "object") throw new TypeError("checkIn must be an object or false.");
  return {
    chapterThreshold: positiveThreshold(
      checkIn?.chapterThreshold,
      READING_SESSION_CHECK_IN_CHAPTERS,
      "checkIn.chapterThreshold",
    ),
    activeMsThreshold: positiveThreshold(
      checkIn?.activeMsThreshold,
      READING_SESSION_CHECK_IN_ACTIVE_MS,
      "checkIn.activeMsThreshold",
    ),
  };
}

function normalizedStringArray(values, label) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > MAX_RESTORED_KEYS) {
    throw new TypeError(`${label} must be an array with at most ${MAX_RESTORED_KEYS} items.`);
  }
  return [...new Set(values.map((value) => requiredKey(value, label)))];
}

function createSessionId(at) {
  if (typeof globalThis.crypto?.randomUUID === "function") return `session-${globalThis.crypto.randomUUID()}`;
  fallbackId += 1;
  return `session-${Date.parse(at).toString(36)}-${fallbackId.toString(36)}`;
}

function normalizedPendingCheckIn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("pendingCheckIn must be an object or null.");
  const reasons = Array.isArray(value.reasons)
    ? [...new Set(value.reasons.filter((reason) => reason === "chapters" || reason === "active-time"))]
    : [];
  if (!reasons.length) throw new TypeError("pendingCheckIn must include a valid reason.");
  return {
    claimedAt: timestamp(value.claimedAt, "pendingCheckIn.claimedAt"),
    reasons,
    chaptersSinceCheckIn: nonNegativeInteger(value.chaptersSinceCheckIn, "pendingCheckIn.chaptersSinceCheckIn"),
    activeMsSinceCheckIn: nonNegativeInteger(value.activeMsSinceCheckIn, "pendingCheckIn.activeMsSinceCheckIn"),
  };
}

function snapshotPendingCheckIn(value) {
  return value ? { ...value, reasons: [...value.reasons] } : null;
}

export class ReadingSession {
  constructor(options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("ReadingSession options must be an object.");
    }
    const startedAt = timestamp(options.startedAt ?? options.now, "startedAt");
    this.version = READING_SESSION_SCHEMA_VERSION;
    this.id = optionalKey(options.id, "id") || createSessionId(startedAt);
    this.startedAt = startedAt;
    this.lastActiveAt = timestamp(options.lastActiveAt ?? startedAt, "lastActiveAt");
    this.activeMs = nonNegativeInteger(options.activeMs ?? 0, "activeMs");
    this.pageKeys = new Set(normalizedStringArray(options.pageKeys, "pageKeys"));
    this.chapterAttemptIds = new Set(normalizedStringArray(options.chapterAttemptIds, "chapterAttemptIds"));
    this.titleKeys = new Set(normalizedStringArray(options.titleKeys, "titleKeys"));
    this.checkIn = normalizedCheckIn(options.checkIn);
    this.lastCheckInChapterCount = nonNegativeInteger(
      options.lastCheckInChapterCount ?? 0,
      "lastCheckInChapterCount",
    );
    this.lastCheckInActiveMs = nonNegativeInteger(options.lastCheckInActiveMs ?? 0, "lastCheckInActiveMs");
    if (this.lastCheckInChapterCount > this.chapterAttemptIds.size) {
      throw new TypeError("lastCheckInChapterCount cannot exceed chaptersFinished.");
    }
    if (this.lastCheckInActiveMs > this.activeMs) {
      throw new TypeError("lastCheckInActiveMs cannot exceed activeMs.");
    }
    this.pendingCheckIn = normalizedPendingCheckIn(options.pendingCheckIn);
    this.finishedAt = options.finishedAt ? timestamp(options.finishedAt, "finishedAt") : null;
    this.finishReason = this.finishedAt ? optionalKey(options.finishReason, "finishReason") || "finished" : null;
  }

  get finished() {
    return Boolean(this.finishedAt);
  }

  touchTitle(titleKey) {
    const key = optionalKey(titleKey, "titleKey");
    if (key) this.titleKeys.add(key);
    return key;
  }

  touch(at) {
    const next = timestamp(at, "at");
    if (Date.parse(next) > Date.parse(this.lastActiveAt)) this.lastActiveAt = next;
    return this.lastActiveAt;
  }

  addActiveTime(activeMs, { at, titleKey } = {}) {
    if (this.finished) return 0;
    const increment = Number(activeMs);
    if (!Number.isSafeInteger(increment) || increment < 0) {
      throw new TypeError("activeMs must be a non-negative integer.");
    }
    this.touchTitle(titleKey);
    if (!increment) return 0;
    if (!Number.isSafeInteger(this.activeMs + increment)) throw new RangeError("Session active time is too large.");
    this.activeMs += increment;
    this.touch(at);
    return increment;
  }

  recordPage({ pageKey, titleKey, at } = {}) {
    if (this.finished) return false;
    const key = requiredKey(pageKey, "pageKey");
    this.touchTitle(titleKey);
    this.touch(at);
    const previousSize = this.pageKeys.size;
    this.pageKeys.add(key);
    return this.pageKeys.size !== previousSize;
  }

  recordChapterFinish({ attemptId, titleKey, at } = {}) {
    if (this.finished) return false;
    const key = requiredKey(attemptId, "attemptId");
    this.touchTitle(titleKey);
    this.touch(at);
    const previousSize = this.chapterAttemptIds.size;
    this.chapterAttemptIds.add(key);
    return this.chapterAttemptIds.size !== previousSize;
  }

  checkInStatus() {
    const chaptersSinceCheckIn = Math.max(0, this.chapterAttemptIds.size - this.lastCheckInChapterCount);
    const activeMsSinceCheckIn = Math.max(0, this.activeMs - this.lastCheckInActiveMs);
    if (this.finished) {
      return { due: false, pending: false, reasons: [], chaptersSinceCheckIn, activeMsSinceCheckIn };
    }
    if (this.pendingCheckIn) {
      return {
        due: true,
        pending: true,
        reasons: [...this.pendingCheckIn.reasons],
        chaptersSinceCheckIn: this.pendingCheckIn.chaptersSinceCheckIn,
        activeMsSinceCheckIn: this.pendingCheckIn.activeMsSinceCheckIn,
      };
    }
    const reasons = [];
    if (this.checkIn.chapterThreshold !== null && chaptersSinceCheckIn >= this.checkIn.chapterThreshold) {
      reasons.push("chapters");
    }
    if (this.checkIn.activeMsThreshold !== null && activeMsSinceCheckIn >= this.checkIn.activeMsThreshold) {
      reasons.push("active-time");
    }
    return { due: reasons.length > 0, pending: false, reasons, chaptersSinceCheckIn, activeMsSinceCheckIn };
  }

  claimCheckIn({ at } = {}) {
    const status = this.checkInStatus();
    if (!status.due || status.pending || this.finished) return status;
    this.pendingCheckIn = {
      claimedAt: timestamp(at, "at"),
      reasons: [...status.reasons],
      chaptersSinceCheckIn: status.chaptersSinceCheckIn,
      activeMsSinceCheckIn: status.activeMsSinceCheckIn,
    };
    return { ...status, pending: true };
  }

  acknowledgeCheckIn({ at } = {}) {
    if (this.finished || !this.pendingCheckIn) return false;
    this.lastCheckInChapterCount = this.chapterAttemptIds.size;
    this.lastCheckInActiveMs = this.activeMs;
    this.pendingCheckIn = null;
    this.touch(at);
    return true;
  }

  isExpired({ now = Date.now(), expiryMs = READING_SESSION_EXPIRY_MS } = {}) {
    if (this.finished) return false;
    const interval = Number(expiryMs);
    if (!Number.isSafeInteger(interval) || interval < 1) throw new TypeError("expiryMs must be a positive integer.");
    const current = Date.parse(timestamp(now, "now"));
    return current - Date.parse(this.lastActiveAt) >= interval;
  }

  recap({ endedAt = this.finishedAt || this.lastActiveAt, reason = this.finishReason || "active" } = {}) {
    const normalizedEndedAt = timestamp(endedAt, "endedAt");
    return {
      schemaVersion: READING_SESSION_SCHEMA_VERSION,
      sessionId: this.id,
      startedAt: this.startedAt,
      endedAt: normalizedEndedAt,
      reason,
      activeMs: this.activeMs,
      pagesViewed: this.pageKeys.size,
      chaptersFinished: this.chapterAttemptIds.size,
      titlesTouched: this.titleKeys.size,
      elapsedMs: Math.max(0, Date.parse(normalizedEndedAt) - Date.parse(this.startedAt)),
    };
  }

  finish({ at, reason = "finished" } = {}) {
    if (!this.finished) {
      this.finishedAt = timestamp(at, "at");
      this.finishReason = optionalKey(reason, "reason") || "finished";
      this.pendingCheckIn = null;
    }
    return this.recap();
  }

  snapshot() {
    return {
      schemaVersion: READING_SESSION_SCHEMA_VERSION,
      id: this.id,
      startedAt: this.startedAt,
      lastActiveAt: this.lastActiveAt,
      activeMs: this.activeMs,
      pagesViewed: this.pageKeys.size,
      chaptersFinished: this.chapterAttemptIds.size,
      titlesTouched: this.titleKeys.size,
      checkIn: { ...this.checkIn },
      checkInStatus: this.checkInStatus(),
      pendingCheckIn: snapshotPendingCheckIn(this.pendingCheckIn),
      finishedAt: this.finishedAt,
      finishReason: this.finishReason,
    };
  }

  toJSON() {
    return {
      schemaVersion: READING_SESSION_SCHEMA_VERSION,
      id: this.id,
      startedAt: this.startedAt,
      lastActiveAt: this.lastActiveAt,
      activeMs: this.activeMs,
      pageKeys: [...this.pageKeys],
      chapterAttemptIds: [...this.chapterAttemptIds],
      titleKeys: [...this.titleKeys],
      checkIn: { ...this.checkIn },
      lastCheckInChapterCount: this.lastCheckInChapterCount,
      lastCheckInActiveMs: this.lastCheckInActiveMs,
      pendingCheckIn: snapshotPendingCheckIn(this.pendingCheckIn),
      finishedAt: this.finishedAt,
      finishReason: this.finishReason,
    };
  }

  serialize() {
    return JSON.stringify(this.toJSON());
  }
}

export function createReadingSession(options = {}) {
  return new ReadingSession(options);
}

export function serializeReadingSession(session) {
  if (!(session instanceof ReadingSession)) throw new TypeError("session must be a ReadingSession.");
  return session.serialize();
}

export function restoreReadingSession(serialized, { now = Date.now(), expiryMs = READING_SESSION_EXPIRY_MS } = {}) {
  let payload;
  try {
    payload = typeof serialized === "string" ? JSON.parse(serialized) : structuredClone(serialized);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("Invalid session payload.");
    if (payload.schemaVersion !== READING_SESSION_SCHEMA_VERSION) throw new TypeError("Unsupported session schema.");
    const session = new ReadingSession({
      ...payload,
      checkIn: payload.checkIn,
    });
    if (session.finished) return { status: "finished", session: null, recap: session.recap() };
    if (session.isExpired({ now, expiryMs })) {
      return {
        status: "expired",
        session: null,
        recap: session.recap({ endedAt: session.lastActiveAt, reason: "expired" }),
      };
    }
    return { status: "active", session, recap: null };
  } catch {
    return { status: "invalid", session: null, recap: null };
  }
}
