/**
 * Autonoblog — serve uploaded media bytes for `GET /api/media/:id`.
 *
 * Phase 2 bug-pass finding (why this lives in serve.ts and not in a file route):
 * the app runs on TanStack Start 1.168, where `createAPIFileRoute` /
 * `createServerFileRoute` no longer exist (the package has no `./api` export).
 * A file route that exports `Route` with `server.handlers` IS generated into the
 * server route tree, but this build's SSR router never dispatches it — the route
 * module is emitted as its own lazily-imported chunk that `handleServerRoutes`
 * does not have loaded when it looks up `foundRoute.options.server.handlers`, so
 * `/api/media/1` fell through to the router's HTML 404 page. Verified against the
 * running build, not inferred.
 *
 * The production entry point (serve.ts) therefore answers this path directly,
 * before the SSR handler: a real `media` DB row lookup and the real bytes of the
 * file the DAL wrote under DATA_DIR. Returning `null` means "not mine / not
 * found" and the caller falls through to the app router.
 *
 * Access model: PUBLIC, because these are a blog's own brand assets (logo,
 * favicon) and, from Phase 5, the images embedded in published articles; the
 * stored config already references them as `logo_url` from an `<img src>` with
 * no credentials. There is no directory-traversal risk: the path is built from
 * the DB row's `file_path` under DATA_DIR and never from the request URL.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./db";
import { ensureInitialized } from "./init";
import { getMedia } from "./dal/media";

/** Parse `/api/media/<id>` → id, or null when the path is not a media request. */
export function mediaIdFromPath(pathname: string): number | null {
  const m = /^\/api\/media\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id > 0 ? id : -1; // -1 = media path, bad id
}

export async function serveMedia(id: number): Promise<Response | null> {
  if (id <= 0) return new Response("Not found", { status: 404 });
  await ensureInitialized();
  const media = await getMedia(id);
  if (!media) return new Response("Not found", { status: 404 });
  const path = join(DATA_DIR, media.file_path);
  if (!existsSync(path)) return new Response("Not found", { status: 404 });
  const buf = readFileSync(path);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": media.mime_type || "application/octet-stream",
      "Content-Length": String(buf.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
