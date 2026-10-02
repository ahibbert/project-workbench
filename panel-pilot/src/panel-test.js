import {
  aggregateDetectionQuality,
  detectionQualityEntry,
  summarizeDetectionSuite,
} from "./detection-quality.js";
import { classifyPageSpread } from "./page-spread.js";

const expectationStoreKey = "panel-pilot-panel-expectations-v1";
const feedbackStoreKey = "panel-pilot-panel-quality-feedback-v1";

const testEl = {
  version: document.querySelector("#test-version"),
  sourceType: document.querySelector("#test-source-type"),
  suwayomiFields: document.querySelector("#test-suwayomi-fields"),
  comickFields: document.querySelector("#test-comick-fields"),
  mangaId: document.querySelector("#test-manga-id"),
  chapterId: document.querySelector("#test-chapter-id"),
  comicUrl: document.querySelector("#test-comic-url"),
  chapter: document.querySelector("#test-chapter"),
  pageLimit: document.querySelector("#test-page-limit"),
  format: document.querySelector("#test-format"),
  direction: document.querySelector("#test-direction"),
  load: document.querySelector("#test-load"),
  run: document.querySelector("#test-run"),
  export: document.querySelector("#test-export"),
  clear: document.querySelector("#test-clear"),
  note: document.querySelector("#test-note"),
  results: document.querySelector("#test-results"),
  summaryPages: document.querySelector("#summary-pages"),
  summaryLabeled: document.querySelector("#summary-labeled"),
  summaryMatches: document.querySelector("#summary-matches"),
  summaryAccuracy: document.querySelector("#summary-accuracy"),
  summaryRisky: document.querySelector("#summary-risky"),
  summaryConfidence: document.querySelector("#summary-confidence"),
  summaryFallbacks: document.querySelector("#summary-fallbacks"),
  summaryApproved: document.querySelector("#summary-approved"),
  suiteFile: document.querySelector("#test-suite-file"),
  suitePrevious: document.querySelector("#test-suite-previous"),
  suiteNext: document.querySelector("#test-suite-next"),
  suiteNote: document.querySelector("#test-suite-note"),
};

const testState = {
  title: "",
  chapterUrl: "",
  pages: [],
  rows: [],
  expectations: loadExpectations(),
  feedback: loadFeedback(),
  suite: [],
  suiteIndex: -1,
};

testEl.version.textContent = window.PanelPilot?.detectorVersion || "Detector";
testEl.load.addEventListener("click", loadTestChapter);
testEl.run.addEventListener("click", runDetection);
testEl.export.addEventListener("click", exportReport);
testEl.clear.addEventListener("click", clearExpectations);
testEl.sourceType.addEventListener("change", updateSourceFields);
testEl.suiteFile.addEventListener("change", loadSuiteManifest);
testEl.suitePrevious.addEventListener("click", () => moveSuiteCase(-1));
testEl.suiteNext.addEventListener("click", () => moveSuiteCase(1));
applyUrlOptions();
updateSourceFields();

function setTestNote(message, tone = "") {
  testEl.note.textContent = message;
  testEl.note.className = `note ${tone}`;
}

function setTestBusy(button, busy, label = "Working") {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = label;
  } else if (button.dataset.originalLabel) {
    button.textContent = button.dataset.originalLabel;
  }
  button.disabled = busy;
}

function applyUrlOptions() {
  const params = new URLSearchParams(location.search);
  if (params.get("source")) testEl.sourceType.value = params.get("source");
  if (params.get("mangaId")) testEl.mangaId.value = params.get("mangaId");
  if (params.get("chapterId")) testEl.chapterId.value = params.get("chapterId");
  if (params.get("url")) testEl.comicUrl.value = params.get("url");
  if (params.get("chapter")) testEl.chapter.value = params.get("chapter");
  if (params.get("pages")) testEl.pageLimit.value = params.get("pages");
  if (params.get("direction")) testEl.direction.value = params.get("direction");
  if (["manga", "comic", "webtoon"].includes(params.get("format"))) testEl.format.value = params.get("format");
  if (params.get("autoload") === "1" || params.get("autorun") === "1") {
    window.setTimeout(async () => {
      await loadTestChapter();
      if (params.get("autorun") === "1" && testState.pages.length) {
        await runDetection();
      }
    }, 100);
  }
}

