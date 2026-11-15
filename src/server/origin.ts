/**
 * Autonoblog — the REAL origin the public site advertises (Phase 5d, fixed in 5e).
 *
 * Every canonical link, `og:url`, JSON-LD URL, sitemap `<loc>` and feed link is
 * built from this origin.
 *
 * Phase 5e: it now resolves through `src/server/publicOrigin.ts` — the ONE
 * documented place that decides the public origin. `PUBLIC_ORIGIN` wins when set,
 * otherwise the site's real published address (`DEFAULT_PUBLIC_ORIGIN`) is used,
 * and only `PUBLIC_ORIGIN=request` falls back to the origin of the current
 * request. That is what stops the proxy's preview host from reaching a canonical
 * link. See publicOrigin.ts for the full order and what a custom domain needs.
 *
 * Returns "" only when nothing can be determined (request mode with no request);
 * callers then omit the absolute URL rather than emit a made-up one.
 */
import { getRequestUrl } from "./requestUrl";
import { configuredPublicOrigin, normalizeOrigin } from "./publicOrigin";

export async function currentOrigin(): Promise<string> {
  // Configured (or default) origin: no request needed, same answer on the
  // server and in the browser.
  const configured = configuredPublicOrigin();
  if (configured) return configured;

  // PUBLIC_ORIGIN=request — use the origin of the request being answered.
  if (!import.meta.env.SSR) {
    return typeof window !== "undefined" && window.location?.origin ? window.location.origin : "";
  }
  try {
    const raw = await getRequestUrl();
    return normalizeOrigin(new URL(raw).origin);
  } catch {
    return "";
  }
}
