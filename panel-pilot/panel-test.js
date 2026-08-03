const expectationStoreKey = "panel-pilot-panel-expectations-v1";
const defaultPreferredGroup = "Kirei Cake";
const expectedFixtures = {
  "https://comick.live/comic/00-sousou-no-frieren/gx1Lk-chapter-1-en": [
    6, 1, 3, 4, 4, 4, 4, 8, 2, 6, 5, 5, 6, 5, 3, 6, 5, 5,
    4, 6, 6, 4, 3, 1, 5, 5, 4, 5, 3, 7, 6, 5, 4, 6, 3,
  ],
};

const testEl = {
  version: document.querySelector("#test-version"),
  comicUrl: document.querySelector("#test-comic-url"),
  chapter: document.querySelector("#test-chapter"),
  pageLimit: document.querySelector("#test-page-limit"),
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
};

const testState = {
  title: "",
  chapterUrl: "",
  pages: [],
  rows: [],
  expectations: loadExpectations(),
};

testEl.version.textContent = window.PanelPilot?.detectorVersion || "Detector";
testEl.load.addEventListener("click", loadTestChapter);
testEl.run.addEventListener("click", runDetection);
testEl.export.addEventListener("click", exportReport);
testEl.clear.addEventListener("click", clearExpectations);
applyUrlOptions();

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
  if (params.get("url")) testEl.comicUrl.value = params.get("url");
  if (params.get("chapter")) testEl.chapter.value = params.get("chapter");
  if (params.get("pages")) testEl.pageLimit.value = params.get("pages");
  if (params.get("direction")) testEl.direction.value = params.get("direction");
  if (params.get("autoload") === "1" || params.get("autorun") === "1") {
    window.setTimeout(async () => {
      await loadTestChapter();
      if (params.get("autorun") === "1" && testState.pages.length) {
        await runDetection();
      }
    }, 100);
  }
}

async function loadTestChapter() {
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

function chooseChapter(chapters) {
  if (!chapters.length) return null;
  return (
    chapters.find((chapter) => chapter.group?.includes(defaultPreferredGroup)) ||
    chapters.find((chapter) => chapter.title) ||
    chapters[0]
  );
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
  metrics.append(detected.node, expectedWrap, delta.node);

  const detail = document.createElement("p");
  detail.className = "note";
  detail.textContent = "Waiting for detection.";

  body.append(heading, metrics, detail);
  node.append(canvas, body);

  const row = { node, canvas, status, detected, expected, delta, detail, page };
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
      const panels = await window.PanelPilot.detectPanels(image, testEl.direction.value);
      page.image = image;
      page.panels = panels;
      page.detected = panels.length;
      page.error = "";
      row.node.dataset.panels = JSON.stringify(panels.map(serializePanel));
      row.detected.value.textContent = String(panels.length);
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

  if (expected === null) {
    row.node.className = "test-card unscored";
    row.status.textContent = "Unscored";
    row.delta.value.textContent = "-";
    row.detail.textContent = "Enter the expected panel count for this page.";
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
}

function resetSummary() {
  testEl.summaryPages.textContent = "0";
  testEl.summaryLabeled.textContent = "0";
  testEl.summaryMatches.textContent = "0";
  testEl.summaryAccuracy.textContent = "-";
}

function expectationKey(page) {
  return `${testState.chapterUrl}|${page.index}|${page.sourceUrl}`;
}

function getExpectedCount(page) {
  const value = testState.expectations[expectationKey(page)] ?? fixtureExpectedCount(page);
  return normalizedExpected(value);
}

function fixtureExpectedCount(page) {
  return expectedFixtures[testState.chapterUrl]?.[page.index] ?? null;
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

function clearExpectations() {
  testState.pages.forEach((page) => delete testState.expectations[expectationKey(page)]);
  localStorage.setItem(expectationStoreKey, JSON.stringify(testState.expectations));
  testState.rows.forEach((row) => {
    row.expected.value = "";
    scoreRow(row);
  });
  updateSummary();
  setTestNote("Expected counts cleared for the loaded test set.", "good");
}

function exportReport() {
  const report = {
    title: testState.title,
    chapterUrl: testState.chapterUrl,
    detectorVersion: window.PanelPilot?.detectorVersion || "",
    direction: testEl.direction.value,
    generatedAt: new Date().toISOString(),
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
      error: page.error,
    })),
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "panel-pilot-detection-report.json";
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