function updateSourceFields() {
  const suwayomi = testEl.sourceType.value === "suwayomi";
  testEl.suwayomiFields.hidden = !suwayomi;
  testEl.comickFields.hidden = suwayomi;
}

async function loadSuiteManifest(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 256 * 1024) throw new Error("Suite manifest must be smaller than 256 KB.");
    const manifest = JSON.parse(await file.text());
    const summary = summarizeDetectionSuite(manifest);
    testState.suite = manifest.cases.slice();
    testState.suiteIndex = 0;
    applySuiteCase(testState.suite[0]);
    renderSuiteStatus(summary);
    setTestNote("Suite loaded. Review the first case, then load its chapter.", "good");
  } catch (error) {
    testState.suite = [];
    testState.suiteIndex = -1;
    renderSuiteStatus();
    setTestNote(`Could not load suite: ${error.message}`, "bad");
  } finally {
    event.target.value = "";
  }
}

function applySuiteCase(item) {
  if (!item) return;
  testEl.format.value = item.format;
  testEl.direction.value = item.direction === "rtl" ? "rtl" : "ltr";
  testEl.pageLimit.value = Number(item.maxPages) > 0 ? String(item.maxPages) : "";
  const isSuwayomi = Number(item.chapterId) > 0;
  testEl.sourceType.value = isSuwayomi ? "suwayomi" : "comick";
  if (isSuwayomi) {
    testEl.mangaId.value = Number(item.mangaId) > 0 ? String(item.mangaId) : "";
    testEl.chapterId.value = String(item.chapterId);
  } else {
    testEl.comicUrl.value = item.url || "";
    testEl.chapter.value = item.chapter || "1";
  }
  updateSourceFields();
  renderSuiteStatus();
}

function moveSuiteCase(delta) {
  const next = testState.suiteIndex + delta;
  if (next < 0 || next >= testState.suite.length) return;
  testState.suiteIndex = next;
  applySuiteCase(testState.suite[next]);
  setTestNote("Suite case selected. Load the chapter when ready.");
}

function renderSuiteStatus(summary = null) {
  const count = testState.suite.length;
  const index = testState.suiteIndex;
  testEl.suitePrevious.disabled = index <= 0;
  testEl.suiteNext.disabled = index < 0 || index >= count - 1;
  if (!count) {
    testEl.suiteNote.textContent = "No suite loaded.";
    return;
  }
  const item = testState.suite[index];
  const totals = summary?.formats
    ? ` · ${summary.formats.manga} manga · ${summary.formats.comic} comic · ${summary.formats.webtoon} webtoon`
    : "";
  testEl.suiteNote.textContent = `Case ${index + 1} of ${count}${item.label ? ` · ${item.label}` : ""}${totals}`;
}

async function loadTestChapter() {
  if (testEl.sourceType.value === "suwayomi") {
    await loadSuwayomiTestChapter();
    return;
  }

  const comicUrl = testEl.comicUrl.value.trim();
  const chapterNumber = testEl.chapter.value.trim() || "1";
  if (!comicUrl) {
    setTestNote("Enter a Comick comic URL first.", "bad");
    return;
  }

  setTestBusy(testEl.load, true, "Loading");
  testEl.run.disabled = true;
  testEl.export.disabled = true;
  testEl.clear.disabled = true;
  testEl.results.replaceChildren();
  resetSummary();

  try {
    const chapters = await localJson(
      `/api/comick/chapters?lang=en&chap=${encodeURIComponent(chapterNumber)}&url=${encodeURIComponent(comicUrl)}`
    );
    const chapter = chooseChapter(chapters.chapters || []);
    if (!chapter) throw new Error(`No chapter ${chapterNumber} entry found.`);

    const payload = await localJson(`/api/comick/chapter?url=${encodeURIComponent(chapter.url)}`);
    if (!payload.pages?.length) throw new Error("No page images found for that chapter.");

    const limit = Number.parseInt(testEl.pageLimit.value, 10);
    const pages = Number.isFinite(limit) && limit > 0 ? payload.pages.slice(0, limit) : payload.pages;
    testState.title = payload.title || chapter.label;
    testState.chapterUrl = chapter.url;
    testState.pages = pages.map((url, index) => ({
      url,
      sourceUrl: payload.sourcePages?.[index] || url,
      index,
      detected: null,
      error: "",
      panels: [],
      image: null,
      reliability: null,
      decision: null,
      spread: null,
    }));
    testState.rows = [];
    renderPendingRows();
    testEl.run.disabled = false;
    testEl.export.disabled = false;
    testEl.clear.disabled = false;
    setTestNote(`Loaded ${pages.length} pages from ${chapter.label}.`, "good");
  } catch (error) {
    setTestNote(`Could not load test chapter: ${error.message}`, "bad");
  } finally {
    setTestBusy(testEl.load, false);
  }
}

