const australianDataReviewRepo = "https://github.com/ahibbert/australian-data-review";
const australianDataReviewSite = "http://datareview.aydins-workbench.com";
const blogSite = "https://blog.aydins-workbench.com";
const gamlssLongitudinalSite = "http://gamlsslongitudinal.aydins-workbench.com";
const gamlssPlaygroundSite = "https://gamlss.aydins-workbench.com";

const projects = [
  {
    title: "gamlss.longitudinal",
    type: "Package",
    status: "In progress",
    description:
      "An R package for fitting longitudinal GAMLSS models with flexible margins and copula dependence.",
    detail: {
      why: "For longitudinal analysis where changing scale, skewness, tails, quantiles, or within-subject dependence matter.",
      next: "Keep improving docs, examples, and practical workflow notes.",
      audience: "People fitting flexible repeated-measures models in R.",
    },
    links: [
      ["GitHub", "https://github.com/ahibbert/gamlss.longitudinal"],
      ["Docs", `${gamlssLongitudinalSite}/articles/site-guide.html`],
    ],
  },
  {
    title: "GAMLSS Playground",
    type: "Tool",
    status: "In progress",
    description:
      "A live R-backed tool for exploring exact GAMLSS distribution shapes with sliders, density/CDF/quantile views, and exportable grids.",
    detail: {
      why: "To make distributional-regression families easier to inspect without regenerating examples by hand.",
      next: "Keep broadening distribution coverage and polish traceable teaching/research workflows.",
      audience: "Researchers and students who already know enough statistics to care about distribution parameters.",
    },
    links: [
      ["Launch tool", gamlssPlaygroundSite],
      ["GitHub", "https://github.com/ahibbert/gamlss-playground"],
    ],
  },
  {
    title: "Copula-based joint regression models for correlated data",
    type: "Paper",
    status: "Under review",
    description:
      "A bivariate comparison of copula-based, mixed model, and estimating equation approaches for correlated regression.",
    detail: {
      why: "To compare what different correlated-data regression strategies can and cannot capture.",
      next: "Use it as the paper/code anchor for related modelling work.",
      audience: "Statistical modelling readers, collaborators, and anyone evaluating correlated-data methods.",
    },
    links: [
      ["arXiv", "https://arxiv.org/abs/2410.11892"],
      ["Code", "https://github.com/ahibbert/bivariate-copula-for-correlated-data"],
    ],
  },
  {
    title: "Data Questions",
    type: "Data notebook",
    status: "Draft",
    description:
      "Public drafts answering questions I am interested in with data, starting from Australian Data Review work.",
    detail: {
      why: "A public place to work through data questions without pretending every note is final.",
      next: "Keep turning Australian Data Review posts into readable public notes with caveats visible.",
      audience: "Curious readers who want concise analysis with caveats visible.",
    },
    links: [
      ["Section", "#data-questions"],
      ["Site", australianDataReviewSite],
      ["Repo", australianDataReviewRepo],
    ],
  },
  {
    title: "Blog",
    type: "Writing",
    status: "Draft",
    description:
      "A lightweight writing space for statistical modelling notes, research-software reflections, data questions, and project-adjacent thinking.",
    detail: {
      why: "Some thoughts need a public notebook before they are polished enough to become papers, package docs, or formal project pages.",
      next: "Write the first short opening note and start collecting recurring threads.",
      audience: "People following the workbench, collaborators, and future me.",
    },
    links: [
      ["Read", blogSite],
      ["GitHub", "https://github.com/ahibbert/blog"],
    ],
  },
  {
    title: "LLM statistician review bench",
    type: "Idea",
    status: "Idea",
    description:
      "An experiment comparing LLM-generated statistical or biostatistical reviews against paper reviews and expert expectations.",
    detail: {
      why: "LLMs are already being used around analysis, but we need sharper ways to test what they catch, miss, and overstate.",
      next: "Design a small benchmark using papers, reviews, and rubric-based scoring for statistical reasoning.",
      audience: "Data scientists, statisticians, reviewers, and anyone trying to use AI without outsourcing judgement.",
    },
    links: [["Project brief", "#projects"]],
  },
];

