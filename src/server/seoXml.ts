/**
 * Autonoblog — SEO machine formats (Phase 5d): sitemap XML, RSS 2.0, robots.txt.
 *
 * Pure string builders. Every value they receive comes from the database
 * (`dal/publicSite.ts`) and from the ORIGIN of the request being answered — the
 * builders never invent a domain, a date or an entry, and they never see a row
 * that is not already filtered by the public visibility rule.
 *
 * Escaping: every text node goes through `xml()` (which also strips characters
 * that are illegal in XML 1.0), so a post title containing `<`, `&` or `]]>`
 * can never break the document. `robotsTxt` is plain text and needs none.
 */
import type { PublicBlog, PublicFeed, PublicSitemap } from "./dal/publicSite";

/** Escape a string for use in XML text/attributes; drop XML-illegal controls. */
export function xml(value: unknown): string {
  return String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** RFC 822 date (RSS `pubDate` / `lastBuildDate`), or "" when unparseable. */
export function rfc822(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toUTCString();
}

/** W3C / ISO-8601 date (sitemap `lastmod`), or "" when unparseable. */
export function isoDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/** Absolute URL for a blog-relative path under the real request origin. */
export function absolute(origin: string, path: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

// ---- Sitemap ---------------------------------------------------------------

export function sitemapXml(origin: string, sitemap: PublicSitemap): string {
  const urls = sitemap.entries.map((entry) => {
    const lastmod = isoDate(entry.lastmod);
    return (
      "  <url>\n" +
      `    <loc>${xml(absolute(origin, entry.path))}</loc>\n` +
      (lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : "") +
      "  </url>"
    );
  });
  return (
    `${XML_DECL}\n` +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    (urls.length ? `${urls.join("\n")}\n` : "") +
    "</urlset>\n"
  );
}

/** Root `/sitemap.xml`: one `<sitemap>` per ACTIVE blog (each one exists). */
export function sitemapIndexXml(origin: string, blogSlugs: string[], lastmod?: string): string {
  const lm = isoDate(lastmod ?? "");
  const entries = blogSlugs.map(
    (slug) =>
      "  <sitemap>\n" +
      `    <loc>${xml(absolute(origin, `/${slug}/sitemap.xml`))}</loc>\n` +
      (lm ? `    <lastmod>${lm}</lastmod>\n` : "") +
      "  </sitemap>"
  );
  return (
    `${XML_DECL}\n` +
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    (entries.length ? `${entries.join("\n")}\n` : "") +
    "</sitemapindex>\n"
  );
}

// ---- RSS 2.0 feed ----------------------------------------------------------

/**
 * RSS 2.0 (chosen over Atom: the widest reader support for a blog feed).
 * The item author is emitted as `<dc:creator>` because RSS 2.0's `<author>`
 * requires an e-mail address, and we only ever have a display name.
 * A blog with no published posts still returns a valid, empty channel.
 */
export function feedXml(origin: string, feed: PublicFeed): string {
  const blog: PublicBlog = feed.blog;
  const home = absolute(origin, `/${blog.slug}`);
  const self = absolute(origin, `/${blog.slug}/feed.xml`);
  const description = blog.description.trim() || blog.tagline.trim() || `${blog.name} on Autonoblog.`;
  const buildDate = rfc822(feed.items[0]?.publishedAt ?? "") || rfc822(new Date().toISOString());

  const items = feed.items.map((item) => {
    const link = absolute(origin, item.path);
    const pubDate = rfc822(item.publishedAt);
    return (
      "    <item>\n" +
      `      <title>${xml(item.title)}</title>\n` +
      `      <link>${xml(link)}</link>\n` +
      `      <guid isPermaLink="true">${xml(link)}</guid>\n` +
      (pubDate ? `      <pubDate>${pubDate}</pubDate>\n` : "") +
      `      <description>${xml(item.excerpt)}</description>\n` +
      `      <dc:creator>${xml(item.authorName)}</dc:creator>\n` +
      "    </item>"
    );
  });

  return (
    `${XML_DECL}\n` +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
    "  <channel>\n" +
    `    <title>${xml(blog.name)}</title>\n` +
    `    <link>${xml(home)}</link>\n` +
    `    <description>${xml(description)}</description>\n` +
    "    <language>en</language>\n" +
    (buildDate ? `    <lastBuildDate>${buildDate}</lastBuildDate>\n` : "") +
    `    <atom:link href="${xml(self)}" rel="self" type="application/rss+xml"/>\n` +
    (items.length ? `${items.join("\n")}\n` : "") +
    "  </channel>\n" +
    "</rss>\n"
  );
}

// ---- robots.txt ------------------------------------------------------------

/**
 * `/robots.txt`. The `Sitemap:` lines are the ones this server actually serves:
 * the root sitemap index plus each active blog's own sitemap.
 */
export function robotsTxt(origin: string, blogSlugs: string[]): string {
  const lines = [
    "User-agent: *",
    "Allow: /",
    // The authenticated app shell is not public content.
    "Disallow: /dashboard",
    "Disallow: /login",
    "Disallow: /register",
    "Disallow: /api/",
    "",
    `Sitemap: ${absolute(origin, "/sitemap.xml")}`,
    ...blogSlugs.map((slug) => `Sitemap: ${absolute(origin, `/${slug}/sitemap.xml`)}`),
    "",
  ];
  return lines.join("\n");
}

/** Content-type helpers for the responses above. */
export const XML_CONTENT_TYPE = "application/xml; charset=utf-8";
export const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