async function loadSuwayomiTestChapter() {
  const mangaId = Number(testEl.mangaId.value);
  const chapterId = Number(testEl.chapterId.value);
  if (!Number.isInteger(chapterId) || chapterId < 1) {
    setTestNote("Enter a valid Suwayomi chapter ID first.", "bad");
    return;
  }

  setTestBusy(testEl.load, true, "Loading");
  testEl.run.disabled = true;
  testEl.export.disabled = true;
  testEl.clear.disabled = true;
  testEl.results.replaceChildren();
  resetSummary();

  try {
    const query = `mutation TEST_CHAPTER_PAGES($input: FetchChapterPagesInput!) {
      fetchChapterPages(input: $input) {
        chapter { id name manga { id title source { name displayName } } }
        pages
      }
    }`;
    const data = await graphQL(query, { input: { chapterId } }, { timeoutMs: 90000 });
    const fetched = data.fetchChapterPages;
    const pages = await resolveChapterPages(fetched);
    if (!pages.length) throw new Error("Source returned no readable page URLs.");

    const limit = Number.parseInt(testEl.pageLimit.value, 10);
    const selectedPages = Number.isFinite(limit) && limit > 0 ? pages.slice(0, limit) : pages;
    const chapter = fetched.chapter || {};
    const manga = chapter.manga || {};
    testState.title = `${manga.title || `Manga ${mangaId || manga.id || ""}`} — ${chapter.name || `Chapter ${chapterId}`}`;
    testState.chapterUrl = `suwayomi:${mangaId || manga.id || "unknown"}:${chapterId}`;
    testState.pages = selectedPages.map((url, index) => ({
      url: normalizeSuwayomiPageUrl(url),
      sourceUrl: url,
      index,
      detected: null,
      error: "",
      panels: [],
      image: null,
      reliability: null,
      decision: null,
      spread: null,
    }));
    testState.rows = [];
    renderPendingRows();
    testEl.run.disabled = false;
    testEl.export.disabled = false;
    testEl.clear.disabled = false;
    setTestNote(`Loaded ${selectedPages.length} pages from ${testState.title}.`, "good");
  } catch (error) {
    setTestNote(`Could not load Suwayomi test chapter: ${error.message}`, "bad");
  } finally {
    setTestBusy(testEl.load, false);
  }
}

function chooseChapter(chapters) {
  if (!chapters.length) return null;
  return chapters.find((chapter) => chapter.title) || chapters[0];
}

function renderPendingRows() {
  testEl.results.replaceChildren();
  testState.pages.forEach((page) => {
    const row = makeResultRow(page);
    testState.rows[page.index] = row;
    testEl.results.append(row.node);
  });
  updateSummary();
}

