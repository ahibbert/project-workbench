# Project launcher lab

A local-only comparison of seven launcher concepts using the same project data:

1. Map + drawer
2. Workbench desk
3. Studio shelves
4. Project constellation
5. Product gallery
6. Workbench gallery
7. Project folios

Every concept can be paired with one of three project-detail treatments:

- Side inspector
- Desk dossier modal
- Inline project sheet

The workbench trial starts with no project selected. App entries use their real
project icons. Research and blog entries use literal work samples: live tool
output, R plots, a preprint title page, manuscript output and charts from the
published notes. Inline and dossier details show the same sourced media with
explicit labels.

On wide monitors the full page is capped at 980px and centred, preserving the
compact left-hand launcher and right-hand detail sheet. At phone widths, the
detail sheet still opens directly below the selected card.

The prototype uses the three-part taxonomy: Research, Apps and Blogs. Serve this
folder over HTTP and open `index.html`; no build is needed.

```sh
python -m http.server 8875
```

The prototype is intentionally separate from the published homepage.
