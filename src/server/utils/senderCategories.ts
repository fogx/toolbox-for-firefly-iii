/**
 * Correspondent / merchant substring -> Firefly category name, used by the
 * review queue as a deterministic fast path before any AI call.
 *
 * Configured via REVIEW_SENDER_CATEGORIES as `needle=category` pairs separated
 * by `;` or newlines, e.g. `rewe=groceries; deutsche bahn=transport`.
 * Needles are lower-cased for case-insensitive matching; category names keep
 * their case. Malformed entries are skipped. Unset means no fast path.
 */
export function parseSenderCategories(raw: string | undefined): Array<[string, string]> {
  if (!raw) return [];
  const pairs: Array<[string, string]> = [];
  for (const entry of raw.split(/[;\n]/)) {
    const idx = entry.indexOf('=');
    if (idx <= 0) continue;
    const needle = entry.slice(0, idx).trim().toLowerCase();
    const category = entry.slice(idx + 1).trim();
    if (needle && category) pairs.push([needle, category]);
  }
  return pairs;
}
