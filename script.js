const australianDataReviewRepo = "https://github.com/ahibbert/australian-data-review";
const australianDataReviewSite = "https://ahibbert.github.io/australian-data-review";

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
      ["Docs", "https://ahibbert.github.io/gamlss.longitudinal/articles/site-guide.html"],
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
    title: "Released the detailed gamlss.longitudinal workflow",
    description:
      "A detailed worked example is now available on the gamlss.longitudinal GitHub Pages site.",
    links: [["Read the workflow", "https://ahibbert.github.io/gamlss.longitudinal/articles/native-simulation-workflow.html"]],
  },
  {
    date: "Today",
    title: "Connected Australian Data Review posts",
    description:
      "Data Questions now features the real Australian Data Review posts from the local Quarto repo.",
    links: [["Browse Data Questions", "#data-questions"]],
  },
  {
    date: "Today",
    title: "Added expandable project briefs",
    description:
      "Project and Data Questions cards now include short details about why the work exists, who it is for, and what comes next.",
  },
];

const interests = [
  "Longitudinal models with flexible distribution and dependence",
  "Policy questions we can inform with data",
  "Making statistical modelling more accessible and usable",
  "The impact of AI on data science and statistics",
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
      if (item.links) {
        content.append(createLinks(item.links));
      }

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
    { x: width * 0.18, y: height * 0.28, r: 42, color: "#587366", label: "M" },
    { x: width * 0.55, y: height * 0.2, r: 56, color: "#2f5f91", label: "G" },
    { x: width * 0.75, y: height * 0.58, r: 48, color: "#b4473f", label: "D" },
    { x: width * 0.34, y: height * 0.72, r: 52, color: "#b7832f", label: "AI" },
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
  ctx.fillText("clickable map of useful work", 22, height - 24);
}

renderProjects();
renderUpdates();
renderInterests();
drawWorkbench();
window.addEventListener("resize", drawWorkbench);
