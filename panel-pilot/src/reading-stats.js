export const READING_STATS_DB_NAME = "panels-reading-stats";
export const READING_STATS_DB_VERSION = 1;
export const READING_STATS_SCHEMA_VERSION = 1;
export const READING_STATS_IDLE_MS = 180_000;

const META_STORE = "metadata";
const OUTBOX_STORE = "outbox";
const CACHE_STORE = "cache";
const SETTINGS_STORE = "settings";
const SUMMARY_CACHE_KEY = "summary";
const SETTINGS_KEY = "preferences";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("IndexedDB request failed.")), { once: true });
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error || new Error("IndexedDB transaction aborted.")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error || new Error("IndexedDB transaction failed.")), { once: true });
  });
}

function mergeEvent(existing, incoming) {
  if (!existing) return incoming;
  if (incoming.type !== "active_minute") return existing;
  const activeMs = Math.min(60_000, Math.max(0, Number(existing.activeMs) || 0) + Math.max(0, Number(incoming.activeMs) || 0));
  return {
    ...existing,
    ...incoming,
    activeMs,
    seconds: Math.min(60, Math.floor(activeMs / 1_000)),
  };
}

export function createIndexedDbReadingStatsStore({ indexedDB = globalThis.indexedDB, databaseName = READING_STATS_DB_NAME } = {}) {
  if (!indexedDB) throw new Error("IndexedDB is not available in this browser.");
  let databasePromise;

  function database() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, READING_STATS_DB_VERSION);
      request.addEventListener("upgradeneeded", () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "key" });
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) db.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE, { keyPath: "key" });
        if (!db.objectStoreNames.contains(SETTINGS_STORE)) db.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
      });
      request.addEventListener("success", () => {
        const db = request.result;
        db.addEventListener("versionchange", () => {
          db.close();
          databasePromise = undefined;
        });
        resolve(db);
      }, { once: true });
      request.addEventListener("error", () => {
        databasePromise = undefined;
        reject(request.error || new Error("Could not open the reading stats database."));
      }, { once: true });
      request.addEventListener("blocked", () => {
        databasePromise = undefined;
        reject(new Error("The reading stats database upgrade is blocked by another Panels tab."));
      }, { once: true });
    });
    return databasePromise;
  }

  async function get(storeName, key) {
    const db = await database();
    const transaction = db.transaction(storeName, "readonly");
    const result = await requestResult(transaction.objectStore(storeName).get(key));
    await transactionComplete(transaction);
    return result?.value ?? null;
  }

  async function put(storeName, key, value) {
    const db = await database();
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put({ key, value: clone(value) });
    await transactionComplete(transaction);
    return clone(value);
  }

  return {
    async init() {
      await database();
    },
    getMeta: (key) => get(META_STORE, key),
    putMeta: (key, value) => put(META_STORE, key, value),
    getCache: (key) => get(CACHE_STORE, key),
    putCache: (key, value) => put(CACHE_STORE, key, value),
    getSettings: () => get(SETTINGS_STORE, SETTINGS_KEY),
    putSettings: (value) => put(SETTINGS_STORE, SETTINGS_KEY, value),
    async upsertEvent(event) {
      const db = await database();
      const transaction = db.transaction(OUTBOX_STORE, "readwrite");
      const store = transaction.objectStore(OUTBOX_STORE);
      const existing = await requestResult(store.get(event.id));
      const merged = mergeEvent(existing, clone(event));
      store.put(merged);
      await transactionComplete(transaction);
      return clone(merged);
    },
    async listEvents() {
      const db = await database();
      const transaction = db.transaction(OUTBOX_STORE, "readonly");
      const events = await requestResult(transaction.objectStore(OUTBOX_STORE).getAll());
      await transactionComplete(transaction);
      return events.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))).map(clone);
    },
    async deleteEvents(ids) {
      const db = await database();
      const transaction = db.transaction(OUTBOX_STORE, "readwrite");
      const store = transaction.objectStore(OUTBOX_STORE);
      for (const id of new Set(ids)) store.delete(id);
      await transactionComplete(transaction);
    },
    async clearUserData() {
      const db = await database();
      const transaction = db.transaction([OUTBOX_STORE, CACHE_STORE, SETTINGS_STORE], "readwrite");
      transaction.objectStore(OUTBOX_STORE).clear();
      transaction.objectStore(CACHE_STORE).clear();
      transaction.objectStore(SETTINGS_STORE).clear();
      await transactionComplete(transaction);
    },
    async close() {
      const db = await databasePromise;
      db?.close();
      databasePromise = undefined;
    },
  };
}

