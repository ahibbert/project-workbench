export function removeLibraryEntry(items, item, keyFor) {
  const title = item?.mangaTitle || "this title";
  if (!window.confirm(`Remove “${title}” from Panels?\n\nThe Suwayomi title and downloaded chapters will be kept.`)) return null;
  const key = keyFor(item);
  return {
    removed: items.find((entry) => keyFor(entry) === key),
    items: items.filter((entry) => keyFor(entry) !== key),
  };
}
