const registryUrl = "projects.json";

const groupColours = {
  research: "#2f5f91",
  apps: "#b4473f",
  blogs: "#587366"
};

const projectVisuals = {
  "little-now": {
    icon: "assets/projects/little-now/icon.webp",
    accent: "#e97962",
    media: [
      ["assets/projects/little-now/screen-01.webp", "Little Now recommendation screen in its App Store presentation", "App Store capture · recommendation"],
      ["assets/projects/little-now/screen-02.webp", "Little Now activity details screen in its App Store presentation", "App Store capture · activity details"]
    ]
  },
  panels: { icon: "assets/projects/panels/icon.webp", accent: "#4b5965" },
  margin: {
    icon: "assets/projects/margin/icon.webp",
    accent: "#567563",
    media: [["assets/projects/margin/brand-preview.webp", "Margin research discovery brand preview", "Current brand preview"]]
  },
  "panel-pilot": { icon: "assets/projects/panel-pilot/icon.webp", accent: "#2a62a2" },
  "household-cash": {
    icon: "assets/projects/household-cash/icon.webp",
    accent: "#1d7355",
    media: [["assets/projects/household-cash/brand-preview.webp", "Household Cash current visual identity", "Current brand preview"]]
  },
  "starfall-company": {
    icon: "assets/projects/starfall-company/icon.webp",
    accent: "#bb7d27",
    media: [
      ["assets/projects/starfall-company/gameplay-concept.webp", "Starfall Company tactical encounter concept", "Gameplay direction · Heart of Glass"],
      ["assets/projects/starfall-company/colony-concept.webp", "Starfall Company colony building concept", "Gameplay direction · Ilex colony"]
    ]
  },
  "gamlss-longitudinal": {
    icon: "assets/projects/gamlss-longitudinal/r-output.webp",
    accent: "#3970a8",
    media: [["assets/projects/gamlss-longitudinal/optimizer-benchmark.webp", "Optimizer benchmark output from gamlss.longitudinal", "Research output · optimiser benchmark"]]
  },
  "distribution-playground": {
    icon: "assets/projects/distribution-playground/live-plot.webp",
    accent: "#285f91",
    media: [["assets/projects/distribution-playground/live-plot-detail.webp", "Live density plot from Distribution Playground", "Live tool output · density explorer"]]
  },
  "copula-paper": {
    icon: "assets/projects/copula-paper/paper-page.webp",
    accent: "#547a9b",
    media: [["assets/projects/copula-paper/paper-page-detail.webp", "Title page of the copula-based correlated regression preprint", "Preprint · title page"]]
  },
  "gamlss-longitudinal-paper": {
    icon: "assets/projects/gamlss-longitudinal-paper/manuscript-output.webp",
    accent: "#64558a",
    media: [
      ["assets/projects/gamlss-longitudinal-paper/manuscript-output-detail.webp", "Treatment-effect table prepared for the longitudinal GAMLSS manuscript", "Manuscript output · treatment effects"],
      ["assets/projects/gamlss-longitudinal/optimizer-benchmark.webp", "Optimizer benchmark supporting the longitudinal GAMLSS manuscript", "Manuscript output · optimiser benchmark"]
    ]
  },
  "workbench-blog": {
    icon: "assets/projects/workbench-blog/chart-collage.webp",
    accent: "#547766",
    media: [["assets/projects/workbench-blog/chart-collage-detail.webp", "Charts from Aydin's Workbench data notes", "Published work · selected charts"]]
  },
  "housing-note": {
    icon: "assets/projects/housing-note/chart.webp",
    accent: "#a96547",
    media: [["assets/projects/housing-note/chart-detail.webp", "Mean dwelling price chart from the Australian housing data note", "Published chart · dwelling prices"]]
  },
  "ndis-note": {
    icon: "assets/projects/ndis-note/chart.webp",
    accent: "#4b7d74",
    media: [["assets/projects/ndis-note/chart-detail.webp", "NDIS outcome scores and payments per participant chart", "Published chart · participant outcomes"]]
  },
  "bulk-billing-note": {
    icon: "assets/projects/bulk-billing-note/chart.webp",
    accent: "#8f554f",
    media: [["assets/projects/bulk-billing-note/chart-detail.webp", "National bulk-billing rate time-series chart", "Published chart · bulk-billing rate"]]
  }
};

let registry;
let selectedProjectId = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function enrichedProject(project) {
  const visual = projectVisuals[project.id] ?? {};
  return { ...project, ...visual };
}

function projectById(id) {
  return registry.projects.find((project) => project.id === id);
}

function createThumbnail(project) {
  const frame = element("span", "project-thumbnail");
  frame.style.setProperty("--accent", project.accent);
  const image = element("img");
  image.src = project.icon;
  image.alt = "";
  image.loading = "lazy";
  frame.append(image);
  return frame;
}

function createProjectButton(project, index) {
  const button = element("button", `project-object${selectedProjectId === project.id ? " is-selected" : ""}`);
  button.type = "button";
  button.dataset.projectId = project.id;
  button.setAttribute("aria-expanded", String(selectedProjectId === project.id));
  button.setAttribute("aria-label", `${selectedProjectId === project.id ? "Close" : "Open"} ${project.title}`);
  button.style.setProperty("--tilt", `${[-0.8, 0.55, -0.35, 0.7, -0.5, 0.3][index % 6]}deg`);

  const copy = element("span", "project-object-copy");
  copy.append(element("strong", "", project.title), element("small", "", project.status));
  button.append(createThumbnail(project), copy);
  button.addEventListener("click", () => selectProject(project.id));
  return button;
}