export function createMemoryReadingStatsStore() {
  const metadata = new Map();
  const cache = new Map();
  let settings = null;
  const events = new Map();
  return {
    async init() {},
    async getMeta(key) { return clone(metadata.get(key) ?? null); },
    async putMeta(key, value) { metadata.set(key, clone(value)); return clone(value); },
    async getCache(key) { return clone(cache.get(key) ?? null); },
    async putCache(key, value) { cache.set(key, clone(value)); return clone(value); },
    async getSettings() { return clone(settings); },
    async putSettings(value) { settings = clone(value); return clone(value); },
    async upsertEvent(event) {
      const merged = mergeEvent(events.get(event.id), clone(event));
      events.set(event.id, merged);
      return clone(merged);
    },
    async listEvents() {
      return [...events.values()].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))).map(clone);
    },
    async deleteEvents(ids) { for (const id of new Set(ids)) events.delete(id); },
    async clearUserData() { events.clear(); cache.clear(); settings = null; },
    async close() {},
  };
}

function randomId(cryptoApi = globalThis.crypto, prefix = "") {
  if (typeof cryptoApi?.randomUUID === "function") return `${prefix}${cryptoApi.randomUUID()}`;
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return `${prefix}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  throw new Error("Secure random IDs are not available in this browser.");
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readingStatsOpaqueKey(kind, parts, cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.subtle) throw new Error("SHA-256 is not available in this browser.");
  const normalizedKind = requiredOpaqueKey(kind, "kind");
  const normalizedParts = (Array.isArray(parts) ? parts : [parts]).map((part) => String(part ?? ""));
  const input = new TextEncoder().encode(JSON.stringify(["panels-reading-stats-v1", normalizedKind, ...normalizedParts]));
  const digest = await cryptoApi.subtle.digest("SHA-256", input);
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

function requiredOpaqueKey(value, label) {
  const key = String(value ?? "").trim();
  if (!key) throw new TypeError(`${label} is required.`);
  return key;
}

function isoMinute(timestampMs) {
  return `${new Date(Math.floor(timestampMs / 60_000) * 60_000).toISOString().slice(0, 16)}Z`;
}

function makeJsonRequest(fetchImpl, url, options = {}) {
  return fetchImpl(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
}

export class ReadingActivityTracker {
  constructor({ onBucket, now = () => Date.now(), idleMs = READING_STATS_IDLE_MS, documentTarget = globalThis.document, windowTarget = globalThis.window } = {}) {
    if (typeof onBucket !== "function") throw new TypeError("onBucket must be a function.");
    this.onBucket = onBucket;
    this.now = now;
    this.idleMs = idleMs;
    this.documentTarget = documentTarget;
    this.windowTarget = windowTarget;
    this.running = false;
    this.visible = documentTarget ? documentTarget.visibilityState !== "hidden" : true;
    this.focused = documentTarget?.hasFocus ? documentTarget.hasFocus() : true;
    this.lastInteractionAt = 0;
    this.lastAccountedAt = 0;
    this.context = {};
    this.pending = Promise.resolve();
    this.listeners = [];
  }

  _eligible() {
    return this.running && this.visible && this.focused;
  }

  _emit(start, end) {
    while (start < end) {
      const minuteStart = Math.floor(start / 60_000) * 60_000;
      const boundary = minuteStart + 60_000;
      const sliceEnd = Math.min(end, boundary);
      const activeMs = sliceEnd - start;
      if (activeMs > 0) {
        const bucket = { minute: isoMinute(start), activeMs, ...this.context };
        this.pending = this.pending.then(() => this.onBucket(bucket));
      }
      start = sliceEnd;
    }
  }

  _account(at = this.now()) {
    const end = Number(at);
    if (!Number.isFinite(end) || end <= this.lastAccountedAt) return;
    if (this._eligible()) {
      const activeEnd = Math.min(end, this.lastInteractionAt + this.idleMs);
      if (activeEnd > this.lastAccountedAt) this._emit(this.lastAccountedAt, activeEnd);
    }
    this.lastAccountedAt = end;
  }

  start(context = {}) {
    if (this.running) this.stop();
    const at = this.now();
    this.context = { ...context };
    this.running = true;
    this.visible = this.documentTarget ? this.documentTarget.visibilityState !== "hidden" : true;
    this.focused = this.documentTarget?.hasFocus ? this.documentTarget.hasFocus() : true;
    this.lastInteractionAt = at;
    this.lastAccountedAt = at;
    this._bind();
    return this;
  }

  noteInteraction(at = this.now()) {
    if (!this.running) return;
    this._account(at);
    this.lastInteractionAt = Number(at);
    this.lastAccountedAt = Number(at);
  }

  setVisible(visible, at = this.now()) {
    this._account(at);
    this.visible = Boolean(visible);
    this.lastAccountedAt = Number(at);
    if (this.visible) this.lastInteractionAt = Number(at);
  }

  setFocused(focused, at = this.now()) {
    this._account(at);
    this.focused = Boolean(focused);
    this.lastAccountedAt = Number(at);
    if (this.focused) this.lastInteractionAt = Number(at);
  }

  async checkpoint(at = this.now()) {
    this._account(at);
    await this.pending;
  }

  async stop(at = this.now()) {
    if (!this.running) return this.pending;
    this._account(at);
    this.running = false;
    this._unbind();
    await this.pending;
  }

  _listen(target, type, handler) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, { passive: true });
    this.listeners.push(() => target.removeEventListener(type, handler));
  }

  _bind() {
    const interaction = () => this.noteInteraction();
    for (const type of ["pointerdown", "touchstart", "keydown"]) this._listen(this.documentTarget, type, interaction);
    this._listen(this.documentTarget, "visibilitychange", () => this.setVisible(this.documentTarget.visibilityState !== "hidden"));
    this._listen(this.windowTarget, "focus", () => this.setFocused(true));
    this._listen(this.windowTarget, "blur", () => this.setFocused(false));
    this._listen(this.windowTarget, "pagehide", () => { void this.stop(); });
  }

  _unbind() {
    for (const remove of this.listeners.splice(0)) remove();
  }
}

export function createReadingStatsClient({
  store = createIndexedDbReadingStatsStore(),
  fetchImpl = globalThis.fetch?.bind(globalThis),
  cryptoApi = globalThis.crypto,
  now = () => Date.now(),
  apiBase = "/api/reading-stats",
} = {}) {
  let deviceId;
  let initialization;
  let flushPromise;
  let serverSupported = null;
  const activityEventIds = new Map();

  async function initialize() {
    if (!initialization) initialization = (async () => {
      await store.init();
      deviceId = await store.getMeta("deviceId");
      if (!deviceId) {
        deviceId = randomId(cryptoApi, "device-");
        await store.putMeta("deviceId", deviceId);
      }
      await store.putMeta("schemaVersion", READING_STATS_SCHEMA_VERSION);
      return { deviceId, schemaVersion: READING_STATS_SCHEMA_VERSION };
    })();
    return initialization;
  }

  async function queue(event) {
    await initialize();
    const createdAt = event.occurredAt || event.viewedAt || event.completedAt || new Date(now()).toISOString();
    const normalized = {
      schemaVersion: READING_STATS_SCHEMA_VERSION,
      deviceId,
      createdAt,
      ...event,
    };
    normalized.eventId = normalized.eventId || normalized.id;
    normalized.occurredAt = normalized.occurredAt || createdAt;
    return store.upsertEvent(normalized);
  }

  async function privateContext(context = {}) {
    const titleKey = context.titleKey || (
      context.serverUrl !== undefined && context.mangaId !== undefined
        ? await readingStatsOpaqueKey("title", [context.serverUrl, context.mangaId], cryptoApi)
        : null
    );
    const chapterKey = context.chapterKey || (
      context.serverUrl !== undefined && context.mangaId !== undefined && context.chapterId !== undefined
        ? await readingStatsOpaqueKey("chapter", [context.serverUrl, context.mangaId, context.chapterId], cryptoApi)
        : null
    );
    return {
      titleKey: titleKey ? String(titleKey) : null,
      chapterKey: chapterKey ? String(chapterKey) : null,
      offline: Boolean(context.offline),
    };
  }

  async function recordActivityBucket({ minute, activeMs, ...context }) {
    await initialize();
    const privateFields = await privateContext(context);
    const normalizedMs = Math.min(60_000, Math.max(0, Math.round(Number(activeMs) || 0)));
    if (!normalizedMs) return null;
    const normalizedMinute = isoMinute(Date.parse(minute));
    let eventId = activityEventIds.get(normalizedMinute);
    if (!eventId) {
      const pending = await store.listEvents();
      eventId = pending.find((event) => event.type === "active_minute" && event.minuteKey === normalizedMinute)?.id;
    }
    if (!eventId) eventId = randomId(cryptoApi, `activity:${deviceId}:${normalizedMinute}:`);
    activityEventIds.set(normalizedMinute, eventId);
    return queue({
      id: eventId,
      type: "active_minute",
      minute: normalizedMinute,
      minuteKey: normalizedMinute,
      activeMs: normalizedMs,
      seconds: Math.min(60, Math.floor(normalizedMs / 1_000)),
      ...privateFields,
    });
  }

  async function recordActiveSeconds(seconds, context = {}) {
    const timestamp = context.at === undefined ? now() : new Date(context.at).getTime();
    return recordActivityBucket({ ...context, minute: isoMinute(timestamp), activeMs: Number(seconds) * 1_000 });
  }

  async function recordPageView(context = {}) {
    const privateFields = await privateContext(context);
    if (!privateFields.titleKey || !privateFields.chapterKey) throw new TypeError("A title and chapter identifier are required.");
    const pageIndex = Number(context.pageIndex ?? context.page);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) throw new TypeError("pageIndex must be a non-negative integer.");
    return queue({
      id: randomId(cryptoApi, `page:${deviceId || "pending"}:`),
      type: "page_view",
      ...privateFields,
      pageIndex,
      viewedAt: new Date(context.viewedAt ?? now()).toISOString(),
    });
  }

  async function recordChapterFinish(context = {}) {
    await initialize();
    const privateFields = await privateContext(context);
    if (!privateFields.titleKey || !privateFields.chapterKey) throw new TypeError("A title and chapter identifier are required.");
    const normalizedAttemptId = requiredOpaqueKey(context.attemptId, "attemptId");
    return queue({
      id: `chapter:${deviceId}:${normalizedAttemptId}`,
      type: "chapter_finish",
      attemptId: normalizedAttemptId,
      ...privateFields,
      completedAt: new Date(context.completedAt ?? now()).toISOString(),
    });
  }

  async function recordTitleComplete(context = {}) {
    await initialize();
    const privateFields = await privateContext(context);
    if (!privateFields.titleKey) throw new TypeError("A title identifier is required.");
    return queue({
      id: `title:${deviceId}:${privateFields.titleKey}`,
      type: "title_complete",
      titleKey: privateFields.titleKey,
      offline: privateFields.offline,
      completedAt: new Date(context.completedAt ?? now()).toISOString(),
    });
  }

  async function flush() {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      await initialize();
      const events = await store.listEvents();
      if (!events.length) return { status: "empty", sent: 0, pending: 0, serverSupported };
      if (typeof fetchImpl !== "function") return { status: "offline", sent: 0, pending: events.length, serverSupported };
      let response;
      try {
        response = await makeJsonRequest(fetchImpl, `${apiBase}/events`, {
          method: "POST",
          body: JSON.stringify({ schemaVersion: READING_STATS_SCHEMA_VERSION, deviceId, events }),
        });
      } catch {
        return { status: "offline", sent: 0, pending: events.length, serverSupported };
      }
      if (response.status === 404) {
        serverSupported = false;
        return { status: "unsupported", sent: 0, pending: events.length, serverSupported };
      }
      if (response.status === 401 || response.status === 403) {
        serverSupported = true;
        return { status: "authentication-required", sent: 0, pending: events.length, serverSupported };
      }
      if (!response.ok) {
        serverSupported = true;
        return { status: "retry", sent: 0, pending: events.length, serverSupported };
      }
      serverSupported = true;
      let body = {};
      try { body = await response.json(); } catch { /* A successful empty response acknowledges the batch. */ }
      // Never discard private, locally queued activity unless the server names
      // the exact idempotency keys it accepted. In particular, a disabled
      // server deliberately returns 200 with an empty acknowledgement list.
      const acknowledged = Array.isArray(body.acknowledgedEventIds) ? body.acknowledgedEventIds : [];
      const sentIds = new Set(acknowledged);
      await store.deleteEvents(acknowledged);
      for (const event of events) {
        if (sentIds.has(event.id) && event.type === "active_minute" && activityEventIds.get(event.minuteKey) === event.id) {
          activityEventIds.delete(event.minuteKey);
        }
      }
      const newAchievements = Array.isArray(body.newAchievements)
        ? body.newAchievements
        : Array.isArray(body.newlyUnlocked) ? body.newlyUnlocked : [];
      return {
        status: "sent",
        sent: events.filter((event) => sentIds.has(event.id)).length,
        pending: (await store.listEvents()).length,
        serverSupported,
        newAchievements,
      };
    })().finally(() => { flushPromise = undefined; });
    return flushPromise;
  }

  async function getSummary(range = "30d") {
    await initialize();
    if (!["7d", "30d", "365d", "all"].includes(range)) throw new TypeError("range must be 7d, 30d, 365d, or all.");
    if (typeof fetchImpl === "function") {
      try {
        const response = await makeJsonRequest(fetchImpl, `${apiBase}?range=${encodeURIComponent(range)}`);
        if (response.status === 404) serverSupported = false;
        else if (response.ok) {
          serverSupported = true;
          const summary = await response.json();
          await store.putCache(SUMMARY_CACHE_KEY, { range, summary, cachedAt: new Date(now()).toISOString() });
          return { status: "fresh", summary, serverSupported };
        }
      } catch { /* Use the last private device cache while offline. */ }
    }
    const cached = await store.getCache(SUMMARY_CACHE_KEY);
    return { status: cached ? "cached" : serverSupported === false ? "unsupported" : "offline", summary: cached?.summary ?? null, serverSupported };
  }

  async function getSettings() {
    await initialize();
    return (await store.getSettings()) || {
      enabled: false,
      showStats: true,
      showRhythm: true,
      celebrations: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      dayStartHour: 4,
    };
  }

  async function setSettings(settings) {
    await initialize();
    const saved = { ...(await getSettings()), ...settings, updatedAt: new Date(now()).toISOString() };
    await store.putSettings(saved);
    if (typeof fetchImpl === "function") {
      try {
        const remoteSettings = Object.fromEntries(
          ["enabled", "showStats", "showRhythm", "celebrations", "timezone", "dayStartHour"]
            .filter((key) => saved[key] !== undefined)
            .map((key) => [key, saved[key]])
        );
        const response = await makeJsonRequest(fetchImpl, `${apiBase}/settings`, { method: "POST", body: JSON.stringify(remoteSettings) });
        if (response.status === 404) serverSupported = false;
        else if (response.ok) serverSupported = true;
      } catch { /* Settings remain safely stored on this device. */ }
    }
    return saved;
  }

  async function exportData() {
    await initialize();
    let remote = null;
    if (typeof fetchImpl === "function") {
      try {
        const response = await makeJsonRequest(fetchImpl, `${apiBase}/export`);
        if (response.status === 404) serverSupported = false;
        else if (response.ok) { serverSupported = true; remote = await response.json(); }
      } catch { /* A local export is still useful offline. */ }
    }
    return {
      schemaVersion: READING_STATS_SCHEMA_VERSION,
      exportedAt: new Date(now()).toISOString(),
      serverSupported,
      remote,
      local: {
        settings: await getSettings(),
        cachedSummary: await store.getCache(SUMMARY_CACHE_KEY),
        pendingEvents: await store.listEvents(),
      },
    };
  }

  async function reset({ confirm } = {}) {
    if (confirm !== "ERASE") throw new TypeError('reset requires confirm: "ERASE".');
    await initialize();
    let remoteStatus = "offline";
    if (typeof fetchImpl === "function") {
      try {
        const response = await makeJsonRequest(fetchImpl, `${apiBase}/reset`, { method: "POST", body: JSON.stringify({ confirm }) });
        if (response.status === 404) { serverSupported = false; remoteStatus = "unsupported"; }
        else if (response.ok) { serverSupported = true; remoteStatus = "reset"; }
        else remoteStatus = "retry";
      } catch { /* Local private data can still be erased offline. */ }
    }
    await store.clearUserData();
    activityEventIds.clear();
    return { status: "reset", remoteStatus, serverSupported };
  }

  return {
    initialize,
    getDeviceId: async () => (await initialize()).deviceId,
    createAttemptId: () => randomId(cryptoApi, "attempt-"),
    createActivityTracker: (options = {}) => new ReadingActivityTracker({ ...options, now: options.now || now, onBucket: recordActivityBucket }),
    recordActivityBucket,
    recordActiveSeconds,
    recordPageView,
    recordChapterFinish,
    recordTitleComplete,
    pendingEvents: async () => { await initialize(); return store.listEvents(); },
    getOutbox: async () => { await initialize(); return store.listEvents(); },
    flush,
    getSummary,
    getSettings,
    setSettings,
    exportData,
    reset,
    close: () => store.close(),
  };
}