function makeResultRow(page) {
  const node = document.createElement("article");
  node.className = "test-card pending";

  const canvas = document.createElement("canvas");
  canvas.width = 220;
  canvas.height = 320;
  canvas.className = "test-thumb";

  const body = document.createElement("div");
  body.className = "test-card-body";

  const heading = document.createElement("div");
  heading.className = "test-card-heading";
  const title = document.createElement("strong");
  title.textContent = `Page ${page.index + 1}`;
  const status = document.createElement("span");
  status.className = "small-count";
  status.textContent = "Pending";
  heading.append(title, status);

  const metrics = document.createElement("div");
  metrics.className = "test-metrics";
  const detected = metric("Detected", "-");
  const expectedWrap = document.createElement("label");
  expectedWrap.className = "test-expected";
  const expectedText = document.createElement("span");
  expectedText.textContent = "Expected";
  const expected = document.createElement("input");
  expected.type = "number";
  expected.min = "0";
  expected.step = "1";
  expected.inputMode = "numeric";
  expected.value = getExpectedCount(page) ?? "";
  expected.addEventListener("input", () => {
    saveExpectedCount(page, expected.value);
    scoreRow(row);
    updateSummary();
  });
  expectedWrap.append(expectedText, expected);
  const delta = metric("Delta", "-");
  const overlap = metric("Overlap", "-");
  const confidence = metric("Confidence", "-");
  const presentation = metric("Presentation", "-");
  metrics.append(detected.node, expectedWrap, delta.node, overlap.node, confidence.node, presentation.node);

  const feedback = document.createElement("div");
  feedback.className = "button-row test-feedback";
  const looksGood = document.createElement("button");
  looksGood.type = "button";
  looksGood.className = "segmented";
  looksGood.textContent = "Looks good";
  const needsWork = document.createElement("button");
  needsWork.type = "button";
  needsWork.className = "segmented";
  needsWork.textContent = "Needs work";
  const issue = document.createElement("select");
  issue.className = "test-issue";
  issue.setAttribute("aria-label", `Issue on page ${page.index + 1}`);
  [
    ["", "Choose issue"],
    ["missed-panel", "Missed panel"],
    ["extra-split", "Incorrect split"],
    ["bubble-crop", "Bubble cropped"],
    ["reading-order", "Reading order"],
    ["spread", "Spread handling"],
    ["bad-fallback", "Wrong fallback"],
    ["other", "Other"],
  ].forEach(([value, label]) => issue.add(new Option(label, value)));
  const savedFeedback = getSavedFeedback(page);
  issue.value = savedFeedback.issues?.[0] || "";
  looksGood.setAttribute("aria-pressed", savedFeedback.verdict === "good" ? "true" : "false");
  needsWork.setAttribute("aria-pressed", savedFeedback.verdict === "bad" ? "true" : "false");
  looksGood.addEventListener("click", () => setRowFeedback(row, "good"));
  needsWork.addEventListener("click", () => setRowFeedback(row, "bad"));
  issue.addEventListener("change", () => setRowFeedback(row, issue.value ? "bad" : row.page.verdict || "unrated", issue.value));
  feedback.append(looksGood, needsWork, issue);

  const detail = document.createElement("p");
  detail.className = "note";
  detail.textContent = "Waiting for detection.";

  body.append(heading, metrics, feedback, detail);
  node.append(canvas, body);

  const row = {
    node,
    canvas,
    status,
    detected,
    expected,
    delta,
    overlap,
    confidence,
    presentation,
    looksGood,
    needsWork,
    issue,
    detail,
    page,
  };
  page.verdict = savedFeedback.verdict || "unrated";
  page.issues = savedFeedback.issues || [];
  return row;
}

function metric(label, value) {
  const node = document.createElement("div");
  node.className = "test-metric";
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.textContent = value;
  node.append(labelNode, valueNode);
  return { node, value: valueNode };
}

