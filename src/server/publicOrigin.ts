/**
 * Autonoblog — THE public origin (Phase 5e). One documented place that decides
 * which absolute host the public site advertises.
 *
 * Why it exists: the app is reverse-proxied to :3000, so the `Host` this process
 * sees is the proxy's host (`…preview.bl.run`), not the address a visitor or a
 * search engine uses. Canonical links, `og:url`, JSON-LD URLs, sitemap `<loc>`
 * entries, feed links and redirect `Location` headers all come from here, so the
 * wrong host can never leak into a document that search engines index.
 *
 * Resolution order:
 *   1. `PUBLIC_ORIGIN` env var, when set to an http(s) URL — use it verbatim
 *      (trailing slash stripped). This is what a custom domain sets, e.g.
 *      `PUBLIC_ORIGIN=https://blog.example.com`.
 *   2. `PUBLIC_ORIGIN=request` (or `auto`) — fall back to the origin of the
 *      current request (proxy headers first), the Phase-5d behaviour. Useful for
 *      local work and preview hosts.
 *   3. Unset — `DEFAULT_PUBLIC_ORIGIN`, the address this site is really
 *      published at today, so the live site is correct out of the box.
 *
 * A custom domain later needs exactly one thing: set `PUBLIC_ORIGIN` to it in
 * the environment the server is started with (`publish.sh` inherits the shell
 * environment), then republish. Nothing else hardcodes a host.
 *
 * Client-safe: this module only reads `process.env` behind a guard and does no
 * imports, so the same resolution runs in the browser bundle (where the env is
 * absent and the default applies, matching what the server rendered).
 */

/** The address this site is published at today. */
export const DEFAULT_PUBLIC_ORIGIN = "https://a1959cbb83fa0075a440fe9a12d8f87a.cto.site";

/** `PUBLIC_ORIGIN` when it was set to something meaningful, else "". */
function rawSetting(): string {
  try {
    const env = typeof process !== "undefined" && process ? process.env : undefined;
    return String(env?.PUBLIC_ORIGIN ?? "").trim();
  } catch {
    return "";
  }
}

/** Normalise an origin: http(s) only, no path, no trailing slash; "" when unusable. */
export function normalizeOrigin(value: string): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

/**
 * The configured public origin, or "" when the app should use the origin of the
 * request being answered (`PUBLIC_ORIGIN=request`).
 */
export function configuredPublicOrigin(): string {
  const raw = rawSetting();
  if (!raw) return DEFAULT_PUBLIC_ORIGIN;
  if (/^(request|auto)$/i.test(raw)) return "";
  return normalizeOrigin(raw) || DEFAULT_PUBLIC_ORIGIN;
}

/** The public origin to advertise: the configured one, else the request's own. */
export function publicOriginForRequest(requestOrigin: string): string {
  return configuredPublicOrigin() || normalizeOrigin(requestOrigin) || DEFAULT_PUBLIC_ORIGIN;
}

/** Absolute URL for a site path under the public origin. */
export function absoluteUnder(origin: string, path: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
