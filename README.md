# Project Workbench

A static portfolio/workbench landing page for apps, research software, games,
data questions, writing, and experiments.

Serve the directory locally so the browser can load the JSON project registry:

```sh
python3 -m http.server 8000
```

Project and post content lives in `projects.json`. The registry is grouped into:

- Apps & products
- Research software
- Games & experiments
- Writing & publications

`script.js` renders the registry and provides accessible group filters. `index.html`
contains the page narrative and `styles.css` contains the presentation layer.

Validate the registry before publishing:

```sh
node scripts/validate-projects.mjs
```

The main public site lives at <https://aydins-workbench.com>. Project subdomains
currently include:

- <https://blog.aydins-workbench.com>
- <https://little-now.aydins-workbench.com>
- <https://gamlss.aydins-workbench.com>
- <https://gamlss.aydins-workbench.com/longitudinal/>
- <https://gamlsslongitudinal.aydins-workbench.com>
- <https://quantile.aydins-workbench.com>
- <https://copula.aydins-workbench.com>