async function runDetection() {
  if (!window.PanelPilot?.detectPanels) {
    setTestNote("Detector is not available on this page.", "bad");
    return;
  }
  if (!testState.pages.length) {
    setTestNote("Load a test chapter first.", "bad");
    return;
  }

  setTestBusy(testEl.run, true, "Running");
  setTestNote("Running panel detection page by page.", "");

  for (const page of testState.pages) {
    const row = testState.rows[page.index];
    row.node.className = "test-card running";
    row.status.textContent = "Running";
    row.detail.textContent = "Loading image and detecting panels.";
    try {
      const image = await loadImageWithTimeout(page.url);
      const panels = await window.PanelPilot.detectPanelsForMode(
        image,
        testEl.direction.value,
        testEl.format.value,
        page.url,
      );
      page.image = image;
      page.panels = panels;
      page.detected = panels.length;
      page.reliability = panelReliability(panels);
      page.decision = window.PanelPilot.choosePanelDetectionFallback({
        panels,
        pageWidth: image.naturalWidth,
        pageHeight: image.naturalHeight,
        direction: testEl.direction.value,
        viewportAspect: window.innerWidth / Math.max(1, window.innerHeight),
      });
      page.spread = classifyPageSpread({
        pageWidth: image.naturalWidth,
        pageHeight: image.naturalHeight,
        panels,
      });
      page.error = "";
      row.node.dataset.panels = JSON.stringify(panels.map(serializePanel));
      row.detected.value.textContent = String(panels.length);
      row.overlap.value.textContent = page.reliability.riskyPairs
        ? String(page.reliability.riskyPairs)
        : "0";
      row.confidence.value.textContent = `${Math.round((page.decision.confidence || 0) * 100)}%`;
      row.presentation.value.textContent = page.spread.isSpread
        ? "Spread"
        : page.decision.strategy === "panels" ? "Panels" : page.decision.fallback?.label || "Fallback";
      drawOverlay(row.canvas, image, panels);
      scoreRow(row);
    } catch (error) {
      page.detected = null;
      page.error = error.message;
      row.node.dataset.panels = "[]";
      row.node.className = "test-card failed";
      row.status.textContent = "Error";
      row.detail.textContent = error.message;
    }
    updateSummary();
    await yieldToBrowser();
  }

  setTestBusy(testEl.run, false);
  setTestNote("Detection run complete. Fill expected counts to score accuracy.", "good");
}

function scoreRow(row) {
  const expected = normalizedExpected(row.expected.value);
  const detected = row.page.detected;
  if (detected === null) return;

  if (row.page.verdict === "bad") {
    row.node.className = "test-card failed";
    row.status.textContent = "Needs work";
    row.detail.textContent = row.page.issues?.length
      ? `Marked for review: ${row.page.issues.join(", ").replaceAll("-", " ")}.`
      : "Marked for review.";
    row.delta.value.textContent = expected === null ? "-" : String(detected - expected);
    return;
  }

  if (row.page.verdict === "good") {
    row.node.className = "test-card passed";
    row.status.textContent = "Looks good";
    row.detail.textContent = row.page.spread?.isSpread
      ? "Verified spread presentation."
      : "Verified detection and framing.";
    row.delta.value.textContent = expected === null ? "-" : String(detected - expected);
    return;
  }

  if (expected === null) {
    const risky = row.page.reliability?.riskyPairs > 0;
    row.node.className = risky ? "test-card failed" : "test-card unscored";
    row.status.textContent = risky ? "Overlap risk" : "Unscored";
    row.delta.value.textContent = "-";
    row.detail.textContent = risky
      ? `${row.page.reliability.riskyPairs} panel pair(s) substantially repeat the same page area.`
      : "Enter the expected panel count for this page.";
    return;
  }

  const delta = detected - expected;
  row.delta.value.textContent = delta === 0 ? "0" : delta > 0 ? `+${delta}` : String(delta);
  if (delta === 0) {
    row.node.className = "test-card passed";
    row.status.textContent = "Match";
    row.detail.textContent = "Detected count matches expected count.";
  } else {
    row.node.className = "test-card failed";
    row.status.textContent = "Mismatch";
    row.detail.textContent = delta > 0 ? "Detector found too many panels." : "Detector found too few panels.";
  }
}

function drawOverlay(canvas, image, panels) {
  const maxWidth = 240;
  const maxHeight = 360;
  const scale = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  context.lineWidth = Math.max(2, Math.round(width * 0.01));
  context.font = "700 12px system-ui, sans-serif";
  panels.forEach((panel, index) => {
    const x = panel.x * width;
    const y = panel.y * height;
    const w = panel.w * width;
    const h = panel.h * height;
    context.strokeStyle = "#e1b84b";
    context.fillStyle = "rgba(225, 184, 75, 0.16)";
    context.fillRect(x, y, w, h);
    context.strokeRect(x, y, w, h);
    context.fillStyle = "#151515";
    context.fillRect(x, y, 26, 18);
    context.fillStyle = "#f4f1ea";
    context.fillText(String(index + 1), x + 7, y + 13);
  });
}

