function normalizeSourceTitle(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const safeVariantTokens = new Set([
  "official", "digital", "edition", "english", "eng", "manga", "comic", "comics",
  "complete", "remastered", "colored", "colour", "color", "uncensored",
]);

export function sourceTitleMatch(desiredValue, candidateValue) {
  const desired = normalizeSourceTitle(desiredValue);
  const candidate = normalizeSourceTitle(candidateValue);
  if (!desired || !candidate) return null;
  if (desired === candidate) return "exact";
  const desiredTokens = desired.split(" ");
  const candidateTokens = candidate.split(" ");
  const desiredSet = new Set(desiredTokens);
  const candidateSet = new Set(candidateTokens);
  const desiredContained = desiredTokens.every((token) => candidateSet.has(token));
  const candidateContained = candidateTokens.every((token) => desiredSet.has(token));
  const phraseContained = candidate.startsWith(`${desired} `) || desired.startsWith(`${candidate} `);
  const extras = desiredContained
    ? candidateTokens.filter((token) => !desiredSet.has(token))
    : candidateContained ? desiredTokens.filter((token) => !candidateSet.has(token)) : [];
  if (!extras.length) return null;
  return phraseContained && (desiredContained || candidateContained)
    && extras.every((token) => safeVariantTokens.has(token) || /^\d{4}$/.test(token))
    ? "variant"
    : null;
}
