// The slug rule. A slug is the article's folder in ~/writing and its route on the site, and never changes.

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_MAX = 64;

/** Why a slug is refused, or null when it is good. */
export function slugProblem(slug: string): string | null {
  if (slug.length === 0) return "slug is empty";
  if (slug.length > SLUG_MAX) return `slug is longer than ${SLUG_MAX} characters`;
  if (!SLUG_RE.test(slug)) return "slug is lowercase letters, digits and single hyphens";
  if (slug === "index") return "slug cannot be index";
  return null;
}

/**
 * A slug to offer for an idea: its first few words, lowercase, joined by hyphens. `What if agents forget
 * their sockets?` becomes `what-if-agents-forget-their`. Empty when the text has no letters or digits.
 */
export function suggestSlug(text: string, maxWords = 5, maxLength = 40): string {
  const words = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let out = "";
  for (const w of words.slice(0, maxWords)) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > maxLength) break;
    out = next;
  }
  if (!out && words[0]) out = words[0].slice(0, maxLength);
  return out === "index" ? "index-1" : out;
}
