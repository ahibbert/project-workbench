import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const modules = process.env.WORKSPACE_NODE_MODULES ?? resolve("node_modules");
const edgePath = process.env.EDGE_PATH;
const output = process.env.SHOT_DIR ?? resolve("launcher-lab-shots");
const requireFromModules = createRequire(resolve(modules, "playwright", "package.json"));
const { chromium } = requireFromModules("playwright");
const concepts = ["map-drawer", "workbench-desk", "studio-shelves", "constellation", "product-gallery", "workbench-gallery", "project-folios"];

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: edgePath });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  await page.goto("http://127.0.0.1:8875/", { waitUntil: "networkidle" });
  for (const concept of concepts) {
    await page.locator(`[role="tab"][data-concept="${concept}"]`).click();
    await page.locator(".prototype-frame").screenshot({ path: resolve(output, `${concept}-stage.png`) });
  }
  await page.locator('[role="tab"][data-concept="workbench-gallery"]').click();
  await page.getByRole("button", { name: /Desk dossier/ }).click();
  await page.locator('[data-project-id="little-now"]').click();
  await page.locator("#project-dialog").screenshot({ path: resolve(output, "detail-desk-dossier.png") });
  await page.getByRole("button", { name: "Close project dossier" }).click();
  await page.getByRole("button", { name: /Inline sheet/ }).click();
  await page.locator('[role="tab"][data-concept="workbench-desk"]').click();
  await page.locator('[data-project-id="housing-note"]').click();
  await page.locator(".prototype-frame").screenshot({ path: resolve(output, "detail-inline-sheet.png") });
  console.log(`Captured ${concepts.length} concept stages and two detail treatments in ${output}.`);
} finally {
  await browser.close();
}
