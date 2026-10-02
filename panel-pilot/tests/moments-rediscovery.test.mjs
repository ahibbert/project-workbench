import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseMomentForRediscovery,
  momentRediscoveryModel,
  normalizeMomentRediscoveryState,
  recordMomentRediscovery,
} from "../src/moments-rediscovery.js";


const NOW = Date.parse("2026-10-02T00:00:00.000Z");

test("empty and invalid collections gracefully produce no rediscovery", () => {
  assert.equal(chooseMomentForRediscovery([], { now: NOW, rng: () => 0 }), null);
  assert.equal(chooseMomentForRediscovery([{ title: "Missing ID" }], { now: NOW, rng: () => 0 }), null);
});

test("a single moment is selected and recorded without mutating it", () => {
  const moment = { id: "moment-001", title: "Saga", imageUrl: "/private-image.jpg" };
  const snapshot = structuredClone(moment);
  const result = chooseMomentForRediscovery([moment], { now: NOW, rng: () => 0.75 });

  assert.equal(result.moment, moment);
  assert.equal(result.reason, "never-shown");
  assert.deepEqual(moment, snapshot);
  assert.deepEqual(result.nextState, {
    schemaVersion: 1,
    moments: { "moment-001": { lastShownAt: NOW, showCount: 1 } },
  });
});

test("recently unseen weighting strongly favors the long-unseen moment", () => {
  const moments = [{ id: "recent" }, { id: "long-unseen" }];
  const state = normalizeMomentRediscoveryState({ moments: {
    recent: { lastShownAt: NOW - 60_000, showCount: 1 },
    "long-unseen": { lastShownAt: NOW - 120 * 24 * 60 * 60 * 1_000, showCount: 1 },
  } });

  const result = chooseMomentForRediscovery(moments, { state, now: NOW, rng: () => 0.5 });

  assert.equal(result.moment.id, "long-unseen");
  assert.equal(result.reason, "long-unseen-weighted");
  assert.equal(result.nextState.moments["long-unseen"].showCount, 2);
});

test("an injected RNG makes weighted selection deterministic", () => {
  const moments = [{ id: "one" }, { id: "two" }, { id: "three" }];
  const state = { moments: { one: { lastShownAt: NOW - 10_000, showCount: 8 } } };
  const first = chooseMomentForRediscovery(moments, { state, now: NOW, rng: () => 0.42 });
  const second = chooseMomentForRediscovery(moments, { state, now: NOW, rng: () => 0.42 });

  assert.equal(first.moment.id, second.moment.id);
  assert.deepEqual(first.nextState, second.nextState);
});

test("persisted history retains privacy-local counters only", () => {
  const normalized = normalizeMomentRediscoveryState({
    schemaVersion: 99,
    moments: {
      safe: {
        lastShownAt: NOW,
        showCount: 3,
        title: "Private title",
        sourceLabel: "Private source",
        imageUrl: "https://example.invalid/private.jpg",
        note: "Private note",
      },
      "../invalid": { lastShownAt: NOW, showCount: 4 },
    },
  });

  assert.deepEqual(normalized, {
    schemaVersion: 1,
    moments: { safe: { lastShownAt: NOW, showCount: 3 } },
  });
  assert.doesNotMatch(JSON.stringify(normalized), /Private|imageUrl|sourceLabel|note/);
});

test("recording invalid IDs is a safe no-op", () => {
  const state = { moments: { safe: { lastShownAt: NOW - 1, showCount: 2 } } };
  assert.deepEqual(recordMomentRediscovery(state, "../escape", { now: NOW }), normalizeMomentRediscoveryState(state));
  assert.equal(momentRediscoveryModel.schemaVersion, 1);
});
