import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

import {
  READING_STATS_IDLE_MS,
  READING_STATS_SCHEMA_VERSION,
  ReadingActivityTracker,
  createMemoryReadingStatsStore,
  createReadingStatsClient,
  readingStatsOpaqueKey,
} from "../src/reading-stats.js";

function deterministicCrypto() {
  let counter = 0;
  return {
    subtle: webcrypto.subtle,
    randomUUID: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  };
}

function response(status, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
  };
}

test("device ID is random once and remains stable across client instances", async () => {
  const store = createMemoryReadingStatsStore();
  const cryptoApi = deterministicCrypto();
  const first = createReadingStatsClient({ store, cryptoApi, fetchImpl: null });
  const firstId = await first.getDeviceId();
  const second = createReadingStatsClient({ store, cryptoApi, fetchImpl: null });

  assert.match(firstId, /^device-/);
  assert.equal(await second.getDeviceId(), firstId);
});

test("opaque keys are stable SHA-256 values and do not expose source identifiers", async () => {
  const one = await readingStatsOpaqueKey("chapter", ["https://private.example", "manga-42", "chapter-9"], webcrypto);
  const two = await readingStatsOpaqueKey("chapter", ["https://private.example", "manga-42", "chapter-9"], webcrypto);
  const other = await readingStatsOpaqueKey("chapter", ["https://private.example", "manga-42", "chapter-10"], webcrypto);

  assert.equal(one, two);
  assert.notEqual(one, other);
  assert.match(one, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(one, /private|manga|chapter-9/);
});

test("activity tracker counts only foreground focused reading and stops after three idle minutes", async () => {
  let clock = Date.parse("2026-10-02T01:00:30.000Z");
  const buckets = [];
  const tracker = new ReadingActivityTracker({
    now: () => clock,
    documentTarget: null,
    windowTarget: null,
    onBucket: async (bucket) => buckets.push(bucket),
  });
  tracker.start({ titleKey: "sha256:title", chapterKey: "sha256:chapter" });
  clock += READING_STATS_IDLE_MS + 60_000;
  await tracker.checkpoint();
  tracker.noteInteraction();
  clock += 30_000;
  tracker.setVisible(false);
  clock += 90_000;
  tracker.setVisible(true);
  clock += 10_000;
  await tracker.stop();

  assert.equal(buckets.reduce((total, bucket) => total + bucket.activeMs, 0), 220_000);
  assert.deepEqual(buckets.map((bucket) => bucket.minute), [
    "2026-10-02T01:00Z",
    "2026-10-02T01:01Z",
    "2026-10-02T01:02Z",
    "2026-10-02T01:03Z",
    "2026-10-02T01:04Z",
    "2026-10-02T01:06Z",
  ]);
});

test("active minute records coalesce idempotently and cap at sixty seconds", async () => {
  const client = createReadingStatsClient({
    store: createMemoryReadingStatsStore(),
    cryptoApi: deterministicCrypto(),
    fetchImpl: null,
    now: () => Date.parse("2026-10-02T01:02:03.000Z"),
  });
  const context = { titleKey: "sha256:title", chapterKey: "sha256:chapter", offline: true };
  await client.recordActiveSeconds(45, context);
  await client.recordActiveSeconds(30, context);

  const outbox = await client.getOutbox();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].type, "active_minute");
  assert.equal(outbox[0].activeMs, 60_000);
  assert.equal(outbox[0].seconds, 60);
  assert.equal(outbox[0].offline, true);
});

test("a synced active-minute bucket gets a fresh id for a later slice in the same minute", async () => {
  let acknowledgedId = "";
  const client = createReadingStatsClient({
    store: createMemoryReadingStatsStore(),
    cryptoApi: deterministicCrypto(),
    fetchImpl: async (_url, options) => {
      const [event] = JSON.parse(options.body).events;
      acknowledgedId = event.id;
      return response(200, { acknowledgedEventIds: [event.id] });
    },
    now: () => Date.parse("2026-10-02T01:02:03.000Z"),
  });
  const context = { titleKey: "sha256:title", chapterKey: "sha256:chapter" };
  await client.recordActiveSeconds(15, context);
  await client.flush();
  const firstId = acknowledgedId;
  await client.recordActiveSeconds(15, context);
  const [later] = await client.getOutbox();

  assert.notEqual(later.id, firstId);
  assert.equal(later.seconds, 15);
});

