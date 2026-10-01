import assert from "node:assert/strict";
import test from "node:test";

import { reconcileReadingProgress } from "../src/progress-reconciliation.js";

const serverUrl = "http://suwayomi.test:4567";

function chapter(id, order, overrides = {}) {
  return {
    id,
    name: `Chapter ${order}`,
    sourceOrder: order,
    chapterNumber: order,
    pageCount: 12,
    isRead: false,
    lastPageRead: 0,
    ...overrides,
  };
}

test("a later server page replaces local progress and removes its stale queued write", () => {
  const result = reconcileReadingProgress({
    chapters: [chapter(101, 1, { lastPageRead: 8 })],
    libraryItem: { chapterId: 101, pageIndex: 5, started: true },
    outbox: [{ serverUrl, chapterId: 101, lastPageRead: 5, completed: false }],
    serverUrl,
  });

  assert.equal(result.winner.chapterId, 101);
  assert.equal(result.winner.lastPageRead, 8);
  assert.equal(result.winner.origin, "server");
  assert.deepEqual(result.outbox, []);
  assert.equal(result.push, null);
});

test("local progress on a later chapter wins and is queued for Suwayomi", () => {
  const result = reconcileReadingProgress({
    chapters: [
      chapter(101, 1, { isRead: true, lastPageRead: 11 }),
      chapter(102, 2, { lastPageRead: 2 }),
      chapter(103, 3),
    ],
    libraryItem: { chapterId: 103, pageIndex: 4, started: true },
    outbox: [],
    serverUrl,
  });

  assert.equal(result.winner.chapterId, 103);
  assert.equal(result.winner.lastPageRead, 4);
  assert.deepEqual(result.push, { chapterId: 103, lastPageRead: 4, completed: false });
});

test("server completion advances resume to the next unread chapter and dominates stale state", () => {
  const result = reconcileReadingProgress({
    chapters: [
      chapter(101, 1, { isRead: true, lastPageRead: 11 }),
      chapter(102, 2),
    ],
    libraryItem: { chapterId: 101, pageIndex: 7, started: true },
    outbox: [{ serverUrl, chapterId: 101, lastPageRead: 7, completed: false }],
    serverUrl,
  });

  assert.equal(result.winner.chapterId, 102);
  assert.equal(result.winner.lastPageRead, 0);
  assert.equal(result.winner.origin, "server");
  assert.deepEqual(result.outbox, []);
});

test("a queued completion remains authoritative until Suwayomi acknowledges it", () => {
  const queued = { serverUrl, chapterId: 101, lastPageRead: 11, completed: true };
  const result = reconcileReadingProgress({
    chapters: [chapter(101, 1, { lastPageRead: 11 })],
    libraryItem: { chapterId: 101, pageIndex: 11, started: true },
    outbox: [queued],
    serverUrl,
  });

  assert.equal(result.winner.origin, "outbox");
  assert.equal(result.winner.completed, true);
  assert.deepEqual(result.outbox, [queued]);
  assert.equal(result.push, null);
});

test("queues for another Suwayomi instance are never pruned", () => {
  const foreign = { serverUrl: "http://other.test:4567", chapterId: 101, lastPageRead: 3, completed: false };
  const result = reconcileReadingProgress({
    chapters: [chapter(101, 1, { lastPageRead: 8 })],
    libraryItem: { chapterId: 101, pageIndex: 5, started: true },
    outbox: [foreign],
    serverUrl,
  });

  assert.deepEqual(result.outbox, [foreign]);
});
