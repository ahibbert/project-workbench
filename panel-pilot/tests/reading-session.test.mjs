import assert from "node:assert/strict";
import test from "node:test";

import {
  READING_SESSION_CHECK_IN_ACTIVE_MS,
  READING_SESSION_EXPIRY_MS,
  createReadingSession,
  restoreReadingSession,
  serializeReadingSession,
} from "../src/reading-session.js";

const start = Date.parse("2026-10-02T01:00:00.000Z");

test("a new session is local, empty, and ready for stats-independent reader events", () => {
  const session = createReadingSession({ id: "session-fixture", now: start });

  assert.deepEqual(session.snapshot(), {
    schemaVersion: 1,
    id: "session-fixture",
    startedAt: "2026-10-02T01:00:00.000Z",
    lastActiveAt: "2026-10-02T01:00:00.000Z",
    activeMs: 0,
    pagesViewed: 0,
    chaptersFinished: 0,
    titlesTouched: 0,
    checkIn: { chapterThreshold: 3, activeMsThreshold: 2_700_000 },
    checkInStatus: {
      due: false,
      pending: false,
      reasons: [],
      chaptersSinceCheckIn: 0,
      activeMsSinceCheckIn: 0,
    },
    pendingCheckIn: null,
    finishedAt: null,
    finishReason: null,
  });
});

test("unique source pages and chapter attempts deduplicate without collapsing genuine rereads", () => {
  const session = createReadingSession({ id: "dedupe", now: start });

  assert.equal(session.recordPage({ pageKey: "title-a:chapter-1:page-1", titleKey: "title-a", at: start + 1_000 }), true);
  assert.equal(session.recordPage({ pageKey: "title-a:chapter-1:page-1", titleKey: "title-a", at: start + 2_000 }), false);
  assert.equal(session.recordPage({ pageKey: "title-a:chapter-1:page-2", titleKey: "title-a", at: start + 3_000 }), true);
  assert.equal(session.recordChapterFinish({ attemptId: "attempt-one", titleKey: "title-a", at: start + 4_000 }), true);
  assert.equal(session.recordChapterFinish({ attemptId: "attempt-one", titleKey: "title-a", at: start + 5_000 }), false);
  assert.equal(session.recordChapterFinish({ attemptId: "attempt-two", titleKey: "title-a", at: start + 6_000 }), true);

  assert.equal(session.snapshot().pagesViewed, 2);
  assert.equal(session.snapshot().chaptersFinished, 2);
  assert.equal(session.snapshot().titlesTouched, 1);
  assert.equal(session.snapshot().lastActiveAt, "2026-10-02T01:00:06.000Z");
});

test("active-time buckets accumulate exactly and never require global reading stats", () => {
  const session = createReadingSession({ id: "active", now: start });

  assert.equal(session.addActiveTime(30_000, { titleKey: "title-a", at: start + 30_000 }), 30_000);
  assert.equal(session.addActiveTime(60_000, { titleKey: "title-a", at: start + 90_000 }), 60_000);
  assert.equal(session.addActiveTime(0, { at: start + 100_000 }), 0);
  assert.equal(session.snapshot().activeMs, 90_000);
  assert.equal(session.snapshot().titlesTouched, 1);
  assert.throws(() => session.addActiveTime(-1), /non-negative integer/);
});

test("chapter and active-time thresholds can claim and acknowledge gentle check-ins", () => {
  const session = createReadingSession({
    id: "check-in",
    now: start,
    checkIn: { chapterThreshold: 2, activeMsThreshold: 100_000 },
  });

  session.recordChapterFinish({ attemptId: "attempt-1", at: start + 1_000 });
  assert.equal(session.checkInStatus().due, false);
  session.recordChapterFinish({ attemptId: "attempt-2", at: start + 2_000 });
  assert.deepEqual(session.checkInStatus().reasons, ["chapters"]);

  const claimed = session.claimCheckIn({ at: start + 3_000 });
  assert.equal(claimed.pending, true);
  assert.deepEqual(session.claimCheckIn({ at: start + 4_000 }).reasons, ["chapters"]);
  assert.equal(session.acknowledgeCheckIn({ at: start + 5_000 }), true);
  assert.equal(session.checkInStatus().due, false);

  session.addActiveTime(100_000, { at: start + 105_000 });
  assert.deepEqual(session.checkInStatus().reasons, ["active-time"]);
  assert.equal(session.acknowledgeCheckIn({ at: start + 106_000 }), false);
  assert.equal(session.checkInStatus().due, true);
  session.claimCheckIn({ at: start + 107_000 });
  assert.equal(session.acknowledgeCheckIn({ at: start + 108_000 }), true);
  assert.equal(session.checkInStatus().due, false);
});