function loadImageWithTimeout(src, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const image = new Image();
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Image load timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);

    image.onload = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(new Error(`Could not load image: ${src}`));
    };
    image.src = src;
  });
}

function updateSummary() {
  const pages = testState.pages.length;
  const scored = testState.pages.filter((page) => getExpectedCount(page) !== null && page.detected !== null);
  const matches = scored.filter((page) => page.detected === getExpectedCount(page));
  testEl.summaryPages.textContent = String(pages);
  testEl.summaryLabeled.textContent = String(scored.length);
  testEl.summaryMatches.textContent = String(matches.length);
  testEl.summaryAccuracy.textContent = scored.length ? `${Math.round((matches.length / scored.length) * 100)}%` : "-";
  testEl.summaryRisky.textContent = String(
    testState.pages.reduce((sum, page) => sum + (page.reliability?.riskyPairs || 0), 0)
  );
  const quality = aggregateDetectionQuality(testState.pages
    .filter((page) => page.detected !== null)
    .map((page) => qualityEntryForPage(page)));
  testEl.summaryConfidence.textContent = quality.averageConfidence === null
    ? "-"
    : `${Math.round(quality.averageConfidence * 100)}%`;
  testEl.summaryFallbacks.textContent = String(quality.fallbacks);
  testEl.summaryApproved.textContent = String(testState.pages.filter((page) => page.verdict === "good").length);
}

function resetSummary() {
  testEl.summaryPages.textContent = "0";
  testEl.summaryLabeled.textContent = "0";
  testEl.summaryMatches.textContent = "0";
  testEl.summaryAccuracy.textContent = "-";
  testEl.summaryRisky.textContent = "0";
  testEl.summaryConfidence.textContent = "-";
  testEl.summaryFallbacks.textContent = "0";
  testEl.summaryApproved.textContent = "0";
}

function qualityEntryForPage(page) {
  return detectionQualityEntry({
    format: testEl.format.value,
    decision: page.decision,
    detectedCount: page.detected,
    expectedCount: getExpectedCount(page),
    verdict: page.verdict,
    issues: page.issues,
  });
}

function exportQualityEntryForPage(page) {
  return detectionQualityEntry({
    format: testEl.format.value,
    decision: page.decision,
    detectedCount: page.detected,
    expectedCount: getExpectedCount(page),
  });
}

function panelReliability(panels) {
  let riskyPairs = 0;
  let maxContainment = 0;
  let maxIou = 0;
  for (let index = 0; index < panels.length; index += 1) {
    for (let other = index + 1; other < panels.length; other += 1) {
      const relation = panelOverlap(panels[index], panels[other]);
      maxContainment = Math.max(maxContainment, relation.containment);
      maxIou = Math.max(maxIou, relation.iou);
      const alignedBand =
        (relation.xContainment >= 0.94 && relation.yContainment >= 0.28) ||
        (relation.yContainment >= 0.94 && relation.xContainment >= 0.28);
      if (relation.iou >= 0.68 || relation.containment >= 0.82 || alignedBand) riskyPairs += 1;
    }
  }
  return { riskyPairs, maxContainment, maxIou };
}

function panelOverlap(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const overlapX = Math.max(0, x1 - x0);
  const overlapY = Math.max(0, y1 - y0);
  const intersection = overlapX * overlapY;
  const areaA = Math.max(0.000001, a.w * a.h);
  const areaB = Math.max(0.000001, b.w * b.h);
  return {
    iou: intersection / Math.max(0.000001, areaA + areaB - intersection),
    containment: intersection / Math.min(areaA, areaB),
    xContainment: overlapX / Math.max(0.000001, Math.min(a.w, b.w)),
    yContainment: overlapY / Math.max(0.000001, Math.min(a.h, b.h)),
  };
}

