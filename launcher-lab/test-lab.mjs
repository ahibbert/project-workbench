import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const modules = process.env.WORKSPACE_NODE_MODULES ?? resolve("node_modules");
const edgePath = process.env.EDGE_PATH;
const requireFromModules = createRequire(resolve(modules, "playwright", "package.json"));
const { chromium } = requireFromModules("playwright");

const browser = await chromium.launch({ headless: true, executablePath: edgePath });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto("http://127.0.0.1:8875/", { waitUntil: "networkidle" });

  assert.equal(await page.locator("h1").count(), 1);
  assert.equal(await page.getByRole("tab").count(), 7);
  assert.equal(await page.locator(".detail-mode").count(), 3);
  assert.equal(await page.locator(".taxonomy-card").count(), 3);
  assert.deepEqual(await page.locator(".taxonomy-card h3").allTextContents(), ["Research", "Apps", "Blogs"]);
  assert.equal(await page.locator("#concept-stage [data-project-id]").count(), 14);
  assert.equal(await page.locator('[data-project-id="llm-review-bench"]').count(), 0);
  assert.equal(await page.locator('[data-project-id="gamlss-longitudinal-paper"]').count(), 1);
  assert.equal(await page.locator("#project-inspector").isVisible(), false);
  assert.equal(await page.locator("[data-project-id][aria-expanded=true]").count(), 0);
  assert.equal(await page.locator(".artifact-real").count(), 14);
  assert.equal(await page.locator(".artifact-thumbnail").count(), 8);
  assert.ok((await page.locator(".page-shell").first().boundingBox()).width <= 981, "inner content should stay capped near 980px");
  assert.ok((await page.locator("body").boundingBox()).width >= 1439, "page chrome should span the desktop viewport");
  assert.ok((await page.locator(".lab-header").boundingBox()).width >= 1439, "header bar should span the desktop viewport");
  await page.waitForFunction(() => [...document.querySelectorAll(".artifact-real img")].every((image) => image.complete && image.naturalWidth > 0));
  assert.equal(await page.locator(".artifact-real img").evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0)), true);

  const conceptNames = [
    ["Map + drawer", "map-drawer"],
    ["Workbench desk", "workbench-desk"],
    ["Studio shelves", "studio-shelves"],
    ["Project constellation", "constellation"],
    ["Product gallery", "product-gallery"],
    ["Workbench gallery", "workbench-gallery"],
    ["Project folios", "project-folios"]
  ];

  for (const [, id] of conceptNames) {
    await page.locator(`[role="tab"][data-concept="${id}"]`).click();
    assert.equal(await page.locator("#concept-stage").getAttribute("data-concept"), id);
    assert.equal(await page.locator("#concept-stage [data-project-id]").count(), 14);
  }

  await page.getByRole("button", { name: "Research", exact: true }).click();
  assert.equal(await page.locator("#concept-stage [data-project-id]").count(), 4);
  assert.equal(await page.locator("#project-count").textContent(), "4 entries");
  await page.getByRole("button", { name: "Everything", exact: true }).click();

  await page.getByRole("tab", { name: /Studio shelves/ }).click();
  await page.locator('[data-project-id="starfall-company"]').click();
  assert.equal(await page.locator("#inspector-title").textContent(), "Starfall Company");

  await page.getByRole("button", { name: /Desk dossier/ }).click();
  await page.locator('[data-project-id="little-now"]').click();
  assert.equal(await page.locator("#project-dialog").getAttribute("open"), "");
  assert.equal(await page.locator("#dialog-inspector-title").textContent(), "Little Now");
  await page.getByRole("button", { name: "Close project dossier" }).click();
  assert.equal(await page.locator("#project-dialog").getAttribute("open"), null);

  await page.getByRole("button", { name: /Inline sheet/ }).click();
  await page.getByRole("tab", { name: /Workbench desk/ }).click();
  assert.equal(await page.locator(".desk-inline-sheet .project-media-item").count(), 2);
  await page.locator('[data-project-id="housing-note"]').click();
  assert.equal(await page.locator("#inline-inspector").isVisible(), false);
  assert.equal(await page.locator(".desk-inline-sheet").isVisible(), true);
  assert.equal(await page.locator("#desk-inline-title").textContent(), "A First Pass At Australian Dwelling Prices");
  assert.equal(await page.locator(".desk-zone-blogs .desk-inline-sheet").count(), 1);
  assert.equal(await page.locator(".desk-zone-blogs .desk-inline-sheet .project-media-item").count(), 1);
  const selectedCardBox = await page.locator('[data-project-id="housing-note"]').boundingBox();
  const inlineSheetBox = await page.locator(".desk-zone-blogs .desk-inline-sheet").boundingBox();
  assert.ok(inlineSheetBox.x > selectedCardBox.x, "inline sheet should open to the right of the selected card");
  await page.locator('[data-project-id="housing-note"]').click();
  assert.equal(await page.locator(".desk-inline-sheet").count(), 0);
  await page.locator('[data-project-id="housing-note"]').click();

  await page.getByRole("tab", { name: /Product gallery/ }).click();
  assert.equal(await page.locator("#inline-inspector").isVisible(), true);
  assert.equal(await page.locator("#inline-inspector-title").textContent(), "A First Pass At Australian Dwelling Prices");

  await page.setViewportSize({ width: 390, height: 844 });
  for (const [, id] of conceptNames) {
    await page.locator(`[role="tab"][data-concept="${id}"]`).click();
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth
    }));
    assert.ok(dimensions.scroll <= dimensions.viewport, `${id} overflows at 390px: ${JSON.stringify(dimensions)}`);
  }

  const unnamedControls = await page.evaluate(() =>
    [...document.querySelectorAll("button, a")].filter(
      (node) => !(node.getAttribute("aria-label") || node.textContent.trim())
    ).length
  );
  assert.equal(unnamedControls, 0);

  console.log("All seven launcher concepts and three detail treatments passed desktop and mobile interaction checks.");
} finally {
  await browser.close();
}
