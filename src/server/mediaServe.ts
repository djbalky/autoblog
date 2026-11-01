/**
 * Autonoblog — serve uploaded media bytes for `GET /media/:id`
 * (and the Phase-2 alias `/api/media/:id`).
 *
 * Why this lives in serve.ts and not in a file route: the app runs on TanStack
 * Start 1.168, where `createAPIFileRoute` / `createServerFileRoute` no longer
 * exist (the package has no `./api` export). A file route that exports `Route`
 * with `server.handlers` IS generated into the server route tree, but this
 * build's SSR router never dispatches it — the route module is emitted as its
 * own lazily-imported chunk that `handleServerRoutes` does not have loaded when
 * it looks up `foundRoute.options.server.handlers`, so the request fell through
 * to the router's HTML 404 page. Verified against the running build, not
 * inferred. The production entry point (serve.ts) therefore answers these
 * paths directly, before the SSR handler.
 *
 * Phase 5a hardening (all real checks, no guessing):
 *  - Only `/media/<digits>` and `/api/media/<digits>` are accepted; anything
 *    else (traversal, encoded slashes, nested paths) falls through to the app
 *    router instead of touching the filesystem.
 *  - The on-disk path is taken from the DB row's `file_path` and then verified
 *    to resolve *inside* DATA_DIR, so a bad row can never escape the data dir.
 *  - Only image mime types the library accepts are served; anything else is an
 *    honest 404 instead of dumping arbitrary bytes with a guessed type.
 *
 * Access model: PUBLIC read by id. These are a blog's own assets — the wizard's
 * logo/favicon are referenced from plain `<img src>` in the blog chrome, and
 * from Phase 5c the images embedded in published articles are fetched by
 * anonymous visitors too. There is no per-request tenant to check on a public
 * page, so the asset itself is public; *managing* media (list/upload/delete) is
 * strictly blog-member scoped in src/server/dal/media.ts.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DATA_DIR } from "./db";
import { ensureInitialized } from "./init";
import { getMedia } from "./dal/media";

/** Mime types this endpoint will hand back (mirrors MEDIA_LIMITS + wizard types). */
const SERVABLE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/x-icon",
]);

/**
 * Parse `/media/<id>` or `/api/media/<id>` → id.
 * Returns null when the path is not a media request at all, and -1 when it is a
 * media path with an unusable id (so the caller can answer an honest 404).
 */
export function mediaIdFromPath(pathname: string): number | null {
  const m = /^(\/api)?\/media\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  const raw = m[2];
  if (!/^\d{1,18}$/.test(raw)) return -1; // media path, bad id (incl. traversal attempts)
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : -1;
}

/** True when `relPath` resolves to a file inside DATA_DIR (no traversal). */
function insideDataDir(relPath: string): string | null {
  const root = resolve(DATA_DIR);
  const abs = resolve(join(root, relPath));
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

export async function serveMedia(
  id: number,
  requestHeaders?: Headers
): Promise<Response | null> {
  if (id <= 0) return new Response("Not found", { status: 404 });
  await ensureInitialized();
  const media = await getMedia(id);
  if (!media) return new Response("Not found", { status: 404 });

  const mime = String(media.mime_type || "").toLowerCase();
  if (!SERVABLE_MIME.has(mime)) {
    return new Response("Not found", { status: 404 });
  }

  const path = insideDataDir(media.file_path);
  if (!path) return new Response("Not found", { status: 404 });
  if (!existsSync(path)) return new Response("Not found", { status: 404 });

  const size = statSync(path).size;
  const etag = `"m${id}-${size}"`;
  if (requestHeaders?.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  const buf = readFileSync(path);
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Content-Length": String(buf.byteLength),
    // Media ids are never reused, so an id is an immutable resource.
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };
  // SVG is an active content type — sandbox it if one is served.
  if (mime === "image/svg+xml") {
    headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  }
  return new Response(new Uint8Array(buf), { headers });
}