test("check-ins can be disabled without disabling the session recap", () => {
  const session = createReadingSession({ id: "no-check-ins", now: start, checkIn: false });
  session.addActiveTime(READING_SESSION_CHECK_IN_ACTIVE_MS, { at: start + READING_SESSION_CHECK_IN_ACTIVE_MS });
  for (let index = 0; index < 4; index += 1) {
    session.recordChapterFinish({ attemptId: `attempt-${index}`, at: start + READING_SESSION_CHECK_IN_ACTIVE_MS + index });
  }

  assert.equal(session.checkInStatus().due, false);
  assert.deepEqual(session.snapshot().checkIn, { chapterThreshold: null, activeMsThreshold: null });
  assert.equal(session.recap().chaptersFinished, 4);
});

test("serialization restores sets and a claimed check-in without duplicate counting", () => {
  const original = createReadingSession({
    id: "serialized",
    now: start,
    checkIn: { chapterThreshold: 1, activeMsThreshold: null },
  });
  original.addActiveTime(12_345, { titleKey: "title-a", at: start + 12_345 });
  original.recordPage({ pageKey: "page-one", titleKey: "title-a", at: start + 13_000 });
  original.recordChapterFinish({ attemptId: "attempt-one", titleKey: "title-a", at: start + 14_000 });
  original.claimCheckIn({ at: start + 15_000 });

  const restored = restoreReadingSession(serializeReadingSession(original), { now: start + 20_000 });
  assert.equal(restored.status, "active");
  assert.equal(restored.session.snapshot().activeMs, 12_345);
  assert.equal(restored.session.snapshot().pendingCheckIn?.claimedAt, "2026-10-02T01:00:15.000Z");
  assert.equal(restored.session.recordPage({ pageKey: "page-one", at: start + 21_000 }), false);
  assert.equal(restored.session.recordChapterFinish({ attemptId: "attempt-one", at: start + 22_000 }), false);
  assert.equal(restored.session.snapshot().pagesViewed, 1);
  assert.equal(restored.session.snapshot().chaptersFinished, 1);
});

test("restore expires at the inactivity boundary and rejects corrupt or future schemas", () => {
  const session = createReadingSession({ id: "expiry", now: start });
  session.recordPage({ pageKey: "page-one", at: start + 10_000 });
  const serialized = session.serialize();

  assert.equal(restoreReadingSession(serialized, {
    now: start + 10_000 + READING_SESSION_EXPIRY_MS - 1,
  }).status, "active");
  const expired = restoreReadingSession(serialized, {
    now: start + 10_000 + READING_SESSION_EXPIRY_MS,
  });
  assert.equal(expired.status, "expired");
  assert.equal(expired.session, null);
  assert.equal(expired.recap.reason, "expired");
  assert.equal(expired.recap.pagesViewed, 1);

  assert.equal(restoreReadingSession("not-json").status, "invalid");
  assert.equal(restoreReadingSession(JSON.stringify({ schemaVersion: 99 })).status, "invalid");
});

test("explicit finish returns an idempotent recap and freezes further counters", () => {
  const session = createReadingSession({ id: "finished", now: start });
  session.addActiveTime(90_000, { titleKey: "title-a", at: start + 90_000 });
  session.recordPage({ pageKey: "page-one", at: start + 91_000 });
  session.recordChapterFinish({ attemptId: "attempt-one", at: start + 92_000 });

  const recap = session.finish({ at: start + 120_000, reason: "reader-exit" });
  assert.deepEqual(recap, {
    schemaVersion: 1,
    sessionId: "finished",
    startedAt: "2026-10-02T01:00:00.000Z",
    endedAt: "2026-10-02T01:02:00.000Z",
    reason: "reader-exit",
    activeMs: 90_000,
    pagesViewed: 1,
    chaptersFinished: 1,
    titlesTouched: 1,
    elapsedMs: 120_000,
  });
  assert.deepEqual(session.finish({ at: start + 180_000, reason: "different" }), recap);
  assert.equal(session.addActiveTime(10_000, { at: start + 130_000 }), 0);
  assert.equal(session.recordPage({ pageKey: "page-two", at: start + 130_000 }), false);
  assert.equal(session.recordChapterFinish({ attemptId: "attempt-two", at: start + 130_000 }), false);

  const restored = restoreReadingSession(session.serialize(), { now: start + 500_000 });
  assert.equal(restored.status, "finished");
  assert.deepEqual(restored.recap, recap);
});

test("the session model performs no fetches or storage writes by itself", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => { fetchCalls += 1; throw new Error("unexpected network call"); };
  try {
    const session = createReadingSession({ id: "local-only", now: start });
    session.addActiveTime(1_000, { at: start + 1_000 });
    session.recordPage({ pageKey: "page-one", at: start + 2_000 });
    session.recordChapterFinish({ attemptId: "attempt-one", at: start + 3_000 });
    const serialized = session.serialize();
    restoreReadingSession(serialized, { now: start + 4_000 });
    session.finish({ at: start + 5_000 });
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
