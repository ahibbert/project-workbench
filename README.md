# Project Workbench

A static portfolio/workbench landing page for research software, data questions,
writing, and experiments.

Open `index.html` directly in a browser, or serve the directory locally:

```sh
python3 -m http.server 8000
```

Most editable content lives in `script.js`:

- `projects`
- `dataQuestions`
- `latestUpdates`
- `interests`

The Australian Data Review clone now lives at `./australian-data-review`. The
Data Questions cards in `script.js` link to the rendered Quarto site and each
post's source folder.
