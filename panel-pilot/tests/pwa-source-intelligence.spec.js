import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

const summary = {
  schemaVersion: 1,
  inventory: [
    { sourceId: "1", displayName: "Manga Crisp", installed: true, formats: ["manga"] },
    { sourceId: "2", displayName: "Comic Stable", installed: true, formats: ["comic"] },
    { sourceId: "3", displayName: "Webtoon Fast", installed: true, formats: ["webtoon"] },
  ],
  scores: [
    { sourceId: "1", displayName: "Manga Crisp", mediaFormat: "manga", suitability: 94, reliability: 96, quality: 92, coverage: 88, confidence: "established", evidenceCount: 20, installed: true, obsolete: false, stale: false },
    { sourceId: "2", displayName: "Comic Stable", mediaFormat: "comic", suitability: 88, reliability: 93, quality: 82, coverage: 72, confidence: "limited", evidenceCount: 8, installed: true, obsolete: false, stale: false },
    { sourceId: "3", displayName: "Webtoon Fast", mediaFormat: "webtoon", suitability: 81, reliability: 86, quality: 78, coverage: 69, confidence: "limited", evidenceCount: 6, installed: true, obsolete: false, stale: false },
  ],
  benchmarkRuns: [],
  counts: { sources: 3, packages: 3, installed: 3, obsolete: 0 },
};

test("Settings ranks private source health and filters by reading format", async ({ page }) => {
  await page.route("**/api/source-intelligence*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(summary) });
  });
  await page.goto("/");
  await page.locator("#nav-settings").click();
  await page.locator("#refresh-source-intelligence").click();

  await expect(page.locator("#source-intelligence-state")).toHaveText("3 ranked");
  await expect(page.locator(".source-intelligence-row")).toHaveCount(3);
  await expect(page.locator(".source-intelligence-row").first()).toContainText("Manga Crisp");
  await expect(page.locator(".source-intelligence-row").first()).toContainText("94");

  await page.getByRole("button", { name: "Comics", exact: true }).click();
  await expect(page.locator(".source-intelligence-row")).toHaveCount(1);
  await expect(page.locator(".source-intelligence-row")).toContainText("Comic Stable");
  await expect(page.locator("#source-intelligence-state")).toHaveText("1 ranked");
});

test("Browse exposes one Western-comics feed beside manga recommendations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("panel-pilot-settings", JSON.stringify({
      baseUrl: "http://recommendations.invalid:4567",
      readerMotion: "instant",
    }));
  });
  await page.route("**/api/source-intelligence*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(summary) });
  });
  await page.route("**/api/suwayomi/graphql*", async (route) => {
    const payload = route.request().postDataJSON() || {};
    const query = String(payload.query || "");
    const sourceId = String(payload.variables?.input?.source || "");
    let data = {};
    if (query.includes("HEALTH")) {
      data = { __schema: { queryType: { name: "Query" }, mutationType: { name: "Mutation" } } };
    } else if (query.includes("GET_SOURCES_LIST")) {
      data = { sources: { nodes: [
        { id: "2", name: "comicstable", displayName: "Comic Stable", lang: "en", isNsfw: false },
        { id: "4", name: "comicbackup", displayName: "Comic Backup", lang: "en", isNsfw: false },
      ] } };
    } else if (query.includes("GET_LIBRARY_MANGAS")) {
      data = { mangas: { totalCount: 0, nodes: [] } };
    } else if (query.includes("GET_SOURCE_MANGAS_FETCH")) {
      data = { fetchSourceManga: { hasNextPage: false, mangas: payload.variables?.input?.type === "SEARCH" ? [{
        id: sourceId === "2" ? 201 : 401,
        title: "Paper Girls",
        sourceId,
        thumbnailUrl: "",
      }] : [] } };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
  });
  await page.route("**/api/comic-recommendations*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        configured: true,
        status: "ready",
        mode: "personalized",
        seedTitles: ["Saga"],
        cacheStatus: "hit",
        results: [{
          id: "librarything:paper-girls",
          title: "Paper Girls",
          searchTitles: ["Paper Girls"],
          mediaFormat: "comic",
          coverUrl: "https://covers.openlibrary.org/b/id/1-M.jpg",
          creators: ["Brian K. Vaughan"],
          year: 2015,
          reason: { type: "because_you_read", seedTitles: ["Saga"] },
          rank: 1,
        }],
      }),
    });
  });
  await page.goto("/");
  await page.locator("#nav-browse").click();
  await page.locator("#refresh-comic-recommendations").click();

  await expect(page.locator("#comic-recommendation-results .recommendation-card")).toHaveCount(1);
  await expect(page.locator("#comic-recommendation-results")).toContainText("Paper Girls");
  await expect(page.locator("#comic-recommendation-results")).toContainText("Because you read Saga");
  await expect(page.locator("#comic-recommendations-note")).toContainText("Based on 1 comic");
  const headingBox = await page.locator("#comic-recommendations-title").boundingBox();
  const firstCardBox = await page.locator("#comic-recommendation-results .recommendation-card").first().boundingBox();
  expect(firstCardBox.x).toBeGreaterThanOrEqual(headingBox.x - 2);

  await page.getByRole("button", { name: "Read this", exact: true }).click();
  await expect(page.locator("#recommendation-context-title")).toHaveText("Choose a source for Paper Girls");
  await expect(page.locator("#recommendation-context-note")).toContainText("image quality, and reliability");
  await expect(page.locator("#manga-results .manga-card")).toHaveCount(2);
  await expect(page.locator("#manga-results .manga-card").first()).toContainText("Comic Stable");
  await expect(page.locator("#manga-results .manga-card").first()).toContainText("88/100 overall · Q 82 · R 93");
});