function expectationKey(page) {
  return `${testState.chapterUrl}|${page.index}|${page.sourceUrl}`;
}

function getExpectedCount(page) {
  return normalizedExpected(testState.expectations[expectationKey(page)]);
}

function saveExpectedCount(page, value) {
  const key = expectationKey(page);
  const normalized = normalizedExpected(value);
  if (normalized === null) {
    delete testState.expectations[key];
  } else {
    testState.expectations[key] = normalized;
  }
  localStorage.setItem(expectationStoreKey, JSON.stringify(testState.expectations));
}

function normalizedExpected(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function loadExpectations() {
  try {
    return JSON.parse(localStorage.getItem(expectationStoreKey) || "{}");
  } catch {
    return {};
  }
}

function loadFeedback() {
  try {
    const parsed = JSON.parse(localStorage.getItem(feedbackStoreKey) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getSavedFeedback(page) {
  const saved = testState.feedback[expectationKey(page)];
  return saved && typeof saved === "object" ? saved : { verdict: "unrated", issues: [] };
}

function setRowFeedback(row, verdict, issue = row.issue.value) {
  row.page.verdict = verdict === "good" || verdict === "bad" ? verdict : "unrated";
  row.page.issues = issue ? [issue] : [];
  row.looksGood.setAttribute("aria-pressed", row.page.verdict === "good" ? "true" : "false");
  row.needsWork.setAttribute("aria-pressed", row.page.verdict === "bad" ? "true" : "false");
  if (row.page.verdict === "good") {
    row.page.issues = [];
    row.issue.value = "";
  }
  testState.feedback[expectationKey(row.page)] = { verdict: row.page.verdict, issues: row.page.issues };
  localStorage.setItem(feedbackStoreKey, JSON.stringify(testState.feedback));
  scoreRow(row);
  updateSummary();
}

function clearExpectations() {
  testState.pages.forEach((page) => {
    delete testState.expectations[expectationKey(page)];
    delete testState.feedback[expectationKey(page)];
    page.verdict = "unrated";
    page.issues = [];
  });
  localStorage.setItem(expectationStoreKey, JSON.stringify(testState.expectations));
  localStorage.setItem(feedbackStoreKey, JSON.stringify(testState.feedback));
  testState.rows.forEach((row) => {
    row.expected.value = "";
    row.issue.value = "";
    row.looksGood.setAttribute("aria-pressed", "false");
    row.needsWork.setAttribute("aria-pressed", "false");
    scoreRow(row);
  });
  updateSummary();
  setTestNote("Expected counts cleared for the loaded test set.", "good");
}

function exportReport() {
  const qualityEntries = testState.pages.map((page) => exportQualityEntryForPage(page));
  const report = {
    title: testState.title,
    chapterUrl: testState.chapterUrl,
    detectorVersion: window.PanelPilot?.detectorVersion || "",
    direction: testEl.direction.value,
    format: testEl.format.value,
    generatedAt: new Date().toISOString(),
    qualitySummary: aggregateDetectionQuality(qualityEntries),
    pages: testState.pages.map((page) => ({
      index: page.index + 1,
      sourceUrl: page.sourceUrl,
      detected: page.detected,
      expected: getExpectedCount(page),
      delta: getExpectedCount(page) === null || page.detected === null ? null : page.detected - getExpectedCount(page),
      panels: page.panels.map((panel) => ({
        x: round(panel.x),
        y: round(panel.y),
        w: round(panel.w),
        h: round(panel.h),
      })),
      reliability: page.reliability,
      presentation: page.decision,
      spread: page.spread,
      quality: exportQualityEntryForPage(page),
      error: page.error,
    })),
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "panels-detection-report.json";
  link.click();
  URL.revokeObjectURL(url);
}

function serializePanel(panel) {
  return {
    x: round(panel.x),
    y: round(panel.y),
    w: round(panel.w),
    h: round(panel.h),
    label: panel.label || "",
  };
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

function yieldToBrowser() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function localJson(path) {
  const response = await fetch(path);
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    throw new Error(`Local request failed with HTTP ${response.status}`);
  }
  if (payload.error) throw new Error(payload.error);
  return payload;
}
