import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(projectRoot, "dist");
const viteCli = join(projectRoot, "node_modules", "vite", "bin", "vite.js");
const buildId = process.env.PANEL_PILOT_BUILD_ID || "reproducibility-check";

function build() {
  const result = spawnSync(process.execPath, [viteCli, "build"], {
    cwd: projectRoot,
    env: { ...process.env, PANEL_PILOT_BUILD_ID: buildId },
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`Vite build failed with exit code ${result.status ?? "unknown"}`);
  }
}

function snapshot(directory, root = directory, output = new Map()) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      snapshot(path, root, output);
      continue;
    }

    const bytes = readFileSync(path);
    const name = relative(root, path).replaceAll("\\", "/");
    output.set(name, {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return output;
}

function compare(first, second) {
  const firstNames = [...first.keys()].sort();
  const secondNames = [...second.keys()].sort();
  const missing = firstNames.filter((name) => !second.has(name));
  const added = secondNames.filter((name) => !first.has(name));
  const changed = firstNames
    .filter((name) => second.has(name) && !first.get(name).bytes.equals(second.get(name).bytes))
    .map((name) => ({
      file: name,
      firstSha256: first.get(name).sha256,
      secondSha256: second.get(name).sha256,
    }));

  if (!missing.length && !added.length && !changed.length) return;

  const details = [
    missing.length ? `missing after second build: ${missing.join(", ")}` : null,
    added.length ? `added by second build: ${added.join(", ")}` : null,
    ...changed.map(({ file, firstSha256, secondSha256 }) =>
      `changed: ${file}\n  first:  ${firstSha256}\n  second: ${secondSha256}`),
  ].filter(Boolean);
  throw new Error(`Production output is not reproducible for build ID ${buildId}:\n${details.join("\n")}`);
}

if (!existsSync(viteCli)) {
  throw new Error("Vite is not installed; run npm ci before checking build reproducibility");
}

build();
const first = snapshot(distRoot);
build();
const second = snapshot(distRoot);
compare(first, second);

process.stdout.write(
  `Verified ${second.size} production files are byte-identical across two builds (build ID: ${buildId}).\n`,
);
