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
  assert.equal(await page.getByRole("tab").count(), 5);
  assert.equal(await page.locator(".taxonomy-card").count(), 3);
  assert.equal(await page.locator("#concept-stage [data-project-id]").count(), 14);
  assert.equal(await page.locator("#inspector-title").textContent(), "Little Now");

  const conceptNames = [
    ["Map + drawer", "map-drawer"],
    ["Workbench desk", "workbench-desk"],
    ["Studio shelves", "studio-shelves"],
    ["Project constellation", "constellation"],
    ["Product gallery", "product-gallery"]
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

  console.log("All five launcher concepts passed desktop and mobile interaction checks.");
} finally {
  await browser.close();
}
