import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";


test.use({ serviceWorkers: "block" });

const suiteManifest = {
  schemaVersion: 1,
  cases: [
    {
      label: "Local comic fixture",
      format: "comic",
      direction: "ltr",
      url: "https://comick.live/comic/panels-local-fixture",
      chapter: "1",
      maxPages: 1,
    },
    {
      label: "Local webtoon fixture",
      format: "webtoon",
      direction: "ltr",
      url: "https://comick.live/comic/panels-local-webtoon",
      chapter: "2",
      maxPages: 1,
    },
    {
      label: "Local manga fixture",
      format: "manga",
      direction: "rtl",
      mangaId: 42,
      chapterId: 4201,
      maxPages: 2,
    },
  ],
};

const fixtureSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200" viewBox="0 0 800 1200">
    <rect width="800" height="1200" fill="#fff"/>
    <g fill="#e8e8e8" stroke="#222" stroke-width="10">
      <rect x="32" y="48" width="344" height="516"/>
      <rect x="424" y="48" width="344" height="516"/>
      <rect x="32" y="636" width="344" height="516"/>
      <rect x="424" y="636" width="344" height="516"/>
    </g>
  </svg>
`;

async function installLocalLabFixtures(page) {
  const thirdPartyRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") thirdPartyRequests.push(request.url());
  });
  await page.route("**/fixtures/panels-detection-page.svg", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/svg+xml", body: fixtureSvg });
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let payload = {};
    if (url.pathname === "/api/comick/chapters") {
      payload = {
        chapters: [{
          title: "1",
          label: "Chapter 1",
          url: "https://comick.live/comic/panels-local-fixture/chapter-1",
        }],
      };
    } else if (url.pathname === "/api/comick/chapter") {
      payload = {
        title: "Synthetic local fixture",
        pages: ["/fixtures/panels-detection-page.svg"],
        sourcePages: ["local-fixture-page-1"],
      };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  return thirdPartyRequests;
}

async function uploadSuite(page) {
  await page.locator("#test-suite-file").setInputFiles({
    name: "local-detection-suite.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(suiteManifest)),
  });
}

async function loadFirstFixture(page) {
  await uploadSuite(page);
  await expect(page.locator("#test-suite-note")).toContainText("Case 1 of 3");
  await page.locator("#test-load").click();
  await expect(page.locator("#test-results .test-card")).toHaveCount(1);
  await expect(page.locator("#test-note")).toContainText("Loaded 1 pages");
}

async function installDeterministicDetector(page) {
  await expect.poll(() => page.evaluate(() => typeof window.PanelPilot?.detectPanelsForMode)).toBe("function");
  await page.evaluate(() => {
    window.PanelPilot.detectPanelsForMode = async () => [
      { id: "top-left", x: 0.04, y: 0.04, w: 0.43, h: 0.43, score: 0.94 },
      { id: "top-right", x: 0.53, y: 0.04, w: 0.43, h: 0.43, score: 0.92 },
      { id: "bottom-left", x: 0.04, y: 0.53, w: 0.43, h: 0.43, score: 0.9 },
      { id: "bottom-right", x: 0.53, y: 0.53, w: 0.43, h: 0.43, score: 0.88 },
    ];
  });
}

test("the Detection Test Lab loads and local suite controls drive format selection", async ({ page }) => {
  const thirdPartyRequests = await installLocalLabFixtures(page);
  const runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  const response = await page.goto("/panel-test.html", { waitUntil: "networkidle" });
  expect(response?.ok()).toBeTruthy();
  await expect(page).toHaveTitle("Panels Test Lab");
  await expect(page.getByRole("heading", { name: "Detection Test Lab" })).toBeVisible();

  await uploadSuite(page);
  await expect(page.locator("#test-suite-note")).toContainText("Case 1 of 3 · Local comic fixture");
  await expect(page.locator("#test-suite-note")).toContainText("1 manga · 1 comic · 1 webtoon");
  await expect(page.locator("#test-format")).toHaveValue("comic");
  await expect(page.locator("#test-source-type")).toHaveValue("comick");
  await expect(page.locator("#test-comic-url")).toHaveValue("https://comick.live/comic/panels-local-fixture");
  await expect(page.locator("#test-suite-previous")).toBeDisabled();
  await expect(page.locator("#test-suite-next")).toBeEnabled();

  await page.locator("#test-suite-next").click();
  await expect(page.locator("#test-suite-note")).toContainText("Case 2 of 3 · Local webtoon fixture");
  await expect(page.locator("#test-format")).toHaveValue("webtoon");
  await expect(page.locator("#test-chapter")).toHaveValue("2");

  await page.locator("#test-suite-next").click();
  await expect(page.locator("#test-suite-note")).toContainText("Case 3 of 3 · Local manga fixture");
  await expect(page.locator("#test-format")).toHaveValue("manga");
  await expect(page.locator("#test-source-type")).toHaveValue("suwayomi");
  await expect(page.locator("#test-direction")).toHaveValue("rtl");
  await expect(page.locator("#test-chapter-id")).toHaveValue("4201");
  await expect(page.locator("#test-page-limit")).toHaveValue("2");

  expect(runtimeErrors).toEqual([]);
  expect(thirdPartyRequests).toEqual([]);
});

test("detection diagnostics render while manual feedback stays local and out of export", async ({ page }) => {
  const thirdPartyRequests = await installLocalLabFixtures(page);
  await page.goto("/panel-test.html", { waitUntil: "networkidle" });
  await loadFirstFixture(page);
  await installDeterministicDetector(page);

  await page.locator("#test-run").click();
  await expect(page.locator("#test-note")).toContainText("Detection run complete");
  const row = page.locator("#test-results .test-card").first();
  await expect(row.locator(".test-metric").filter({ hasText: "Detected" }).locator("strong")).toHaveText("4");
  await expect(row.locator(".test-metric").filter({ hasText: "Confidence" }).locator("strong")).toHaveText(/^[1-9]\d?%$|^100%$/);
  await expect(row.locator(".test-metric").filter({ hasText: "Presentation" }).locator("strong")).toHaveText("Panels");
  await expect(page.locator("#summary-confidence")).toHaveText(/^[1-9]\d?%$|^100%$/);
  await expect(page.locator("#summary-fallbacks")).toHaveText("0");

  await row.locator(".test-issue").selectOption("bubble-crop");
  await row.getByRole("button", { name: "Needs work" }).click();
  await expect(row.getByRole("button", { name: "Needs work" })).toHaveAttribute("aria-pressed", "true");
  await expect(row).toHaveClass(/\bfailed\b/);

  const localFeedback = await page.evaluate(() => JSON.parse(
    localStorage.getItem("panel-pilot-panel-quality-feedback-v1") || "{}",
  ));
  expect(Object.values(localFeedback)).toContainEqual({ verdict: "bad", issues: ["bubble-crop"] });

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#test-export").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("panels-detection-report.json");
  const report = JSON.parse(await readFile(await download.path(), "utf8"));
  const serialized = JSON.stringify(report);
  expect(serialized).not.toContain("bubble-crop");
  expect(serialized).not.toContain('"verdict":"bad"');
  expect(report.pages[0].quality.verdict).toBe("unrated");
  expect(report.pages[0].quality.issues).toEqual([]);
  expect(report.qualitySummary.verdictAccuracy).toBeNull();
  expect(report.qualitySummary.issueCounts).toEqual({});
  expect(report.pages[0].quality.confidence).toBeGreaterThan(0);
  expect(report.pages[0].presentation.strategy).toBe("panels");

  await page.reload({ waitUntil: "networkidle" });
  await loadFirstFixture(page);
  const restoredRow = page.locator("#test-results .test-card").first();
  await expect(restoredRow.locator(".test-issue")).toHaveValue("bubble-crop");
  await expect(restoredRow.getByRole("button", { name: "Needs work" })).toHaveAttribute("aria-pressed", "true");

  expect(thirdPartyRequests).toEqual([]);
});
