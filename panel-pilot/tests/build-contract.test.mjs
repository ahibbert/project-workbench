import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(projectRoot, "dist");
const iconSetBudgetBytes = 300_000;
const installShellBudgetBytes = 675_000;

function readSource(path) {
  return readFileSync(join(projectRoot, path), "utf8");
}

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

test("the production icon set and install shell stay within raw-byte budgets", () => {
  assert.ok(existsSync(distRoot), "dist is missing; run npm run build before the contract tests");

  const manifest = JSON.parse(readDist("manifest.webmanifest"));
  const iconPaths = new Set([
    ...manifest.icons.map((icon) => normalizedBuildPath(icon.src)),
    "assets/apple-touch-icon.png",
  ]);
  let iconBytes = 0;
  for (const iconPath of iconPaths) {
    const absoluteIconPath = join(distRoot, iconPath);
    assert.ok(existsSync(absoluteIconPath), `install icon dist/${iconPath} is missing`);
    iconBytes += statSync(absoluteIconPath).size;
  }

  const worker = readDist("sw.js");
  const shellPaths = new Set([...precacheUrls(worker), "sw.js"]);
  let installShellBytes = 0;
  for (const shellPath of shellPaths) {
    const absoluteShellPath = join(distRoot, shellPath);
    assert.ok(existsSync(absoluteShellPath), `install-shell file dist/${shellPath} is missing`);
    installShellBytes += statSync(absoluteShellPath).size;
  }
  assert.ok(
    iconBytes <= iconSetBudgetBytes,
    `install icons use ${iconBytes} bytes; budget is ${iconSetBudgetBytes} bytes`,
  );
  assert.ok(
    installShellBytes <= installShellBudgetBytes,
    `install shell uses ${installShellBytes} bytes; budget is ${installShellBudgetBytes} bytes`,
  );
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

test("the worker keeps device chapter media cache-only and isolated from app cleanup", () => {
  const source = readSource("src/sw.js");
  const builtWorker = readDist("sw.js");
  const cacheName = "panels-device-chapters-v1";
  const pathPrefix = "/__panels_device_chapters/v1/";

  assert.match(
    source,
    /const deviceChapterCacheName\s*=\s*["']panels-device-chapters-v1["']\s*;/,
    "the device chapter cache name changed",
  );
  assert.match(
    source,
    /const deviceChapterPathPrefix\s*=\s*["']\/__panels_device_chapters\/v1\/["']\s*;/,
    "the device chapter virtual path changed",
  );
  assert.ok(builtWorker.includes(cacheName), "the built worker is missing the device chapter cache name");
  assert.ok(builtWorker.includes(pathPrefix), "the built worker is missing the device chapter path prefix");

  const deviceResponderStart = source.indexOf("async function deviceChapterResponse");
  const messageHandlerStart = source.indexOf('self.addEventListener("message"');
  assert.ok(deviceResponderStart >= 0 && messageHandlerStart > deviceResponderStart, "device chapter responder is missing");
  const deviceResponder = source.slice(deviceResponderStart, messageHandlerStart);
  assert.match(deviceResponder, /caches\.open\(deviceChapterCacheName\)/, "device media must use its dedicated cache");
  assert.match(
    deviceResponder,
    /\.match\(request,\s*\{\s*ignoreSearch:\s*true\s*\}\)/,
    "device media lookups must ignore the query string",
  );
  assert.match(deviceResponder, /status:\s*404/, "a cache miss must return an explicit 404");
  assert.doesNotMatch(deviceResponder, /\bfetch\s*\(/, "device chapter media must never fall through to the network");

  const deviceRouteStart = source.indexOf("url.pathname.startsWith(deviceChapterPathPrefix)");
  const onlineOnlyRouteStart = source.indexOf("isOnlineOnlyPath(url.pathname)");
  const genericAssetHandlingStart = source.lastIndexOf("const precachedResponse = await matchPrecache(request)");
  assert.ok(deviceRouteStart >= 0, "the device chapter route is missing");
  assert.ok(
    deviceRouteStart < onlineOnlyRouteStart && deviceRouteStart < genericAssetHandlingStart,
    "the device chapter route must run before online-only and generic asset handling",
  );
  const deviceRoute = source.slice(deviceRouteStart, onlineOnlyRouteStart);
  assert.match(deviceRoute, /event\.respondWith\(deviceChapterResponse\(request\)\)/);
  assert.match(deviceRoute, /return\s*;/, "the cache-only device route must terminate fetch handling");
  assert.doesNotMatch(deviceRoute, /\bfetch\s*\(/, "the cache-only route must not perform a network request");

  assert.match(
    source,
    /function isObsoleteLegacyAppCache\(cacheKey\)\s*\{[\s\S]*?cacheKey !== deviceChapterCacheName[\s\S]*?legacyAppCachePattern\.test\(cacheKey\)[\s\S]*?\}/,
    "legacy cache cleanup must explicitly exclude the device chapter cache",
  );
  assert.match(source, /\.filter\(isObsoleteLegacyAppCache\)/, "activation must use the protected cleanup predicate");
  assert.doesNotMatch(
    source,
    /caches\.delete\(deviceChapterCacheName\)/,
    "activation must never delete the device chapter cache",
  );
});

test("the app negotiates device chapter support with the controlling worker", () => {
  const workerSource = readSource("src/sw.js");
  const appSource = readSource("src/main.js");
  const builtWorker = readDist("sw.js");

  assert.match(
    workerSource,
    /event\.data\?\.type\s*===\s*["']DEVICE_CHAPTER_CAPABILITY["']/,
    "the worker capability request type is missing",
  );
  assert.match(
    workerSource,
    /event\.ports\?\.\[0\]\?\.postMessage\(\{\s*supported:\s*true,\s*version:\s*1\s*\}\)/,
    "the worker must answer capability requests through the provided MessagePort",
  );
  assert.ok(
    builtWorker.includes("DEVICE_CHAPTER_CAPABILITY"),
    "the built worker is missing the device chapter capability protocol",
  );

  assert.match(appSource, /const channel = new MessageChannel\(\)/, "the app must use a private capability reply channel");
  assert.match(
    appSource,
    /controller\.postMessage\(\{\s*type:\s*["']DEVICE_CHAPTER_CAPABILITY["']\s*\},\s*\[channel\.port2\]\)/,
    "the app must ask the active controller for device chapter support",
  );
  assert.match(
    appSource,
    /event\.data\?\.supported\s*===\s*true\s*&&\s*Number\(event\.data\?\.version\)\s*>=\s*1/,
    "the app must validate both support and protocol version",
  );
  assert.match(
    appSource,
    /async function requireDeviceChapterWorker\(\)[\s\S]*?refreshDeviceChapterWorkerCapability\(\)[\s\S]*?showAppUpdate\(\)[\s\S]*?throw new Error/,
    "device chapter operations must fail closed and reveal the update action when capability is absent",
  );
  assert.match(
    appSource,
    /async function openDeviceChapter\([^)]*\)\s*\{[\s\S]*?await requireDeviceChapterWorker\(\)/,
    "opening device chapters must require the capable worker",
  );
  assert.match(
    appSource,
    /async function downloadChapterToDevice\([^)]*\)\s*\{[\s\S]*?await requireDeviceChapterWorker\(\)/,
    "downloading device chapters must require the capable worker",
  );
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

test("the Docker runtime stage contains only the server, generated frontend, and notices", () => {
  const dockerfile = readFileSync(join(projectRoot, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:22\.21\.1-alpine AS frontend-builder$/m);

  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("FROM python:"));
  assert.match(runtimeStage, /^ENV PANEL_PILOT_STATIC_ROOT=\/app\/web$/m);
  assert.match(runtimeStage, /^COPY server\.py \.\/server\.py$/m);
  assert.match(runtimeStage, /^COPY LICENSE THIRD_PARTY_NOTICES\.md \.\/$/m);
  assert.match(runtimeStage, /^COPY --from=frontend-builder \/build\/dist \.\/web$/m);
  assert.doesNotMatch(runtimeStage, /^COPY\s+\.\s+/m, "the runtime stage must not copy the source tree");
  assert.doesNotMatch(runtimeStage, /package(?:-lock)?\.json|\/src\b|\/data\b/m);
});
