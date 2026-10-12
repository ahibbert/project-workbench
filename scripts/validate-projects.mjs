import { readFileSync } from "node:fs";

const registry = JSON.parse(readFileSync(new URL("../projects.json", import.meta.url), "utf8"));
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const groupIds = registry.groups.map((group) => group.id);
const projectIds = registry.projects.map((project) => project.id);

assert(registry.groups.length === 4, "The launcher must keep the four agreed work areas.");
assert(new Set(groupIds).size === groupIds.length, "Group IDs must be unique.");
assert(new Set(projectIds).size === projectIds.length, "Project IDs must be unique.");
assert(registry.latestPosts.length > 0, "At least one current post is required.");

for (const group of registry.groups) {
  assert(group.label && group.shortLabel && group.description, `Group ${group.id} is incomplete.`);
  assert(registry.projects.some((project) => project.group === group.id), `Group ${group.id} is empty.`);
  assert(html.includes(`href="#${group.id}"`), `Navigation is missing #${group.id}.`);
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
