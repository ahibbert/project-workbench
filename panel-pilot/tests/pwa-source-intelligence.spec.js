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
});
