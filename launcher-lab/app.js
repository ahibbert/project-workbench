const { groups, concepts, projects } = window.launcherData;
const groupLookup = Object.fromEntries(groups.map((group) => [group.id, group]));

const detailModes = [
  {
    id: "side",
    label: "Side inspector",
    description: "Persistent context: the project stays beside the launcher while you browse."
  },
  {
    id: "dialog",
    label: "Desk dossier",
    description: "Focused context: the project opens as a centred paper dossier over the workbench."
  },
  {
    id: "inline",
    label: "Inline sheet",
    description: "Continuous context: details unfold below the launcher without covering anything."
  }
];

const initialUrl = new URL(location.href);
const requestedConcept = initialUrl.searchParams.get("concept");
const requestedDetail = initialUrl.searchParams.get("detail");
const state = {
  concept: concepts.some((concept) => concept.id === requestedConcept) ? requestedConcept : concepts[0].id,
  group: "all",
  selected: "little-now",
  detail: detailModes.some((mode) => mode.id === requestedDetail) ? requestedDetail : "side"
};

const artifactShapes = {
  phone: '<span class="phone-shell"><i></i><b>One idea</b><em></em><em></em></span>',
  reader: '<span class="reader-shell"><i></i><b></b><b></b><b></b></span>',
  feed: '<span class="feed-shell"><i></i><b></b><b></b><b></b></span>',
  comic: '<span class="comic-shell"><i></i><i></i><i></i><i></i></span>',
  cash: '<span class="cash-shell"><i>$</i><b></b><b></b><b></b></span>',
  game: '<span class="game-shell"><i>✦</i><i>◆</i><i>●</i><b></b></span>',
  trajectories: '<span class="chart-shell"><i></i><i></i><i></i><b></b></span>',
  distribution: '<span class="curve-shell"><i></i><b></b></span>',
  paper: '<span class="paper-shell"><b></b><i></i><i></i><i></i></span>',
  benchmark: '<span class="benchmark-shell"><i>A</i><b>↔</b><i>B</i><em></em></span>',
  blog: '<span class="blog-shell"><b>NOTES</b><i></i><i></i><i></i></span>',
  housing: '<span class="bars-shell"><i></i><i></i><i></i><i></i><b>⌂</b></span>',
  outcomes: '<span class="dots-shell"><i></i><i></i><i></i><i></i><b></b></span>',
  health: '<span class="health-shell"><b>+</b><i></i><i></i><i></i></span>'
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function visibleProjects() {
  return state.group === "all" ? projects : projects.filter((project) => project.group === state.group);
}

function projectById(id) {
  return projects.find((project) => project.id === id);
}

function ensureVisibleSelection() {
  if (!visibleProjects().some((project) => project.id === state.selected)) {
    state.selected = visibleProjects()[0]?.id ?? projects[0].id;
  }
}

function createArtifact(project, size = "medium") {
  const artifact = el("div", `artifact artifact-${project.visual} artifact-${size}`);
  artifact.style.setProperty("--accent", project.accent);
  artifact.setAttribute("aria-hidden", "true");
  artifact.innerHTML = artifactShapes[project.visual] ?? artifactShapes.blog;
  return artifact;
}

function createProjectControl(project, className, options = {}) {
  const button = el("button", `${className}${state.selected === project.id ? " is-selected" : ""}`);
  button.type = "button";
  button.dataset.projectId = project.id;
  button.setAttribute("aria-label", `Inspect ${project.title}`);
  if (options.artifact !== false) button.append(createArtifact(project, options.artifactSize ?? "small"));

  const copy = el("span", "project-control-copy");
  copy.append(el("strong", "", project.title));
  if (options.meta !== false) copy.append(el("small", "", options.metaText ?? project.status));
  button.append(copy);
  button.addEventListener("click", () => selectProject(project.id));
  return button;
}

function selectProject(id) {
  state.selected = id;
  renderStage();
  renderInspector({ openDialog: state.detail === "dialog" });
  if (state.detail === "inline") {
    document.querySelector("#inline-inspector").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function renderTaxonomy() {
  const grid = document.querySelector("#taxonomy-grid");
  const cards = groups.map((group) => {
    const card = el("article", `taxonomy-card taxonomy-${group.id}`);
    card.style.setProperty("--group-color", group.color);
    const count = projects.filter((project) => project.group === group.id).length;
    card.append(
      el("span", "taxonomy-count", `${count} entries`),
      el("h3", "", group.label),
      el("p", "", group.description)
    );
    return card;
  });
  grid.replaceChildren(...cards);
}

function renderConceptTabs() {
  const tablist = document.querySelector("#concept-tabs");
  const buttons = concepts.map((concept) => {
    const button = el("button", "concept-tab");
    button.type = "button";
    button.setAttribute("role", "tab");
    button.dataset.concept = concept.id;
    button.setAttribute("aria-selected", String(concept.id === state.concept));
    button.append(el("span", "", concept.number), el("strong", "", concept.label));
    button.addEventListener("click", () => {
      state.concept = concept.id;
      const url = new URL(location.href);
      url.searchParams.set("concept", concept.id);
      history.replaceState(null, "", url);
      renderConceptTabs();
      renderConceptSummary();
      renderStage();
      document.querySelector("#concept-stage").focus({ preventScroll: true });
    });
    return button;
  });
  tablist.replaceChildren(...buttons);
}

function renderConceptSummary() {
  const concept = concepts.find((item) => item.id === state.concept);
  document.querySelector("#concept-number").textContent = concept.number;
  document.querySelector("#concept-name").textContent = concept.label;
  document.querySelector("#concept-summary").textContent = concept.summary;
  document.querySelector("#concept-strength").textContent = concept.strength;
  document.querySelector("#concept-risk").textContent = concept.risk;
}

function renderFilters() {
  const wrapper = document.querySelector("#group-filters");
  const options = [{ id: "all", label: "Everything" }, ...groups];
  const buttons = options.map((option) => {
    const button = el("button", "group-filter", option.label);
    button.type = "button";
    button.dataset.group = option.id;
    button.setAttribute("aria-pressed", String(option.id === state.group));
    button.addEventListener("click", () => {
      state.group = option.id;
      ensureVisibleSelection();
      renderFilters();
      renderStage();
      renderInspector();
    });
    return button;
  });
  wrapper.replaceChildren(...buttons);
  const count = visibleProjects().length;
  document.querySelector("#project-count").textContent = `${count} ${count === 1 ? "entry" : "entries"}`;
}

function renderDetailModes() {
  const wrapper = document.querySelector("#detail-modes");
  const buttons = detailModes.map((mode) => {
    const button = el("button", "detail-mode", mode.label);
    button.type = "button";
    button.dataset.detail = mode.id;
    button.setAttribute("aria-pressed", String(mode.id === state.detail));
    button.addEventListener("click", () => {
      state.detail = mode.id;
      const url = new URL(location.href);
      url.searchParams.set("detail", mode.id);
      history.replaceState(null, "", url);
      renderDetailModes();
      renderInspector();
    });
    return button;
  });
  wrapper.replaceChildren(...buttons);
  document.querySelector("#detail-description").textContent = detailModes.find((mode) => mode.id === state.detail).description;
}

function createStageHeader(label, note) {
  const header = el("div", "stage-label");
  header.append(el("strong", "", label), el("span", "", note));
  return header;
}

function createConnectionSvg(items, positions, className = "connection-layer") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const visibleIds = new Set(items.map((item) => item.id));
  const seen = new Set();
  items.forEach((project) => {
    project.related.forEach((relatedId) => {
      const key = [project.id, relatedId].sort().join("|");
      if (seen.has(key) || !visibleIds.has(relatedId) || !positions[project.id] || !positions[relatedId]) return;
      seen.add(key);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", positions[project.id][0]);
      line.setAttribute("y1", positions[project.id][1]);
      line.setAttribute("x2", positions[relatedId][0]);
      line.setAttribute("y2", positions[relatedId][1]);
      line.dataset.connection = key;
      if (project.id === state.selected || relatedId === state.selected) line.classList.add("is-active");
      svg.append(line);
    });
  });
  return svg;
}

const mapPositions = {
  "little-now": [15, 20], "panels": [33, 13], "margin": [50, 23],
  "panel-pilot": [14, 45], "household-cash": [34, 43], "starfall-company": [52, 50],
  "gamlss-longitudinal": [70, 16], "distribution-playground": [87, 25],
  "copula-paper": [70, 45], "llm-review-bench": [88, 50],
  "workbench-blog": [20, 73], "housing-note": [43, 80],
  "ndis-note": [65, 75], "bulk-billing-note": [84, 82]
};

function renderMapDrawer(items) {
  const stage = el("div", "map-concept");
  stage.append(createStageHeader("Navigable work map", "Select a marker; details stay in the drawer."));
  const canvas = el("div", "map-canvas");
  canvas.append(createConnectionSvg(items, mapPositions));

  groups.forEach((group) => {
    const zone = el("div", `map-zone map-zone-${group.id}`);
    zone.style.setProperty("--group-color", group.color);
    zone.append(el("strong", "", group.label), el("span", "", group.description));
    canvas.append(zone);
  });

  items.forEach((project) => {
    const control = createProjectControl(project, "map-pin", { meta: false, artifactSize: "tiny" });
    const [x, y] = mapPositions[project.id];
    control.style.setProperty("--x", `${x}%`);
    control.style.setProperty("--y", `${y}%`);
    if (project.related.includes(state.selected) || projectById(state.selected)?.related.includes(project.id)) {
      control.classList.add("is-related");
    }
    canvas.append(control);
  });
  stage.append(canvas);
  return stage;
}

function renderWorkbenchDesk(items) {
  const stage = el("div", "desk-concept");
  stage.append(createStageHeader("Open workbench", "Projects feel like objects being actively handled."));
  const board = el("div", "desk-board");

  groups.forEach((group) => {
    const groupItems = items.filter((project) => project.group === group.id);
    if (!groupItems.length) return;
    const zone = el("section", `desk-zone desk-zone-${group.id}`);
    zone.style.setProperty("--group-color", group.color);
    zone.append(el("h3", "", group.label));
    const objects = el("div", "desk-objects");
    groupItems.forEach((project, index) => {
      const object = createProjectControl(project, `desk-object desk-object-${project.visual}`, { artifactSize: "medium" });
      object.style.setProperty("--tilt", `${[-2.5, 1.5, -1, 2.25, -1.75, 0.75][index % 6]}deg`);
      objects.append(object);
    });
    zone.append(objects);
    board.append(zone);
  });
  stage.append(board);
  return stage;
}

function renderStudioShelves(items) {
  const stage = el("div", "shelves-concept");
  stage.append(createStageHeader("Studio shelves", "Scan by category, then pull a project forward."));
  const shelves = el("div", "shelves");
  groups.forEach((group) => {
    const groupItems = items.filter((project) => project.group === group.id);
    if (!groupItems.length) return;
    const shelf = el("section", "shelf");
    shelf.style.setProperty("--group-color", group.color);
    const heading = el("div", "shelf-heading");
    heading.append(el("h3", "", group.label), el("span", "", `${groupItems.length} on this shelf`));
    const row = el("div", "shelf-row");
    groupItems.forEach((project) => {
      row.append(createProjectControl(project, "shelf-project", { artifactSize: "medium", metaText: project.type }));
    });
    shelf.append(heading, row);
    shelves.append(shelf);
  });
  stage.append(shelves);
  return stage;
}

const constellationPositions = {
  "little-now": [10, 17], "panels": [25, 10], "margin": [38, 26],
  "panel-pilot": [18, 39], "household-cash": [7, 55], "starfall-company": [34, 55],
  "gamlss-longitudinal": [58, 13], "distribution-playground": [76, 21],
  "copula-paper": [67, 40], "llm-review-bench": [88, 47],
  "workbench-blog": [47, 68], "housing-note": [60, 82],
  "ndis-note": [77, 72], "bulk-billing-note": [91, 88]
};

function renderConstellation(items) {
  const stage = el("div", "constellation-concept");
  stage.append(createStageHeader("Connected project system", "Choose a node to illuminate its closest neighbours."));
  const sky = el("div", "constellation-sky");
  sky.append(createConnectionSvg(items, constellationPositions, "constellation-lines"));

  items.forEach((project) => {
    const control = createProjectControl(project, "constellation-node", { artifactSize: "tiny", meta: false });
    const [x, y] = constellationPositions[project.id];
    control.style.setProperty("--x", `${x}%`);
    control.style.setProperty("--y", `${y}%`);
    control.style.setProperty("--node-color", groupLookup[project.group].color);
    if (project.related.includes(state.selected) || projectById(state.selected)?.related.includes(project.id)) {
      control.classList.add("is-related");
    }
    sky.append(control);
  });

  const legend = el("div", "constellation-legend");
  groups.forEach((group) => {
    const item = el("span", "", group.label);
    item.style.setProperty("--group-color", group.color);
    legend.append(item);
  });
  sky.append(legend);
  stage.append(sky);
  return stage;
}

function renderProductGallery(items) {
  const stage = el("div", "gallery-concept");
  stage.append(createStageHeader("Editorial project gallery", "Scroll through large, visual project stories."));
  const gallery = el("div", "product-gallery");
  items.forEach((project, index) => {
    const card = el("article", `gallery-project${state.selected === project.id ? " is-selected" : ""}`);
    card.style.setProperty("--accent", project.accent);
    if (index % 2) card.classList.add("gallery-project-reverse");
    const visual = el("div", "gallery-visual");
    visual.append(createArtifact(project, "large"));
    const copy = el("div", "gallery-copy");
    copy.append(
      el("span", "gallery-kicker", `${groupLookup[project.group].label} · ${project.status}`),
      el("h3", "", project.title),
      el("p", "", project.description)
    );
    const button = el("button", "gallery-inspect", "Inspect project");
    button.type = "button";
    button.dataset.projectId = project.id;
    button.addEventListener("click", () => selectProject(project.id));
    copy.append(button);
    card.append(visual, copy);
    gallery.append(card);
  });
  stage.append(gallery);
  return stage;
}

function renderWorkbenchGallery(items) {
  const stage = el("div", "workbench-gallery-concept");
  stage.append(createStageHeader("Curated workbench", "Editorial clarity, tactile materials and no sideways scrolling."));
  const surface = el("div", "workbench-gallery");

  groups.forEach((group) => {
    const groupItems = items.filter((project) => project.group === group.id);
    if (!groupItems.length) return;
    const section = el("section", "workbench-gallery-group");
    section.style.setProperty("--group-color", group.color);
    const heading = el("div", "workbench-gallery-heading");
    heading.append(el("h3", "", group.label), el("span", "", group.description));
    const grid = el("div", "workbench-gallery-grid");

    groupItems.forEach((project, index) => {
      const button = el("button", `workbench-gallery-card${state.selected === project.id ? " is-selected" : ""}`);
      button.type = "button";
      button.dataset.projectId = project.id;
      button.style.setProperty("--accent", project.accent);
      button.style.setProperty("--tilt", `${[-0.45, 0.35, -0.2, 0.5][index % 4]}deg`);
      const visual = el("span", "workbench-gallery-visual");
      visual.append(createArtifact(project, "medium"));
      const copy = el("span", "workbench-gallery-copy");
      copy.append(
        el("small", "", `${project.status} · ${project.type}`),
        el("strong", "", project.title),
        el("span", "", project.description)
      );
      button.append(visual, copy);
      button.addEventListener("click", () => selectProject(project.id));
      grid.append(button);
    });
    section.append(heading, grid);
    surface.append(section);
  });
  stage.append(surface);
  return stage;
}

function renderProjectFolios(items) {
  const stage = el("div", "folios-concept");
  stage.append(createStageHeader("Project folios", "A tidy index of folders that opens into the chosen detail treatment."));
  const stack = el("div", "folio-stack");

  groups.forEach((group) => {
    const groupItems = items.filter((project) => project.group === group.id);
    if (!groupItems.length) return;
    const section = el("section", "folio-group");
    section.style.setProperty("--group-color", group.color);
    const heading = el("div", "folio-group-heading");
    heading.append(el("h3", "", group.label), el("span", "", `${groupItems.length} ${groupItems.length === 1 ? "folio" : "folios"}`));
    const rows = el("div", "folio-rows");

    groupItems.forEach((project, index) => {
      const button = el("button", `folio-row${state.selected === project.id ? " is-selected" : ""}`);
      button.type = "button";
      button.dataset.projectId = project.id;
      button.style.setProperty("--accent", project.accent);
      button.append(el("span", "folio-number", String(index + 1).padStart(2, "0")), createArtifact(project, "small"));
      const identity = el("span", "folio-identity");
      identity.append(el("strong", "", project.title), el("small", "", project.type));
      const summary = el("span", "folio-summary", project.description);
      const stateLabel = el("span", "folio-state");
      stateLabel.append(el("strong", "", project.status), el("small", "", project.access));
      button.append(identity, summary, stateLabel, el("span", "folio-arrow", "Open"));
      button.addEventListener("click", () => selectProject(project.id));
      rows.append(button);
    });
    section.append(heading, rows);
    stack.append(section);
  });
  stage.append(stack);
  return stage;
}

function renderStage() {
  ensureVisibleSelection();
  const items = visibleProjects();
  const renderers = {
    "map-drawer": renderMapDrawer,
    "workbench-desk": renderWorkbenchDesk,
    "studio-shelves": renderStudioShelves,
    constellation: renderConstellation,
    "product-gallery": renderProductGallery,
    "workbench-gallery": renderWorkbenchGallery,
    "project-folios": renderProjectFolios
  };
  const stage = document.querySelector("#concept-stage");
  const content = renderers[state.concept](items);
  stage.dataset.concept = state.concept;
  stage.replaceChildren(content);
}

function createInspectorFragment(project, titleId) {
  const fragment = document.createDocumentFragment();
  const visual = el("div", "inspector-visual");
  visual.append(createArtifact(project, "large"));

  const group = el("span", "inspector-group", groupLookup[project.group].label);
  const title = el("h2", "", project.title);
  title.id = titleId;
  const meta = el("div", "inspector-meta");
  meta.append(el("span", "", project.status), el("span", "", project.access), el("span", "", project.type));

  const description = el("p", "inspector-description", project.description);
  const focus = el("div", "inspector-focus");
  focus.append(el("strong", "", "Current focus"), el("p", "", project.focus));

  const links = el("div", "inspector-links");
  if (project.links.length) {
    project.links.forEach(({ label, href }) => {
      const link = el("a", "", label);
      link.href = href;
      link.rel = "noreferrer";
      links.append(link);
    });
  } else {
    links.append(el("span", "", "No public link yet"));
  }

  fragment.append(visual, group, title, meta, description, focus, links);
  return fragment;
}

function renderInspector({ openDialog = false } = {}) {
  const project = projectById(state.selected);
  const side = document.querySelector("#project-inspector");
  const inline = document.querySelector("#inline-inspector");
  const dialog = document.querySelector("#project-dialog");
  const dialogContent = document.querySelector("#dialog-inspector");

  document.body.dataset.detail = state.detail;
  [side, inline, dialog].forEach((surface) => surface.style.setProperty("--accent", project.accent));

  if (state.detail !== "dialog" && dialog.open) dialog.close();
  side.hidden = state.detail !== "side";
  inline.hidden = state.detail !== "inline";
  side.replaceChildren();
  inline.replaceChildren();
  dialogContent.replaceChildren();

  if (state.detail === "side") {
    side.append(createInspectorFragment(project, "inspector-title"));
  } else if (state.detail === "inline") {
    inline.append(createInspectorFragment(project, "inline-inspector-title"));
  } else {
    dialogContent.append(createInspectorFragment(project, "dialog-inspector-title"));
    if (openDialog && !dialog.open) dialog.showModal();
  }
}

const dialog = document.querySelector("#project-dialog");
document.querySelector("#dialog-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});

renderTaxonomy();
renderConceptTabs();
renderConceptSummary();
renderFilters();
renderDetailModes();
renderStage();
renderInspector();
