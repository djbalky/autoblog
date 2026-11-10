/**
 * Autonoblog — the REAL origin of the request being answered (Phase 5d).
 *
 * Every canonical link, `og:url`, JSON-LD URL, sitemap `<loc>` and feed link is
 * built from this origin, so the site never advertises a hardcoded domain: a
 * request for `http://localhost:3000/...` produces localhost URLs, and the same
 * request through the public host produces public URLs.
 *
 * Server: derived from the incoming request, preferring the proxy headers
 * (`x-forwarded-proto` / `x-forwarded-host`) when present, because the app is
 * reverse-proxied to :3000 and the `Host` the process sees is not necessarily
 * the host the visitor typed.
 * Client (after a client-side navigation): `window.location.origin`.
 *
 * Returns "" when no origin can be determined; callers then omit the absolute
 * URL rather than emit a made-up one.
 */
import { getRequestUrl } from "./requestUrl";

export async function currentOrigin(): Promise<string> {
  if (!import.meta.env.SSR) {
    return typeof window !== "undefined" && window.location?.origin ? window.location.origin : "";
  }
  try {
    const raw = await getRequestUrl();
    return new URL(raw).origin;
  } catch {
    return "";
  }
}
