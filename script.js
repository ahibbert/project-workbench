const australianDataReviewRepo = "https://github.com/ahibbert/australian-data-review";
const australianDataReviewSite = "https://ahibbert.github.io/australian-data-review";

const projects = [
  {
    title: "gamlss.longitudinal",
    type: "Package",
    status: "Published",
    description:
      "An R package for fitting longitudinal GAMLSS models with flexible margins and copula dependence.",
    detail: {
      why: "For longitudinal analysis where changing scale, skewness, tails, quantiles, or within-subject dependence matter.",
      next: "Keep improving docs, examples, and practical workflow notes.",
      audience: "People fitting flexible repeated-measures models in R.",
    },
    links: [
      ["GitHub", "https://github.com/ahibbert/gamlss.longitudinal"],
      ["Docs", "https://ahibbert.github.io/gamlss.longitudinal/articles/site-guide.html"],
    ],
  },
  {
    title: "Copula based joint regression models for correlated data",
    type: "Paper",
    status: "Published",
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
      next: "Replace starter cards with real repo entries once the repo inventory is accessible here.",
      audience: "Curious readers who want concise analysis with caveats visible.",
    },
    links: [
      ["Section", "#data-questions"],
      ["Site", australianDataReviewSite],
      ["Repo", australianDataReviewRepo],
    ],
  },
  {
    title: "Research software notes",
    type: "Writing",
    status: "Idea",
    description:
      "Short notes about model diagnostics, package design, and making statistical workflows easier to inspect.",
    detail: {
      why: "Some ideas are too practical for papers and too useful to leave buried in code comments.",
      next: "Collect a few short notes before deciding whether they become posts, docs, or examples.",
      audience: "People building or using analysis software.",
    },
    links: [["Pipeline", "#pipeline"]],
  },
  {
    title: "Homelab experiments",
    type: "Fun",
    status: "Idea",
    description:
      "A small place for server experiments, dashboards, automation, and local tools that might become useful.",
    detail: {
      why: "A low-stakes sandbox for infrastructure, automation, and dashboards.",
      next: "Decide which experiments are worth documenting publicly.",
      audience: "Mostly me, plus anyone who enjoys useful personal infrastructure.",
    },
    links: [["Pipeline", "#pipeline"]],
  },
  {
    title: "Data review tooling",
    type: "Tool",
    status: "In progress",
    description:
      "Lightweight helpers for turning data questions into reproducible summaries, charts, and public draft pages.",
    detail: {
      why: "The Data Questions section needs repeatable structure as the number of drafts grows.",
      next: "Create a simple template for question, data source, chart, caveats, and status.",
      audience: "Future data-note authors, including future me.",
    },
    links: [["Data Questions", "#data-questions"]],
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
  {
    title: "Question-led data note template",
    type: "Template",
    status: "In progress",
    description:
      "A repeatable shape for turning a question, dataset, chart, interpretation, and caveats into a public note.",
    detail: {
      question: "What is the minimum structure that makes a draft useful without making it feel finished?",
      source: "The local Australian Data Review Quarto site.",
      next: "Use this as the authoring pattern for future entries.",
    },
    links: [
      ["Site", australianDataReviewSite],
      ["Repo", australianDataReviewRepo],
    ],
  },
];

const latestUpdates = [
  {
    date: "Today",
    title: "Added expandable project briefs",
    description:
      "Project and Data Questions cards now include short details about why the work exists, who it is for, and what comes next.",
  },
  {
    date: "Today",
    title: "Connected Australian Data Review posts",
    description:
      "Data Questions now features the real Australian Data Review posts from the local Quarto repo.",
  },
  {
    date: "Today",
    title: "Added a lightweight project pipeline",
    description:
      "Ideas, active work, published items, and paused threads can be tracked without turning the page into a formal roadmap.",
  },
];