const dataQuestions = [
  {
    title: "Modelling NDIS Plan Budgets and Utilisation",
    type: "Analysis",
    status: "Draft",
    description:
      "A reproducible first pass at explaining NDIS average support budgets and plan utilisation using public NDIS and ABS regional data.",
    detail: {
      question: "What explains variation in average annualised NDIS support budgets and plan utilisation?",
      source: "Public NDIS datasets plus ABS regional context.",
      next: "Keep checking the modelling assumptions, caveats, and presentation before treating it as polished.",
    },
    links: [
      ["Post", `${australianDataReviewSite}/posts/ndis-budget-utilisation-prediction/`],
      ["Source", `${australianDataReviewRepo}/tree/main/posts/ndis-budget-utilisation-prediction`],
    ],
  },
  {
    title: "Australian Data Sources Worth Watching",
    type: "Reference",
    status: "Draft",
    description:
      "A curated starting list for Australian health and policy analysis, including source links and topic ideas.",
    detail: {
      question: "Which public Australian datasets are useful starting points for health and policy analysis?",
      source: "AIHW, ABS, NDIS, data.gov.au, Productivity Commission, and related public sources.",
      next: "Turn promising topic ideas into individual question-led posts.",
    },
    links: [
      ["Post", `${australianDataReviewSite}/posts/australian-data-sources/`],
      ["Source", `${australianDataReviewRepo}/tree/main/posts/australian-data-sources`],
    ],
  },
  {
    title: "Starting an Australian Data Blog",
    type: "Methods",
    status: "Draft",
    description:
      "A short editorial note describing the compact question, dataset, chart, caveat, and interpretation format.",
    detail: {
      question: "What shape should these public data notes take?",
      source: "Australian Data Notes editorial template.",
      next: "Use the format consistently as more posts are added.",
    },
    links: [
      ["Post", `${australianDataReviewSite}/posts/welcome/`],
      ["Source", `${australianDataReviewRepo}/tree/main/posts/welcome`],
    ],
  },
];

const statusClass = (status) => status.toLowerCase().replace(/\s+/g, "-");

function createLinks(links) {
  const wrapper = document.createElement("div");
  wrapper.className = "card-links";

  links.forEach(([label, href]) => {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = label;
    if (href.startsWith("http")) {
      link.rel = "noreferrer";
    }
    wrapper.append(link);
  });

  return wrapper;
}

function createDetails(detail) {
  const details = document.createElement("details");
  details.className = "project-details";

  const summary = document.createElement("summary");
  summary.textContent = "Project brief";
  details.append(summary);

  const grid = document.createElement("div");
  grid.className = "detail-grid";

  Object.entries(detail).forEach(([label, value]) => {
    const row = document.createElement("div");
    row.className = "detail-row";

    const key = document.createElement("strong");
    key.textContent = label;

    const text = document.createElement("span");
    text.textContent = value;

    row.append(key, text);
    grid.append(row);
  });

  details.append(grid);
  return details;
}

function createProjectCard(item, options = {}) {
  const card = document.createElement("article");
  card.className = "project-card";

  if (options.showDraftBanner) {
    const banner = document.createElement("strong");
    banner.className = "draft-banner";
    banner.textContent = item.status === "Published" ? "PUBLISHED" : "WORK IN PROGRESS / DRAFT";
    card.append(banner);
  }

  const top = document.createElement("div");
  top.className = "card-top";

  const title = document.createElement("h3");
  title.textContent = item.title;

  const type = document.createElement("span");
  type.className = "type-chip";
  type.textContent = item.type;

  top.append(title, type);

  const status = document.createElement("span");
  status.className = `status-chip ${statusClass(item.status)}`;
  status.textContent = item.status;

  const description = document.createElement("p");
  description.textContent = item.description;

  card.append(top, status, description);
  if (item.detail) {
    card.append(createDetails(item.detail));
  }
  card.append(createLinks(item.links));
  return card;
}

function renderProjects() {
  const projectGrid = document.querySelector("#project-grid");
  const dataGrid = document.querySelector("#data-grid");
  projectGrid.replaceChildren(...projects.map((item) => createProjectCard(item)));
  dataGrid.replaceChildren(
    ...dataQuestions.map((item) => createProjectCard(item, { showDraftBanner: true }))
  );
}

function setupMapTooltips() {
  const visual = document.querySelector(".workbench-visual");
  const tooltip = document.querySelector("#map-tooltip");
  const links = document.querySelectorAll(".map-link");

  if (!visual || !tooltip || links.length === 0) {
    return;
  }

  function positionTooltip(link) {
    const visualRect = visual.getBoundingClientRect();
    const circleRect = link.querySelector(".node-disc").getBoundingClientRect();
    const left = circleRect.left - visualRect.left + circleRect.width / 2;
    const top = circleRect.top - visualRect.top - 10;

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(48, top)}px`;
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

renderProjects();
setupMapTooltips();
