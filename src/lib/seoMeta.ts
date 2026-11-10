/**
 * Autonoblog — small pure helpers for per-page SEO metadata (Phase 5d).
 *
 * Shared by the public routes' `head()` functions. Nothing here invents a value:
 * a description is the content's own excerpt (or plain-text derivation), a URL is
 * the request origin plus a real path, and an image is the content's own.
 */

/** Trim text to `max` chars on a word boundary, for a meta description. */
export function metaDescription(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Absolute URL for a blog path, or null when the origin is unknown (then the
 * caller omits the tag instead of emitting a made-up domain).
 */
export function absoluteUrl(origin: string, path: string): string | null {
  const base = (origin ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/i.test(base)) return null;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Absolute image URL: a stored relative media path is resolved against the origin. */
export function absoluteImage(origin: string, url: string): string | null {
  const u = (url ?? "").trim();
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/")) return absoluteUrl(origin, u);
  return null;
}

/** ISO-8601 timestamp for schema.org dates, or "" when unparseable. */
export function isoDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}
