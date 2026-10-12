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
  await page.goto("http://127.0.0.1:8765/", { waitUntil: "networkidle" });
  await page.waitForSelector(".project-card");

  assert.equal(await page.locator(".project-group").count(), 4);
  assert.equal(await page.locator(".project-card").count(), 11);
  assert.equal(await page.locator(".post-card").count(), 3);

  await page.getByRole("button", { name: "Apps", exact: true }).click();
  assert.equal(await page.locator(".project-group").count(), 1);
  assert.equal(await page.locator(".project-card").count(), 5);
  assert.equal(await page.locator("#filter-result").textContent(), "5 projects shown");
  await page.getByRole("button", { name: "All", exact: true }).click();

  const accessibility = await page.evaluate(() => {
    const headings = [...document.querySelectorAll("h1, h2, h3")].map((heading) => Number(heading.tagName[1]));
    const skippedHeading = headings.some((level, index) => index > 0 && level - headings[index - 1] > 1);
    const unnamedLinks = [...document.querySelectorAll("a")].filter(
      (link) => !(link.getAttribute("aria-label") || link.textContent.trim())
    ).length;
    const unnamedButtons = [...document.querySelectorAll("button")].filter(
      (button) => !(button.getAttribute("aria-label") || button.textContent.trim())
    ).length;
    return {
      h1s: document.querySelectorAll("h1").length,
      mains: document.querySelectorAll("main").length,
      navs: document.querySelectorAll("nav[aria-label]").length,
      skippedHeading,
      unnamedLinks,
      unnamedButtons,
    };
  });
  assert.deepEqual(accessibility, {
    h1s: 1,
    mains: 1,
    navs: 1,
    skippedHeading: false,
    unnamedLinks: 0,
    unnamedButtons: 0,
  });

  const allFilter = page.getByRole("button", { name: "All", exact: true });
  await allFilter.focus();
  const focusStyle = await allFilter.evaluate((button) => getComputedStyle(button).outlineWidth);
  assert.notEqual(focusStyle, "0px", "Keyboard focus must remain visible.");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".project-card");
  const mobile = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    navWidth: document.querySelector(".nav-links")?.getBoundingClientRect().width,
    heroWidth: document.querySelector(".hero-copy")?.getBoundingClientRect().width,
  }));
  assert.ok(mobile.scrollWidth <= mobile.viewportWidth, `Mobile page overflows: ${JSON.stringify(mobile)}`);
  assert.ok(mobile.navWidth <= mobile.viewportWidth);
  assert.ok(mobile.heroWidth <= mobile.viewportWidth);

  console.log("Browser checks passed at desktop and 390px mobile widths.");
} finally {
  await browser.close();
}
