/**
 * Autonoblog — reserved first-path-segment names (Phase 5c).
 *
 * A blog is published at `/<blog-slug>`, i.e. the FIRST path segment of the
 * public site. That segment is shared with the app's own routes and with files
 * the server answers directly, so a blog slug must never be able to shadow one
 * of them. This module is the single definition of "reserved", imported by:
 *
 *   - the wizard (`validatePayload`) — a user gets a clear error before any row
 *     is written, and the live slug checker in step 1 reports it as unavailable;
 *   - `uniqueSlug()` in the blogs DAL — the non-interactive/seed path silently
 *     picks a non-reserved variant instead of creating an unreachable blog;
 *   - the public loader (`/$blogSlug`) — defence in depth: even a row that was
 *     written before this rule existed is not reachable at a reserved path, it
 *     returns a real 404 like any other unknown blog.
 *
 * Client-safe: no server imports, so the wizard can use the same list.
 *
 * Rules for adding a name: it must be a path the app (or the server entry,
 * `serve.ts`) really answers, or one that Phase 5d/5e will answer at the root
 * (`sitemap.xml`, `robots.txt`, `rss`, `feed`). Do not reserve ordinary words a
 * blog might legitimately want (about, contact, blog, news, …).
 */
export const RESERVED_BLOG_SLUGS: readonly string[] = [
  // App routes that exist today
  "login",
  "register",
  "logout",
  "dashboard",
  "blogs",
  "new",
  "media",
  // Server-answered paths (see serve.ts / mediaServe.ts)
  "api",
  "assets",
  "static",
  "_build",
  "favicon.ico",
  // Root files planned for the SEO/RSS increments (Phase 5d/5e). Reserving them
  // now means no blog can ever take a URL that publishing will need later.
  "sitemap.xml",
  "robots.txt",
  "rss",
  "rss.xml",
  "feed",
  "feed.xml",
  // App-adjacent paths that would be confusing or reserved by convention
  "admin",
  "settings",
  "account",
  "billing",
  "plans",
  "404",
  "500",
  "_",
];

const RESERVED = new Set(RESERVED_BLOG_SLUGS);

/** True when `slug` may not be used as a public blog slug. */
export function isReservedSlug(slug: string | null | undefined): boolean {
  const s = (slug ?? "").trim().toLowerCase();
  if (!s) return true;
  return RESERVED.has(s);
}

/** The honest message shown when a user picks a reserved slug. */
export function reservedSlugMessage(slug: string): string {
  return `"/${slug}" is reserved by the app (it is one of the platform's own URLs). Choose a different blog slug.`;
}