const pipelineItems = [
  {
    title: "Import Australian Data Review entries",
    status: "Published",
    description: "Real post entries are now listed from the local Australian Data Review repo.",
  },
  {
    title: "Reusable data note template",
    status: "In progress",
    description: "Create a repeatable shape for question, chart, interpretation, and caveats.",
  },
  {
    title: "Expandable project briefs",
    status: "Published",
    description: "Each project card now has a compact details panel.",
  },
  {
    title: "Latest updates section",
    status: "Published",
    description: "The homepage now has a small changelog for recent movement.",
  },
  {
    title: "gamlss.longitudinal docs",
    status: "Published",
    description: "Package guide and workflow articles are available through the project docs.",
  },
  {
    title: "Longer research-software writing",
    status: "Paused",
    description: "Collect rough ideas before deciding whether they belong as posts, notes, or package docs.",
  },
];

const interests = [
  "Longitudinal models with flexible distributional shape",
  "Readable uncertainty and diagnostics",
  "Public data questions with clear caveats",
  "Small tools that make research workflows less brittle",
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

function renderUpdates() {
  const list = document.querySelector("#updates-list");
  list.replaceChildren(
    ...latestUpdates.map((item) => {
      const article = document.createElement("article");
      article.className = "update-item";

      const date = document.createElement("span");
      date.className = "update-date";
      date.textContent = item.date;

      const content = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = item.title;
      const description = document.createElement("p");
      description.textContent = item.description;
      content.append(title, description);

      article.append(date, content);
      return article;
    })
  );
}

function renderInterests() {
  const strip = document.querySelector("#interest-strip");
  strip.replaceChildren(
    ...interests.map((interest) => {
      const item = document.createElement("div");
      item.className = "interest-item";
      item.textContent = interest;
      return item;
    })
  );
}

function renderPipeline() {
  const statuses = ["Idea", "In progress", "Published", "Paused"];
  const board = document.querySelector("#pipeline-board");

  const columns = statuses.map((status) => {
    const items = pipelineItems.filter((item) => item.status === status);
    const column = document.createElement("section");
    column.className = "pipeline-column";
    column.setAttribute("aria-label", `${status} items`);

    const heading = document.createElement("h3");
    heading.textContent = status;

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(items.length);
    heading.append(count);
    column.append(heading);

    items.forEach((item) => {
      const card = document.createElement("article");
      card.className = "pipeline-item";
      const title = document.createElement("strong");
      title.textContent = item.title;
      const description = document.createElement("p");
      description.textContent = item.description;
      card.append(title, description);
      column.append(card);
    });

    return column;
  });

  board.replaceChildren(...columns);
}

function drawWorkbench() {
  const canvas = document.querySelector("#workbench-canvas");
  const ctx = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  ctx.scale(ratio, ratio);

  const width = rect.width;
  const height = rect.height;
  const nodes = [
    { x: width * 0.18, y: height * 0.28, r: 42, color: "#587366", label: "R" },
    { x: width * 0.55, y: height * 0.2, r: 56, color: "#2f5f91", label: "G" },
    { x: width * 0.75, y: height * 0.58, r: 48, color: "#b4473f", label: "D" },
    { x: width * 0.34, y: height * 0.72, r: 52, color: "#b7832f", label: "?" },
    { x: width * 0.52, y: height * 0.52, r: 34, color: "#64558a", label: "W" },
  ];

  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(32, 33, 36, 0.34)";
  ctx.setLineDash([8, 8]);
  ctx.beginPath();
  nodes.forEach((node, index) => {
    const next = nodes[(index + 1) % nodes.length];
    ctx.moveTo(node.x, node.y);
    ctx.lineTo(next.x, next.y);
  });
  ctx.stroke();
  ctx.setLineDash([]);

  nodes.forEach((node) => {
    ctx.beginPath();
    ctx.arc(node.x + 8, node.y + 10, node.r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(32, 33, 36, 0.12)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
    ctx.fillStyle = node.color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#202124";
    ctx.stroke();

    ctx.fillStyle = "#fffdf8";
    ctx.font = "800 24px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(node.label, node.x, node.y);
  });

  ctx.fillStyle = "rgba(32, 33, 36, 0.72)";
  ctx.font = "700 14px system-ui";
  ctx.textAlign = "left";
  ctx.fillText("loose map of useful work", 22, height - 24);
}

renderProjects();
renderUpdates();
renderInterests();
renderPipeline();
drawWorkbench();
window.addEventListener("resize", drawWorkbench);
