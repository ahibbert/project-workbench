window.launcherData = {
  groups: [
    {
      id: "research",
      label: "Research",
      short: "Research",
      description: "Statistical software, modelling tools, papers and research experiments.",
      color: "#2f5f91"
    },
    {
      id: "apps",
      label: "Apps",
      short: "Apps",
      description: "Apps, tools, readers and games outside the formal statistics work.",
      color: "#b4473f"
    },
    {
      id: "blogs",
      label: "Blogs",
      short: "Blogs",
      description: "Public notes and less-formal analysis from the workbench blog.",
      color: "#587366"
    }
  ],
  concepts: [
    {
      id: "map-drawer",
      number: "01",
      label: "Map + drawer",
      summary: "A navigable overview that opens one project at a time for closer inspection.",
      strength: "Best balance of personality, orientation and detail.",
      risk: "Needs careful positioning as the project list grows."
    },
    {
      id: "workbench-desk",
      number: "02",
      label: "Workbench desk",
      summary: "Projects become papers, devices and objects arranged across a working surface.",
      strength: "Most memorable and closest to the workbench metaphor.",
      risk: "The deliberate mess can become harder to scan."
    },
    {
      id: "studio-shelves",
      number: "03",
      label: "Studio shelves",
      summary: "Three orderly shelves hold compact project covers with room to expand.",
      strength: "Easy to browse, understand and extend.",
      risk: "Less surprising than the more spatial concepts."
    },
    {
      id: "constellation",
      number: "04",
      label: "Project constellation",
      summary: "A network foregrounds the relationships between projects and ideas.",
      strength: "Best at showing how the work connects.",
      risk: "Visitors may need a moment before they know where to begin."
    },
    {
      id: "product-gallery",
      number: "05",
      label: "Product gallery",
      summary: "Large editorial panels make every project feel tangible and considered.",
      strength: "Strongest visual storytelling and clearest project previews.",
      risk: "Takes more scrolling and gives less of an overview."
    },
    {
      id: "workbench-gallery",
      number: "06",
      label: "Workbench gallery",
      summary: "An orderly editorial grid, but every panel still feels like a physical object on a shared work surface.",
      strength: "Combines the gallery's clarity with the desk's warmth and personality.",
      risk: "Needs enough variation to avoid feeling like a conventional card grid."
    },
    {
      id: "project-folios",
      number: "07",
      label: "Project folios",
      summary: "Clear, stacked folders turn each project into a compact dossier that can open without losing the page structure.",
      strength: "Fast to scan, highly scalable and naturally suited to inline detail.",
      risk: "More editorial than playful unless the paper details carry enough character."
    }
  ],
  projects: [
    {
      id: "little-now",
      group: "apps",
      title: "Little Now",
      type: "iPhone & iPad app",
      status: "Shipping",
      access: "Public website",
      visual: "phone",
      icon: "assets/projects/little-now/icon.webp",
      media: [
        { src: "assets/projects/little-now/screen-01.webp", alt: "Little Now recommendation screen in its App Store presentation", label: "App Store capture · recommendation" },
        { src: "assets/projects/little-now/screen-02.webp", alt: "Little Now activity details screen in its App Store presentation", label: "App Store capture · activity details" }
      ],
      accent: "#e97962",
      featured: true,
      description: "One practical, caregiver-led play idea matched to the time, setup and interests available right now.",
      focus: "Preparing the first App Store release and public activity-sharing flow.",
      links: [
        { label: "Visit site", href: "https://little-now.aydins-workbench.com" },
        { label: "App Store", href: "https://apps.apple.com/app/id6821227588" }
      ],
      related: ["workbench-blog"]
    },
    {
      id: "panels",
      group: "apps",
      title: "Panels",
      type: "Reading app",
      status: "Private beta",
      access: "Sign-in required",
      visual: "reader",
      icon: "assets/projects/panels/icon.webp",
      accent: "#7d5c99",
      description: "A private reading workspace for organising, opening and working through visual publications.",
      focus: "A focused, library-like reading workflow for approved accounts.",
      links: [{ label: "Open sign-in", href: "https://panels.aydins-workbench.com" }],
      related: ["panel-pilot"]
    },
    {
      id: "margin",
      group: "apps",
      title: "Margin",
      type: "Research discovery app",
      status: "Private beta",
      access: "Sign-in required",
      visual: "feed",
      icon: "assets/projects/margin/icon.webp",
      media: [
        { src: "assets/projects/margin/brand-preview.webp", alt: "Margin brand preview with its research-network motif", label: "Current brand preview" }
      ],
      accent: "#466d67",
      description: "A calm personal feed for discovering research and deciding what deserves a closer read.",
      focus: "Testing a quieter, context-first research discovery experience.",
      links: [{ label: "Open sign-in", href: "https://research.aydins-workbench.com" }],
      related: ["workbench-blog"]
    },
    {
      id: "panel-pilot",
      group: "apps",
      title: "Panel Pilot",
      type: "Native reader prototype",
      status: "In development",
      access: "No public build",
      visual: "comic",
      icon: "assets/projects/panel-pilot/icon.webp",
      accent: "#d07a3d",
      description: "A local-first comic reader exploring comfortable navigation, libraries and native reading behaviour.",
      focus: "Release-readiness, device behaviour and the core reading loop.",
      links: [],
      related: ["panels"]
    },
    {
      id: "household-cash",
      group: "apps",
      title: "Household Cash",
      type: "Household tool",
      status: "Private",
      access: "Internal use",
      visual: "cash",
      icon: "assets/projects/household-cash/icon.webp",
      media: [
        { src: "assets/projects/household-cash/brand-preview.webp", alt: "Household Cash current visual identity", label: "Current brand preview" }
      ],
      accent: "#4d7c59",
      description: "A deliberately small shared view of household cash, built around clarity instead of dashboard complexity.",
      focus: "A private household workflow using fictional data in public previews.",
      links: [],
      related: []
    },
    {
      id: "starfall-company",
      group: "apps",
      title: "Starfall Company",
      type: "Tactics game",
      status: "Playable MVP",
      access: "Local prototype",
      visual: "game",
      icon: "assets/projects/starfall-company/icon.webp",
      media: [
        { src: "assets/projects/starfall-company/gameplay-concept.webp", alt: "Starfall Company Heart of Glass tactical encounter concept", label: "Gameplay direction · Heart of Glass" },
        { src: "assets/projects/starfall-company/colony-concept.webp", alt: "Starfall Company Ilex colony building concept", label: "Gameplay direction · Ilex colony" }
      ],
      accent: "#bb7d27",
      description: "A touch-first science-fantasy tactics game about positioning, pressure and keeping a small company alive.",
      focus: "Combat feel, encounter pacing and a route towards a public build.",
      links: [],
      related: []
    },
    {
      id: "gamlss-longitudinal",
      group: "research",
      title: "gamlss.longitudinal",
      type: "R package",
      status: "In development",
      access: "Open source",
      visual: "trajectories",
      icon: "assets/projects/gamlss-longitudinal/icon.svg",
      media: [
        { src: "assets/projects/gamlss-longitudinal/optimizer-benchmark.webp", alt: "Optimizer benchmark output from the gamlss.longitudinal project", label: "Research output · optimiser benchmark" }
      ],
      accent: "#3970a8",
      featured: true,
      description: "Flexible longitudinal GAMLSS models with changing margins and copula dependence.",
      focus: "Documentation, examples and practical modelling workflows.",
      links: [
        { label: "Package site", href: "https://gamlsslongitudinal.aydins-workbench.com" },
        { label: "Source", href: "https://github.com/ahibbert/gamlss.longitudinal" }
      ],
      related: ["distribution-playground", "copula-paper", "gamlss-longitudinal-paper"]
    },
    {
      id: "distribution-playground",
      group: "research",
      title: "Distribution Playground",
      type: "Interactive research tool",
      status: "Research preview",
      access: "Public",
      visual: "distribution",
      icon: "assets/projects/distribution-playground/icon.svg",
      accent: "#285f91",
      featured: true,
      description: "Interactive distributions, dependence, quantile comparison and longitudinal simulation in one workbench.",
      focus: "Deeper worked examples, interpretation and export workflows.",
      links: [{ label: "Launch tool", href: "https://gamlss.aydins-workbench.com" }],
      related: ["gamlss-longitudinal", "copula-paper", "gamlss-longitudinal-paper"]
    },
    {
      id: "copula-paper",
      group: "research",
      title: "Copula-based joint regression models",
      type: "Research paper",
      status: "Under review",
      access: "Public preprint",
      visual: "paper",
      icon: "assets/projects/copula-paper/icon.svg",
      accent: "#547a9b",
      description: "A comparison of copula-based, mixed-model and estimating-equation approaches for correlated regression.",
      focus: "Understanding what each modelling strategy represents and where its trade-offs appear.",
      links: [{ label: "Read preprint", href: "https://arxiv.org/abs/2410.11892" }],
      related: ["gamlss-longitudinal", "distribution-playground", "gamlss-longitudinal-paper"]
    },
    {
      id: "gamlss-longitudinal-paper",
      group: "research",
      title: "Longitudinal GAMLSS Models With Copula Dependence in R",
      type: "Paper in progress",
      status: "In progress",
      access: "Working manuscript",
      visual: "paper",
      icon: "assets/projects/gamlss-longitudinal-paper/icon.svg",
      media: [
        { src: "assets/projects/gamlss-longitudinal/optimizer-benchmark.webp", alt: "Optimizer benchmark output supporting the longitudinal GAMLSS manuscript", label: "Manuscript output · optimiser benchmark" }
      ],
      accent: "#64558a",
      description: "A paper describing longitudinal GAMLSS models with flexible margins and first-order copula dependence in R.",
      focus: "Developing the manuscript, package examples, validation and reproducible reviewer materials.",
      links: [{ label: "Package source", href: "https://github.com/ahibbert/gamlss.longitudinal" }],
      related: ["gamlss-longitudinal", "distribution-playground", "copula-paper"]
    },
    {
      id: "workbench-blog",
      group: "blogs",
      title: "Aydin's Workbench blog",
      type: "Public notes",
      status: "Live",
      access: "Public",
      visual: "blog",
      icon: "assets/projects/workbench-blog/icon.svg",
      accent: "#547766",
      featured: true,
      description: "Reproducible notes on Australian public data, modelling questions and projects while they are still taking shape.",
      focus: "Keep the data, caveats and reasoning visible rather than polishing too early.",
      links: [{ label: "Read the blog", href: "https://blog.aydins-workbench.com" }],
      related: ["housing-note", "ndis-note", "bulk-billing-note"]
    },
    {
      id: "housing-note",
      group: "blogs",
      title: "A First Pass At Australian Dwelling Prices",
      type: "Data note",
      status: "Public draft",
      access: "Public",
      visual: "housing",
      icon: "assets/projects/housing-note/icon.svg",
      accent: "#a96547",
      description: "A reproducible look at ABS dwelling values, state mean prices and the policy questions they raise.",
      focus: "Housing, cost of living and public data.",
      links: [{ label: "Read note", href: "https://blog.aydins-workbench.com/posts/housing-prices-first-pass/" }],
      related: ["workbench-blog"]
    },
    {
      id: "ndis-note",
      group: "blogs",
      title: "Are NDIS Participant Outcomes Changing?",
      type: "Data note",
      status: "Public draft",
      access: "Public",
      visual: "outcomes",
      icon: "assets/projects/ndis-note/icon.svg",
      accent: "#4b7d74",
      description: "A simpler look at national participant outcome levels and changes after plan reassessment.",
      focus: "Descriptive movement kept separate from causal interpretation.",
      links: [{ label: "Read note", href: "https://blog.aydins-workbench.com/posts/ndis-outcomes-spend-service-access/" }],
      related: ["workbench-blog"]
    },
    {
      id: "bulk-billing-note",
      group: "blogs",
      title: "Did Bulk Billing Changes Shift Access?",
      type: "Policy note",
      status: "Public draft",
      access: "Public",
      visual: "health",
      icon: "assets/projects/bulk-billing-note/icon.svg",
      accent: "#8f554f",
      description: "An early look at whether expanded GP bulk-billing incentives changed access patterns.",
      focus: "Policy signal, timing artefacts and reporting noise.",
      links: [{ label: "Read note", href: "https://blog.aydins-workbench.com/posts/bulk-billing-changes-impact/" }],
      related: ["workbench-blog"]
    }
  ]
};
