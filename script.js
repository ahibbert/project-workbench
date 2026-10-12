const registryUrl = "projects.json";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createLinks(links) {
  const wrapper = element("div", "card-links");
  links.forEach(({ label, href }) => {
    const link = element("a", "", label);
    link.href = href;
    if (href.startsWith("http")) link.rel = "noreferrer";
    wrapper.append(link);
  });
  return wrapper;
}

function createDetails(details) {
  const container = element("details", "project-details");
  container.append(element("summary", "", "Project brief"));

  const grid = element("div", "detail-grid");
  Object.entries(details).forEach(([label, value]) => {
    const row = element("div", "detail-row");
    row.append(element("strong", "", label), element("span", "", value));
    grid.append(row);
  });
  container.append(grid);
  return container;
}

function createProjectCard(project) {
  const card = element("article", `project-card${project.featured ? " featured" : ""}`);
  card.dataset.group = project.group;

  const top = element("div", "card-top");
  top.append(element("h3", "", project.title), element("span", "type-chip", project.type));

  const meta = element("div", "card-meta");
  meta.append(
    element("span", `status-chip ${project.statusTone}`, project.status),
    element("span", "access-chip", project.access)
  );

  card.append(top, meta, element("p", "", project.description));
  if (project.details) card.append(createDetails(project.details));

  if (project.links.length > 0) {
    card.append(createLinks(project.links));
  } else {
    card.append(element("span", "availability-note", project.access));
  }
  return card;
}

function createGroup(group, projects) {
  const section = element("section", "project-group");
  section.id = group.id;
  section.setAttribute("aria-labelledby", `${group.id}-title`);

  const heading = element("div", "group-heading");
  const titleBlock = element("div", "");
  titleBlock.append(
    element("span", "group-count", `${projects.length} ${projects.length === 1 ? "project" : "projects"}`),
    element("h2", "", group.label)
  );
  titleBlock.querySelector("h2").id = `${group.id}-title`;

  const copy = element("div", "");
  copy.append(element("p", "eyebrow", group.eyebrow), element("p", "", group.description));
  heading.append(titleBlock, copy);

  const grid = element("div", "card-grid");
  grid.append(...projects.map(createProjectCard));
  section.append(heading, grid);
  return section;
}

function createPostCard(post) {
  const card = element("article", "post-card");
  card.append(
    element("h3", "", post.title),
    element("p", "post-meta", `${post.date} · ${post.theme}`),
    element("p", "", post.description)
  );
  const link = element("a", "post-link", "Read the note");
  link.href = post.href;
  link.rel = "noreferrer";
  card.append(link);
  return card;
}

function setupFilters(registry) {
  const filters = document.querySelector("#project-filters");
  const result = document.querySelector("#filter-result");
  let activeFilter = "all";

  const options = [{ id: "all", shortLabel: "All" }, ...registry.groups];
  const buttons = options.map((option) => {
    const button = element("button", "filter-button", option.shortLabel);
    button.type = "button";
    button.dataset.filter = option.id;
    button.setAttribute("aria-pressed", option.id === activeFilter ? "true" : "false");
    button.addEventListener("click", () => {
      activeFilter = option.id;
      buttons.forEach((item) => item.setAttribute("aria-pressed", item === button ? "true" : "false"));
      renderGroups(registry, activeFilter);
      const visible = activeFilter === "all"
        ? registry.projects.length
        : registry.projects.filter((project) => project.group === activeFilter).length;
      result.textContent = `${visible} ${visible === 1 ? "project" : "projects"} shown`;
    });
    return button;
  });

  filters.replaceChildren(...buttons);
  result.textContent = `${registry.projects.length} projects shown`;
}

function renderGroups(registry, filter = "all") {
  const container = document.querySelector("#project-groups");
  const groups = registry.groups.filter((group) => filter === "all" || group.id === filter);
  const sections = groups.map((group) => {
    const projects = registry.projects.filter((project) => project.group === group.id);
    return createGroup(group, projects);
  });
  container.replaceChildren(...sections);
}

function renderPosts(posts) {
  document.querySelector("#posts-grid").replaceChildren(...posts.map(createPostCard));
}

function scrollToInitialHash() {
  if (!location.hash) return;
  const target = document.querySelector(location.hash);
  if (target) requestAnimationFrame(() => target.scrollIntoView());
}

async function loadRegistry() {
  const response = await fetch(registryUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Project registry returned ${response.status}`);
  const registry = await response.json();
  renderGroups(registry);
  renderPosts(registry.latestPosts);
  setupFilters(registry);
  scrollToInitialHash();
}

function showRegistryError(error) {
  const note = element("p", "error-note", "The project registry could not be loaded. Please refresh or try again shortly.");
  document.querySelector("#project-groups").replaceChildren(note);
  console.error(error);
}

function setupMapTooltips() {
  const visual = document.querySelector(".workbench-visual");
  const tooltip = document.querySelector("#map-tooltip");
  const links = document.querySelectorAll(".map-link");
  if (!visual || !tooltip || links.length === 0) return;

  function positionTooltip(link) {
    const visualRect = visual.getBoundingClientRect();
    const circleRect = link.querySelector(".node-disc").getBoundingClientRect();
    tooltip.style.left = `${circleRect.left - visualRect.left + circleRect.width / 2}px`;
    tooltip.style.top = `${Math.max(48, circleRect.top - visualRect.top - 10)}px`;
  }

  function showTooltip(link) {
    tooltip.textContent = link.dataset.tooltip;
    positionTooltip(link);
    tooltip.classList.add("is-visible");
  }

  function hideTooltip() {
    tooltip.classList.remove("is-visible");
  }

  links.forEach((link) => {
    link.addEventListener("pointerenter", () => showTooltip(link));
    link.addEventListener("pointermove", () => positionTooltip(link));
    link.addEventListener("pointerleave", hideTooltip);
    link.addEventListener("focus", () => showTooltip(link));
    link.addEventListener("blur", hideTooltip);
  });
}

setupMapTooltips();
loadRegistry().catch(showRegistryError);
