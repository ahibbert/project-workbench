import assert from "node:assert/strict";
import test from "node:test";

import {
  planServerBufferRetention,
  serverBufferRetentionPolicy,
} from "../src/server-buffer-retention.js";

const now = Date.parse("2026-10-02T00:00:00.000Z");
const daysAgo = (days) => new Date(now - days * 24 * 60 * 60 * 1_000).toISOString();

function ledger(chapterId, scopeId, purpose = "reading-ahead", extra = {}) {
  return {
    schemaVersion: 1,
    managedBy: "panels",
    chapterId,
    scopeId,
    purpose,
    managedAt: daysAgo(60),
    ...extra,
  };
}

test("expired read chapters are eligible while the newest managed chapter per series is kept", () => {
  const result = planServerBufferRetention({
    now,
    policy: { readRetentionDays: 14, keepRecentCount: 1 },
    ledger: [ledger(1, "series-a"), ledger(2, "series-a"), ledger(3, "series-b", "plan-to-read")],
    downloads: [
      { chapterId: 1, readAt: daysAgo(40) },
      { chapterId: 2, readAt: daysAgo(30) },
      { chapterId: 3, readAt: daysAgo(20) },
    ],
  });

  assert.deepEqual(result.eligible.map((item) => item.chapterId), ["1"]);
  assert.deepEqual(
    result.protected.map((item) => [item.chapterId, item.reason]),
    [["2", "keep-recent"], ["3", "keep-recent"]],
  );
  assert.equal(result.preview.eligible, 1);
  assert.equal(result.preview.reasons["read-retention-expired"], 1);
});

test("active, manual, legacy, unmanaged, unread, and recently read downloads are protected", () => {
  const result = planServerBufferRetention({
    now,
    policy: { readRetentionDays: 30, keepRecentCount: 0 },
    activeReaderChapterIds: ["active"],
    ledger: [
      ledger("active", "series"),
      ledger("manual", "series"),
      { ...ledger("old-ledger", "series"), schemaVersion: 0 },
      ledger("unread", "series"),
      ledger("recent", "series"),
    ],
    downloads: [
      { chapterId: "active", readAt: daysAgo(90) },
      { chapterId: "manual", manual: true, readAt: daysAgo(90) },
      { chapterId: "old-download", legacy: true, readAt: daysAgo(90) },
      { chapterId: "old-ledger", readAt: daysAgo(90) },
      { chapterId: "unmanaged", readAt: daysAgo(90) },
      { chapterId: "unread" },
      { chapterId: "recent", readAt: daysAgo(2) },
    ],
  });

  assert.equal(result.eligible.length, 0);
  assert.deepEqual(Object.fromEntries(result.protected.map((item) => [item.chapterId, item.reason])), {
    active: "active-reader",
    manual: "manual-download",
    "old-download": "legacy-download",
    "old-ledger": "legacy-ledger",
    recent: "read-retention",
    unmanaged: "unmanaged-download",
    unread: "unread",
  });
});

test("expired source-test content is removable without being mistaken for unread library content", () => {
  const result = planServerBufferRetention({
    now,
    policy: { keepRecentCount: 10, sourceTestRetentionDays: 2 },
    ledger: [
      ledger("test-old", "source-suite", "source-test", { managedAt: daysAgo(3) }),
      ledger("test-new", "source-suite", "source-test", { managedAt: daysAgo(1) }),
    ],
    downloads: [{ chapterId: "test-old" }, { chapterId: "test-new" }],
  });

  assert.deepEqual(result.eligible.map((item) => [item.chapterId, item.reason]), [
    ["test-old", "source-test-expired"],
  ]);
  assert.deepEqual(result.protected.map((item) => [item.chapterId, item.reason]), [
    ["test-new", "source-test-retention"],
  ]);
});

test("the action plan dequeues every candidate before issuing any deletion", () => {
  const result = planServerBufferRetention({
    now,
    policy: { readRetentionDays: 0, keepRecentCount: 0, sourceTestRetentionDays: 0 },
    ledger: [ledger("chapter-b", "series"), ledger("chapter-a", "series")],
    downloads: [
      { chapterId: "chapter-b", readAt: daysAgo(1), state: "ready" },
      { chapterId: "chapter-a", readAt: daysAgo(1), state: "queued" },
    ],
  });

  assert.deepEqual(result.actions.map((action) => [action.type, action.chapterId]), [
    ["dequeue", "chapter-a"],
    ["dequeue", "chapter-b"],
    ["delete", "chapter-a"],
    ["delete", "chapter-b"],
  ]);
  assert.equal(result.actions[2].afterActionId, result.actions[0].actionId);
  assert.equal(result.actions[3].afterActionId, result.actions[1].actionId);
});

test("ambiguous records and unsafe identifiers fail closed and private metadata is not returned", () => {
  const input = {
    now,
    policy: { readRetentionDays: 0, keepRecentCount: 0 },
    ledger: [ledger("duplicate", "series"), ledger("duplicate", "series")],
    downloads: [
      { chapterId: "duplicate", readAt: daysAgo(3), title: "Private title", sourceUrl: "https://private.invalid" },
      { chapterId: "https://unsafe.invalid/chapter", readAt: daysAgo(3), title: "Also private" },
    ],
  };
  const snapshot = structuredClone(input);
  const result = planServerBufferRetention(input);

  assert.deepEqual(input, snapshot, "planning must not mutate caller state");
  assert.deepEqual(result.protected.map((item) => [item.chapterId, item.reason]), [
    ["duplicate", "ambiguous-ledger"],
  ]);
  assert.equal(result.preview.omittedUnsafeIdentifiers, 1);
  assert.doesNotMatch(JSON.stringify(result), /Private title|Also private|private\.invalid|unsafe\.invalid/);
});

test("duplicate server records cannot produce destructive actions", () => {
  const result = planServerBufferRetention({
    now,
    policy: { readRetentionDays: 0, keepRecentCount: 0 },
    ledger: [ledger("same", "series")],
    downloads: [
      { chapterId: "same", readAt: daysAgo(3) },
      { chapterId: "same", readAt: daysAgo(3) },
    ],
  });

  assert.equal(result.eligible.length, 0);
  assert.deepEqual(result.protected, [{ chapterId: "same", decision: "protect", reason: "ambiguous-download" }]);
  assert.deepEqual(result.actions, []);
});

test("configuration is validated and the public contract advertises managed purposes", () => {
  assert.throws(
    () => planServerBufferRetention({ policy: { keepRecentCount: -1 } }),
    /keepRecentCount/,
  );
  assert.equal(serverBufferRetentionPolicy.ledgerSchemaVersion, 1);
  assert.deepEqual(serverBufferRetentionPolicy.managedPurposes, [
    "reading-ahead",
    "plan-to-read",
    "source-test",
  ]);
});
