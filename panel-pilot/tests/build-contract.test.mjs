import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(projectRoot, "dist");

function readDist(path) {
  return readFileSync(join(distRoot, path), "utf8");
}

function listFiles(directory, root = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path, root) : [relative(root, path).replaceAll("\\", "/")];
  });
}

function tagAttribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1] ?? null;
}

function localAssetReferences(html) {
  const references = [];
  for (const tag of html.matchAll(/<(?:script|link|img)\b[^>]*>/gi)) {
    const reference = tagAttribute(tag[0], "src") ?? tagAttribute(tag[0], "href");
    if (!reference || /^(?:data:|https?:|\/\/|#)/i.test(reference)) continue;
    references.push(reference);
  }
  return references;
}

function normalizedBuildPath(reference) {
  const path = reference.split(/[?#]/, 1)[0];
  return decodeURIComponent(path).replace(/^\.\//, "").replace(/^\//, "");
}

function precacheUrls(worker) {
  const urls = [];
  const pattern = /(?:\burl|["']url["'])\s*:\s*["']([^"']+)["']/g;
  for (const match of worker.matchAll(pattern)) urls.push(normalizedBuildPath(match[1]));
  return [...new Set(urls)];
}

test("the production directory contains the complete multi-page app", () => {
  assert.ok(existsSync(distRoot), "dist is missing; run npm run build before the contract tests");

  const files = listFiles(distRoot);
  for (const required of ["index.html", "login.html", "panel-test.html", "manifest.webmanifest", "sw.js"]) {
    assert.ok(files.includes(required), `dist/${required} is missing`);
  }

  const manifest = JSON.parse(readDist("manifest.webmanifest"));
  assert.equal(manifest.name, "Panels", "the installed app name must match the released brand");
  assert.equal(manifest.short_name, "Panels", "the launcher name must match the released brand");
  assert.equal(
    new URL(manifest.start_url, "https://panel-pilot.invalid").pathname,
    "/",
    "the installed app must start at the origin root",
  );
  assert.equal(manifest.scope, "/", "the manifest scope must remain at the origin root");
  assert.equal(manifest.display, "standalone");
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, "manifest icons are missing");
  assert.ok(manifest.icons.some((icon) => icon.purpose?.split(/\s+/).includes("maskable")), "a maskable icon is required");

  for (const icon of manifest.icons) {
    const iconPath = normalizedBuildPath(icon.src);
    assert.ok(iconPath, "manifest icon has an empty src");
    const absoluteIconPath = join(distRoot, iconPath);
    assert.ok(existsSync(absoluteIconPath), `manifest icon dist/${iconPath} is missing`);
    const iconBytes = readFileSync(absoluteIconPath);
    assert.equal(iconBytes.subarray(1, 4).toString("ascii"), "PNG", `${iconPath} is not a PNG`);
    const [expectedWidth, expectedHeight] = icon.sizes.split("x").map(Number);
    assert.equal(iconBytes.readUInt32BE(16), expectedWidth, `${iconPath} has the wrong width`);
    assert.equal(iconBytes.readUInt32BE(20), expectedHeight, `${iconPath} has the wrong height`);
    assert.ok(statSync(absoluteIconPath).size > 10_000, `${iconPath} does not contain the released artwork`);
  }
});

test("built pages use existing hashed assets and no hand-maintained version queries", () => {
  const htmlFiles = ["index.html", "login.html", "panel-test.html"];
  const executableAssets = [];

  for (const htmlFile of htmlFiles) {
    const html = readDist(htmlFile);
    assert.doesNotMatch(html, /\?v=/i, `${htmlFile} still contains a manual ?v= version`);

    for (const reference of localAssetReferences(html)) {
      const assetPath = normalizedBuildPath(reference);
      assert.ok(existsSync(join(distRoot, assetPath)), `${htmlFile} references missing dist/${assetPath}`);
      if (/\.(?:js|css)$/i.test(assetPath)) executableAssets.push(assetPath);
    }
  }

  assert.ok(executableAssets.length >= 2, "the built pages do not reference generated JavaScript/CSS assets");
  for (const asset of executableAssets) {
    assert.match(
      basename(asset),
      /-[A-Za-z0-9_-]{6,}\.(?:js|css)$/,
      `${asset} is not content hashed`,
    );
  }
});

test("the injected worker precaches only the application shell", () => {
  const worker = readDist("sw.js");
  assert.doesNotMatch(worker, /self\.__WB_MANIFEST/, "the Workbox manifest placeholder was not injected");

  const cached = precacheUrls(worker);
  assert.ok(cached.length > 0, "no injected Workbox precache entries were found");
  assert.ok(cached.includes("index.html"), "index.html is not precached");
  assert.ok(cached.includes("manifest.webmanifest"), "manifest.webmanifest is not precached");

  const indexAssets = localAssetReferences(readDist("index.html"))
    .map(normalizedBuildPath)
    .filter((path) => /\.(?:js|css)$/i.test(path));
  for (const asset of indexAssets) {
    assert.ok(cached.includes(asset), `application-shell asset ${asset} is not precached`);
  }

  const manifest = JSON.parse(readDist("manifest.webmanifest"));
  for (const icon of manifest.icons) {
    const iconPath = normalizedBuildPath(icon.src);
    assert.ok(cached.includes(iconPath), `manifest icon ${iconPath} is not precached`);
  }

  for (const url of cached) {
    assert.doesNotMatch(url, /(?:^|\/)login(?:\.html)?(?:$|[/?#])/i, `login resource ${url} must not be precached`);
    assert.doesNotMatch(url, /panel-?test/i, `Test Lab resource ${url} must not be precached`);
    assert.doesNotMatch(url, /(?:^|\/)api(?:\/|$)/i, `API resource ${url} must not be precached`);
    assert.doesNotMatch(url, /(?:^|\/)(?:data|chapters?|user-content)(?:\/|$)/i, `user content ${url} must not be precached`);
  }
});

test("dist is isolated from application source and server data", () => {
  const files = listFiles(distRoot);
  const forbiddenDirectories = ["data", "deploy", "ml", "src", "tests", "tools"];
  const forbiddenFiles = [
    "package.json",
    "package-lock.json",
    "server.py",
    "vite.config.js",
    "main.js",
    "panel-test.js",
    "styles.css",
  ];

  for (const directory of forbiddenDirectories) {
    assert.ok(!existsSync(join(distRoot, directory)), `dist unexpectedly contains /${directory}`);
  }
  for (const file of forbiddenFiles) {
    assert.ok(!files.includes(file), `dist unexpectedly contains source file ${file}`);
  }

  for (const file of files.filter((path) => /\.(?:js|css)$/i.test(path) && path !== "sw.js")) {
    assert.match(basename(file), /-[A-Za-z0-9_-]{6,}\.(?:js|css)$/, `${file} is an unhashed production asset`);
  }
});

test("the Docker runtime stage contains only the server and generated frontend", () => {
  const dockerfile = readFileSync(join(projectRoot, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:22\.21\.1-alpine AS frontend-builder$/m);

  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("FROM python:"));
  assert.match(runtimeStage, /^ENV PANEL_PILOT_STATIC_ROOT=\/app\/web$/m);
  assert.match(runtimeStage, /^COPY server\.py \.\/server\.py$/m);
  assert.match(runtimeStage, /^COPY --from=frontend-builder \/build\/dist \.\/web$/m);
  assert.doesNotMatch(runtimeStage, /^COPY\s+\.\s+/m, "the runtime stage must not copy the source tree");
  assert.doesNotMatch(runtimeStage, /package(?:-lock)?\.json|\/src\b|\/data\b/m);
});
