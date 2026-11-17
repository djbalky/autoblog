/**
 * Autonoblog — real 301s for renamed public content (Phase 5e).
 *
 * `serve.ts` calls this AFTER the SSR handler has answered, and only when that
 * answer was a 404. Two consequences, both deliberate:
 *
 *  - A URL that really has published content never reaches this module, so a
 *    redirect can never shadow a live post or page, and the hot path (a real
 *    article view) pays no extra query.
 *  - An app route (`/dashboard`, `/login`, `/blogs/…`, `/sitemap.xml`, …) never
 *    answers 404 through this path with two plain segments, and reserved
 *    first segments are skipped anyway, so no redirect can shadow the app.
 *
 * The `Location` header is absolute and built from the PUBLIC origin
 * (`src/server/publicOrigin.ts`), not from the proxy host the process sees.
 * The decision of *whether* an old path has a usable target lives in
 * `dal/redirects.ts` (it verifies the target is published right now).
 */
import { nowIso } from "./store";
import { resolvePublicRedirect } from "./dal/redirects";
import { publicOriginForRequest } from "./publicOrigin";
import { requestOrigin } from "./seoRoutes";
import { isReservedSlug } from "../lib/reservedSlugs";

export interface RedirectDecision {
  /** The path the visitor asked for, normalised ("/blog/old-slug"). */
  from: string;
  /** The path it now lives at ("/blog/new-slug"). */
  to: string;
  /** Absolute URL for the Location header, under the public origin. */
  location: string;
}

/** Split "/a/b" into ["a","b"]; null unless the path is exactly two segments. */
function twoSegments(pathname: string): [string, string] | null {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const parts = decoded.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  return [parts[0].toLowerCase(), parts[1].toLowerCase()];
}

/**
 * The 301 to answer for this request, or null when the 404 the app produced is
 * the honest answer.
 */
export async function redirectTargetForRequest(req: Request): Promise<RedirectDecision | null> {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;

  const { pathname } = new URL(req.url);
  const seg = twoSegments(pathname);
  if (!seg) return null;
  const [blogSlug, contentSlug] = seg;
  if (!blogSlug || !contentSlug) return null;
  // App routes and root files are never redirect sources.
  if (isReservedSlug(blogSlug)) return null;

  let to: string | null = null;
  try {
    to = await resolvePublicRedirect(blogSlug, contentSlug, nowIso());
  } catch (err) {
    // A database hiccup must not turn a 404 into a 500.
    console.error("[redirects] lookup failed:", err instanceof Error ? err.message : err);
    return null;
  }
  if (!to) return null;

  const origin = publicOriginForRequest(requestOrigin(req));
  return {
    from: `/${blogSlug}/${contentSlug}`,
    to,
    location: `${origin.replace(/\/+$/, "")}${to}`,
  };
}
