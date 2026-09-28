/**
 * Autonoblog — serve uploaded media files back to the browser.
 * GET /api/media/:id returns the file bytes for a real `media` row.
 */
import { createAPIFileRoute } from "@tanstack/react-start/api";
import { readFileSync } from "node:fs";
import { ensureInitialized } from "../../server/init";
import { getMedia, resolveMediaFile } from "../../server/dal/media";

export const APIRoute = createAPIFileRoute("/api/media/$id")({
  GET: async ({ params }) => {
    await ensureInitialized();
    const id = Number(params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return new Response("Not found", { status: 404 });
    }
    const media = await getMedia(id);
    if (!media) return new Response("Not found", { status: 404 });
    const { path, exists } = resolveMediaFile(media);
    if (!exists) return new Response("Not found", { status: 404 });
    const buf = readFileSync(path);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": media.mime_type,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  },
});
