/**
 * Autonoblog — read the current request URL on the server (Phase 5d).
 *
 * Wraps the framework's request accessor so the server-only module never reaches
 * the client bundle (same pattern as `httpStatus.ts`): the import is dynamic and
 * guarded by `import.meta.env.SSR`, which Vite replaces with `false` in the
 * browser build.
 *
 * `xForwardedHost` / `xForwardedProto` are honoured, because the app is
 * reverse-proxied to :3000 — behind the proxy the host this process sees is not
 * the host the visitor typed, and canonical URLs must use the visitor's.
 */
export async function getRequestUrl(): Promise<string> {
  if (!import.meta.env.SSR) throw new Error("getRequestUrl is server-only");
  const mod = await import("@tanstack/react-start/server");
  const url = mod.getRequestUrl({ xForwardedHost: true, xForwardedProto: true });
  return typeof url === "string" ? url : url.href;
}
