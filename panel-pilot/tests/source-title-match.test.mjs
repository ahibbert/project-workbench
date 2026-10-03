import test from "node:test";
import assert from "node:assert/strict";

import { sourceTitleMatch } from "../src/source-title-match.js";

test("source title matching prioritizes exact titles and permits guarded edition variants", () => {
  assert.equal(sourceTitleMatch("Golden Kamuy", "Golden Kamuy"), "exact");
  assert.equal(sourceTitleMatch("Golden Kamuy", "Golden Kamuy (Official)"), "variant");
  assert.equal(sourceTitleMatch("Saga", "Saga [Digital]"), "variant");
  assert.equal(sourceTitleMatch("Y: The Last Man", "Y The Last Man 2002"), "variant");
});

test("source title matching rejects similar but different works", () => {
  assert.equal(sourceTitleMatch("Golden Kamuy", "Golden Kamuy Spin Off"), null);
  assert.equal(sourceTitleMatch("Saga", "Saga of Tanya the Evil"), null);
  assert.equal(sourceTitleMatch("Batman", "Batman Beyond"), null);
  assert.equal(sourceTitleMatch("Invincible", "Invincible Iron Man"), null);
});