test("page, chapter, reread attempt, and title events contain opaque identifiers only", async () => {
  const client = createReadingStatsClient({
    store: createMemoryReadingStatsStore(),
    cryptoApi: deterministicCrypto(),
    fetchImpl: null,
    now: () => Date.parse("2026-10-02T03:00:00.000Z"),
  });
  const context = {
    serverUrl: "https://suwayomi.private.example",
    mangaId: "my-secret-title",
    chapterId: "chapter-secret",
    offline: true,
  };
  await client.recordPageView({ ...context, pageIndex: 4 });
  await client.recordChapterFinish({ ...context, attemptId: "attempt-one" });
  await client.recordChapterFinish({ ...context, attemptId: "attempt-two" });
  await client.recordTitleComplete(context);

  const outbox = await client.getOutbox();
  assert.deepEqual(outbox.map((event) => event.type).sort(), ["chapter_finish", "chapter_finish", "page_view", "title_complete"]);
  assert.equal(new Set(outbox.filter((event) => event.type === "chapter_finish").map((event) => event.id)).size, 2);
  const serialized = JSON.stringify(outbox);
  assert.doesNotMatch(serialized, /suwayomi\.private|my-secret-title|chapter-secret/);
  assert.match(outbox[0].titleKey, /^sha256:/);
});

test("flush keeps events offline and on 404, then deletes only acknowledged IDs", async () => {
  const calls = [];
  let mode = "offline";
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (mode === "offline") throw new TypeError("network unavailable");
    if (mode === "unsupported") return response(404);
    const events = JSON.parse(options.body).events;
    return response(200, { acknowledgedEventIds: [events[0].id] });
  };
  const client = createReadingStatsClient({ store: createMemoryReadingStatsStore(), cryptoApi: deterministicCrypto(), fetchImpl });
  await client.recordPageView({ titleKey: "sha256:title", chapterKey: "sha256:chapter", pageIndex: 1 });
  await client.recordChapterFinish({ titleKey: "sha256:title", chapterKey: "sha256:chapter", attemptId: "one" });

  assert.equal((await client.flush()).status, "offline");
  assert.equal((await client.getOutbox()).length, 2);
  mode = "unsupported";
  assert.equal((await client.flush()).status, "unsupported");
  assert.equal((await client.getOutbox()).length, 2);
  mode = "online";
  const result = await client.flush();
  assert.deepEqual({ status: result.status, sent: result.sent, pending: result.pending }, { status: "sent", sent: 1, pending: 1 });
  assert.equal(calls.at(-1).options.credentials, "same-origin");
  assert.equal(JSON.parse(calls.at(-1).options.body).schemaVersion, READING_STATS_SCHEMA_VERSION);
});

test("summary cache and complete settings survive an older-server 404", async () => {
  let online = true;
  const fetchImpl = async (url) => {
    if (!online) return response(404);
    if (String(url).includes("?range=")) return response(200, { activeSeconds: 123 });
    return response(200, {});
  };
  const client = createReadingStatsClient({ store: createMemoryReadingStatsStore(), cryptoApi: deterministicCrypto(), fetchImpl });
  const fresh = await client.getSummary("365d");
  assert.equal(fresh.summary.activeSeconds, 123);
  const settings = await client.getSettings();
  assert.deepEqual(Object.keys(settings).sort(), ["celebrations", "dayStartHour", "enabled", "showRhythm", "showStats", "timezone"]);
  online = false;
  const cached = await client.getSummary("365d");
  assert.equal(cached.status, "cached");
  assert.equal(cached.summary.activeSeconds, 123);
});

test("export includes local pending data and confirmed reset erases it while preserving device identity", async () => {
  const store = createMemoryReadingStatsStore();
  const client = createReadingStatsClient({ store, cryptoApi: deterministicCrypto(), fetchImpl: async () => response(404) });
  const deviceId = await client.getDeviceId();
  await client.recordPageView({ titleKey: "sha256:title", chapterKey: "sha256:chapter", pageIndex: 0 });
  const exported = await client.exportData();
  assert.equal(exported.remote, null);
  assert.equal(exported.serverSupported, false);
  assert.equal(exported.local.pendingEvents.length, 1);
  await assert.rejects(client.reset(), /confirm/);
  const reset = await client.reset({ confirm: "ERASE" });
  assert.equal(reset.remoteStatus, "unsupported");
  assert.deepEqual(await client.getOutbox(), []);
  assert.equal(await client.getDeviceId(), deviceId);
});
