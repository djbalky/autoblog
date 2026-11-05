/**
 * Autonoblog — HTTP status for server-rendered public pages (Phase 5c).
 *
 * The public routes must answer a real `404` status for content that is not
 * published — not a 200 page that merely *says* "not found". The route loaders
 * call `setHttpStatus(404)` right before throwing `notFound()`, so the SSR
 * response carries the correct status and the router renders the styled 404
 * component.
 *
 * The import is dynamic and guarded by `import.meta.env.SSR`, which Vite
 * replaces with `false` in the client bundle: on client-side navigation this
 * function is a no-op (there is no HTTP response to set there — the router
 * still renders the 404 component), and the server-only module never reaches
 * the browser bundle.
 */
export async function setHttpStatus(code: number): Promise<void> {
  if (!import.meta.env.SSR) return;
  try {
    const mod = await import("@tanstack/react-start/server");
    mod.setResponseStatus(code);
  } catch {
    // Outside a server request context (e.g. a unit test) — nothing to set.
  }
}
