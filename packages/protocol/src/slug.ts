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
