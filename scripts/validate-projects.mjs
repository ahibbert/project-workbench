import { existsSync, readFileSync } from "node:fs";

const registry = JSON.parse(readFileSync(new URL("../projects.json", import.meta.url), "utf8"));
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const groupIds = registry.groups.map((group) => group.id);
const projectIds = registry.projects.map((project) => project.id);

assert(registry.groups.length === 3, "The workbench must contain Research, Apps and Blogs.");
assert(groupIds.join(",") === "research,apps,blogs", "Work areas must be ordered Research, Apps, Blogs.");
assert(new Set(groupIds).size === groupIds.length, "Group IDs must be unique.");
assert(new Set(projectIds).size === projectIds.length, "Project IDs must be unique.");
assert(registry.projects.length === 14, "The workbench must contain the 14 current projects.");
assert(registry.latestPosts.length > 0, "At least one current post is required.");

for (const group of registry.groups) {
  assert(group.label && group.shortLabel && group.description, `Group ${group.id} is incomplete.`);
  assert(registry.projects.some((project) => project.group === group.id), `Group ${group.id} is empty.`);
  assert(html.includes(`href="#${group.id}"`), `Navigation is missing #${group.id}.`);
}

assert(!projectIds.includes("llm-review-bench"), "The abandoned LLM review bench must not be listed.");
assert(projectIds.includes("gamlss-longitudinal-paper"), "The longitudinal GAMLSS paper is missing.");

const script = readFileSync(new URL("../script.js", import.meta.url), "utf8");
const assetPaths = [...script.matchAll(/assets\/projects\/[a-z0-9-]+\/[a-z0-9-]+\.webp/g)].map((match) => match[0]);
assert(assetPaths.length > 0, "No project imagery is registered.");
for (const path of new Set(assetPaths)) {
  assert(existsSync(new URL(`../${path}`, import.meta.url)), `Missing project image: ${path}`);
}

for (const project of registry.projects) {
  assert(groupIds.includes(project.group), `${project.id} has an unknown group.`);
  assert(project.title && project.type && project.status && project.statusTone, `${project.id} is incomplete.`);
  assert(Array.isArray(project.links), `${project.id} links must be an array.`);

  for (const link of project.links) {
    const url = new URL(link.href);
    assert(url.protocol === "https:", `${project.id} has a non-HTTPS link.`);
    assert(!url.hostname.endsWith("chatgpt.site"), `${project.id} exposes an internal Sites hostname.`);
    assert(
      !/^github\.com\/ahibbert\/(little-now|panels|panels-external|starfall-company|gamlss-playground)/.test(`${url.hostname}${url.pathname}`),
      `${project.id} exposes a private repository.`
    );
  }
}

const littleNow = registry.projects.find((project) => project.id === "little-now");
assert(littleNow?.links.some((link) => link.href === "https://little-now.aydins-workbench.com"), "Little Now website is missing.");
assert(littleNow?.links.some((link) => link.href === "https://apps.apple.com/app/id6821227588"), "Little Now App Store link is missing.");

console.log(`Validated ${registry.projects.length} projects across ${registry.groups.length} groups.`);
