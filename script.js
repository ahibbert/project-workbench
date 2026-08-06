const blogSite = "https://blog.aydins-workbench.com";
const gamlssLongitudinalSite = "https://gamlsslongitudinal.aydins-workbench.com";
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
    title: "Distribution Playground",
    type: "Tool",
    status: "In progress",
    description:
      "A shared R-backed home for GAMLSS distribution shapes, copula dependence, and quantile comparison tools.",
    detail: {
      why: "To make distributional-regression ideas easier to inspect without regenerating examples by hand.",
      next: "Review the hosted GAMLSS, Copula, and Quantiles sub-tools, then deepen the examples and exports.",
      audience: "Researchers, students, and applied collaborators who need distribution shape and dependence to be visible.",
    },
    links: [
      ["Launch playground", gamlssPlaygroundSite],
      ["GAMLSS", `${gamlssPlaygroundSite}/gamlss/`],
      ["Copula", `${gamlssPlaygroundSite}/copula/`],
      ["Quantiles", `${gamlssPlaygroundSite}/quantile/`],
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

const latestPosts = [
  {
    title: "A First Pass At Australian Dwelling Prices",
    type: "Blog post",
    status: "Draft",
    description:
      "A small reproducible look at ABS dwelling values, state mean prices, and the housing policy questions they raise.",
    detail: {
      date: "11 June 2026",
      theme: "Housing, cost of living, ABS data",
      note: "A compact data question with caveats kept visible.",
    },
    links: [
      ["Post", `${blogSite}/posts/housing-prices-first-pass/`],
      ["More posts", `${blogSite}#posts`],
    ],
  },
  {
    title: "Are NDIS Participant Outcomes Changing?",
    type: "Blog post",
    status: "Draft",
    description:
      "A simpler look at national NDIS participant outcome levels and changes after plan reassessment.",
    detail: {
      date: "10 June 2026",
      theme: "NDIS outcomes, disability, Australia",
      note: "Descriptive movement is kept separate from causal interpretation.",
    },
    links: [
      ["Post", `${blogSite}/posts/ndis-outcomes-spend-service-access/`],
      ["More posts", `${blogSite}#posts`],
    ],
  },
  {
    title: "Did Bulk Billing Changes Shift Access?",
    type: "Blog post",
    status: "Draft",
    description:
      "An early reproducible look at whether expanded GP bulk billing incentives changed access patterns by age, socioeconomic area, geography, and PHN.",
    detail: {
      date: "28 May 2026",
      theme: "Medicare, bulk billing, health policy",
      note: "An early look at policy signal, timing artefact, and reporting noise.",
    },
    links: [
      ["Post", `${blogSite}/posts/bulk-billing-changes-impact/`],
      ["More posts", `${blogSite}#posts`],
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

function createDetails(detail, summaryLabel = "Project brief") {
  const details = document.createElement("details");
  details.className = "project-details";

  const summary = document.createElement("summary");
  summary.textContent = summaryLabel;
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
    card.append(createDetails(item.detail, options.summaryLabel));
  }
  card.append(createLinks(item.links));
  return card;
}

function renderProjects() {
  const projectGrid = document.querySelector("#project-grid");
  const postsGrid = document.querySelector("#posts-grid");
  projectGrid.replaceChildren(...projects.map((item) => createProjectCard(item)));
  postsGrid.replaceChildren(
    ...latestPosts.map((item) => createProjectCard(item, { summaryLabel: "Post details" }))
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