function createMedia(project) {
  if (!project.media?.length) return null;
  const media = element("section", "project-media");
  media.setAttribute("aria-label", `${project.title} visuals`);
  media.append(element("strong", "project-media-heading", project.media.length === 1 ? "Project visual" : "Project visuals"));
  const grid = element("div", `project-media-grid${project.media.length === 1 ? " project-media-grid-single" : ""}`);
  project.media.forEach(([src, alt, label]) => {
    const figure = element("figure", "project-media-item");
    const image = element("img");
    image.src = src;
    image.alt = alt;
    image.loading = "lazy";
    figure.append(image, element("figcaption", "", label));
    grid.append(figure);
  });
  media.append(grid);
  return media;
}

function createProjectSheet(project) {
  const sheet = element("article", "project-sheet");
  const titleId = `project-sheet-${project.id}`;
  sheet.setAttribute("aria-labelledby", titleId);
  sheet.style.setProperty("--accent", project.accent);

  const header = element("div", "sheet-header");
  header.append(element("span", "sheet-group", registry.groups.find((group) => group.id === project.group).label));
  const close = element("button", "sheet-close", "Close");
  close.type = "button";
  close.addEventListener("click", () => selectProject(project.id));
  header.append(close);

  const title = element("h3", "", project.title);
  title.id = titleId;
  const meta = element("div", "sheet-meta");
  meta.append(element("span", "", project.status), element("span", "", project.access), element("span", "", project.type));
  sheet.append(header, title, meta, element("p", "sheet-description", project.description));

  if (project.details && Object.keys(project.details).length) {
    const details = element("div", "sheet-details");
    Object.entries(project.details).forEach(([label, value]) => {
      const row = element("div", "");
      row.append(element("strong", "", label), element("p", "", value));
      details.append(row);
    });
    sheet.append(details);
  }

  const links = element("div", "sheet-links");
  if (project.links.length) {
    project.links.forEach(({ label, href }) => {
      const link = element("a", "", label);
      link.href = href;
      link.rel = "noreferrer";
      links.append(link);
    });
  } else {
    links.append(element("span", "", "No public link yet"));
  }
  sheet.append(links);

  const media = createMedia(project);
  if (media) sheet.append(media);
  return sheet;
}

function renderWorkbench() {
  const container = document.querySelector("#project-groups");
  const zones = registry.groups.map((group) => {
    const groupProjects = registry.projects.filter((project) => project.group === group.id).map(enrichedProject);
    const selected = groupProjects.find((project) => project.id === selectedProjectId);
    const isCompact = Boolean(selected && matchMedia("(max-width: 680px)").matches);
    const ordered = selected ? [selected, ...groupProjects.filter((project) => project.id !== selected.id)] : groupProjects;

    const zone = element("section", "project-zone");
    zone.id = group.id;
    zone.style.setProperty("--group-color", groupColours[group.id]);
    zone.setAttribute("aria-labelledby", `${group.id}-title`);

    const heading = element("div", "zone-heading");
    const title = element("h2", "", group.label);
    title.id = `${group.id}-title`;
    heading.append(title, element("p", "", group.description));

    const content = element("div", `zone-content${selected ? " has-sheet" : ""}`);
    const objects = element("div", "project-objects");
    ordered.forEach((project, index) => {
      const unit = element("div", "project-unit");
      unit.append(createProjectButton(project, index));
      if (isCompact && selected?.id === project.id) unit.append(createProjectSheet(project));
      objects.append(unit);
    });
    content.append(objects);
    if (selected && !isCompact) content.append(createProjectSheet(selected));
    zone.append(heading, content);
    return zone;
  });
  container.replaceChildren(...zones);
}

function selectProject(id) {
  selectedProjectId = selectedProjectId === id ? null : id;
  renderWorkbench();
  if (selectedProjectId) {
    document.querySelector(".project-sheet")?.scrollIntoView({ block: matchMedia("(max-width: 680px)").matches ? "start" : "nearest", behavior: "smooth" });
  }
}

function renderPosts(posts) {
  const cards = posts.map((post) => {
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
  });
  document.querySelector("#posts-grid").replaceChildren(...cards);
}

async function loadRegistry() {
  const response = await fetch(registryUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Project registry returned ${response.status}`);
  registry = await response.json();
  renderWorkbench();
  renderPosts(registry.latestPosts);
  if (location.hash) requestAnimationFrame(() => document.querySelector(location.hash)?.scrollIntoView());
}

function showRegistryError(error) {
  document.querySelector("#project-groups").replaceChildren(element("p", "error-note", "The project registry could not be loaded. Please refresh or try again shortly."));
  console.error(error);
}

const compactQuery = matchMedia("(max-width: 680px)");
compactQuery.addEventListener("change", () => {
  if (registry && selectedProjectId) renderWorkbench();
});

loadRegistry().catch(showRegistryError);
