/**
 * Autonoblog — catch-all route (Phase 5c).
 *
 * Any path the app does not handle lands here instead of falling through to the
 * router's default not-found. The loader sets a REAL HTTP 404 and throws
 * `notFound()`, so the response is a 404 status carrying the root route's styled
 * NotFoundPage — not a 200 page that merely says "not found".
 */
import { createFileRoute, notFound } from "@tanstack/react-router";
import { setHttpStatus } from "~/server/httpStatus";

export const Route = createFileRoute("/$")({
  loader: async () => {
    await setHttpStatus(404);
    throw notFound();
  },
});
