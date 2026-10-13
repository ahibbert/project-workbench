# Project Workbench

A static portfolio/workbench landing page for research, apps and public data notes.

Serve the directory locally so the browser can load the JSON project registry:

```sh
python3 -m http.server 8000
```

Project and post content lives in `projects.json`. The registry is grouped into:

- Research — statistical software and publications
- Apps — products, tools, readers and games
- Blogs — public notes and less-formal analysis

`script.js` renders the interactive workbench. No project is open initially; selecting
one reveals its status, links and real project imagery. On wide screens the detail
sheet opens beside the cards, while narrow screens place it directly below the
selected card. `index.html` contains the page narrative and `styles.css` contains
the presentation layer. Full-width colour bands wrap a consistent centred 1200px content shell.

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
