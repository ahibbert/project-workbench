import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const modules = process.env.WORKSPACE_NODE_MODULES ?? resolve("node_modules");
const edgePath = process.env.EDGE_PATH;
const siteUrl = process.env.SITE_URL ?? "http://127.0.0.1:8765/";
const output = process.env.SHOT_DIR ?? resolve("site-shots");
const requireFromModules = createRequire(resolve(modules, "playwright", "package.json"));
const { chromium } = requireFromModules("playwright");

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: edgePath });

try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await desktop.goto(siteUrl, { waitUntil: "networkidle" });
  await desktop.screenshot({ path: resolve(output, "home-desktop.png"), fullPage: true });
  await desktop.getByRole("button", { name: "Open Margin" }).click();
  await desktop.locator("#apps").screenshot({ path: resolve(output, "apps-open-desktop.png") });

  const medium = await browser.newPage({ viewport: { width: 980, height: 800 }, deviceScaleFactor: 1 });
  await medium.goto(siteUrl, { waitUntil: "networkidle" });
  await medium.screenshot({ path: resolve(output, "home-medium.png"), fullPage: false });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await mobile.goto(siteUrl, { waitUntil: "networkidle" });
  await mobile.screenshot({ path: resolve(output, "home-mobile.png"), fullPage: false });
  await mobile.getByRole("button", { name: "Open Little Now" }).click();
  await mobile.locator("#apps").screenshot({ path: resolve(output, "apps-open-mobile.png") });
  console.log(`Captured production homepage previews in ${output}.`);
} finally {
  await browser.close();
}
