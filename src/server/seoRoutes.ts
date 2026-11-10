/**
 * Autonoblog — machine-readable public endpoints (Phase 5d):
 *
 *   GET /robots.txt                  → robots.txt (text/plain) pointing at sitemaps we really serve
 *   GET /sitemap.xml                 → sitemap index, one entry per ACTIVE blog
 *   GET /<blog-slug>/sitemap.xml     → that blog's real sitemap (application/xml)
 *   GET /<blog-slug>/feed.xml        → that blog's RSS 2.0 feed (application/xml)
 *
 * Served from `serve.ts` before the SSR handler (the same place `/media/<id>` is
 * answered), because these are not pages: they must return raw XML with the
 * right content type and no HTML wrapper. All rows come from
 * `dal/publicSite.ts`, which applies the public visibility rule in SQL — a draft
 * blog answers 404 here exactly like its pages do, and drafts / scheduled /
 * trashed / future-dated content never appears in a sitemap or a feed.
 *
 * Absolute URLs are built from the origin of THIS request (proxy headers first),
 * never from a hardcoded host.
 */
import { ensureInitialized } from "./init";
import { nowIso } from "./store";
import {
  getPublicSitemap,
  getPublicFeed,
  listActiveBlogSlugs,
} from "./dal/publicSite";
import {
  feedXml,
  robotsTxt,
  sitemapIndexXml,
  sitemapXml,
  TEXT_CONTENT_TYPE,
  XML_CONTENT_TYPE,
} from "./seoXml";

const BLOG_XML_PATH = /^\/([^/]+)\/(sitemap\.xml|feed\.xml)$/;
/** Sitemaps/feeds are cheap to rebuild and change as content is published. */
const CACHE = "public, max-age=300";

/** The real origin of this request: proxy headers first, then the URL itself. */
export function requestOrigin(req: Request): string {
  const url = new URL(req.url);
  const first = (value: string | null): string =>
    (value ?? "").split(",")[0]?.trim() ?? "";
  const proto = first(req.headers.get("x-forwarded-proto")) || url.protocol.replace(":", "");
  const host = first(req.headers.get("x-forwarded-host")) || req.headers.get("host") || url.host;
  const safeProto = /^https?$/.test(proto) ? proto : url.protocol.replace(":", "");
  const safeHost = /^[A-Za-z0-9._\-:[\]]+$/.test(host) ? host : url.host;
  return `${safeProto}://${safeHost}`;
}

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": XML_CONTENT_TYPE,
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
      "Cache-Control": CACHE,
      "X-Content-Type-Options": "nosniff",
      // The documents are self-contained and public; say so for any consumer.
      "Access-Control-Allow-Origin": "*",
      Vary: "x-forwarded-host, host",
    },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": TEXT_CONTENT_TYPE,
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
      "Cache-Control": CACHE,
      Vary: "x-forwarded-host, host",
    },
  });
}

/**
 * Answer one of the machine-readable endpoints, or return null when `req` is not
 * one of them (the caller then falls through to the SSR handler).
 */
export async function seoResponse(req: Request): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  const isRobots = pathname === "/robots.txt";
  const isIndex = pathname === "/sitemap.xml";
  const blogMatch = BLOG_XML_PATH.exec(pathname);
  if (!isRobots && !isIndex && !blogMatch) return null;

  const origin = requestOrigin(req);
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD", "Content-Type": TEXT_CONTENT_TYPE },
    });
  }

  const respond = (res: Response): Response =>
    method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;

  await ensureInitialized();
  const now = nowIso();

  if (isRobots) {
    return respond(textResponse(robotsTxt(origin, await listActiveBlogSlugs())));
  }

  if (isIndex) {
    return respond(xmlResponse(sitemapIndexXml(origin, await listActiveBlogSlugs(), now)));
  }

  const blogSlug = decodeURIComponent(blogMatch![1]);
  const kind = blogMatch![2];
  if (kind === "sitemap.xml") {
    const sitemap = await getPublicSitemap(blogSlug, now);
    // Unknown / draft / archived blog: a real 404, never an empty sitemap that
    // would claim the address exists.
    if (!sitemap) return respond(textResponse("Not found", 404));
    return respond(xmlResponse(sitemapXml(origin, sitemap)));
  }

  const feed = await getPublicFeed(blogSlug, now);
  if (!feed) return respond(textResponse("Not found", 404));
  return respond(xmlResponse(feedXml(origin, feed)));
}
