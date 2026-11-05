/**
 * Autonoblog — the one styled 404 page (Phase 5c).
 *
 * Used by:
 *  - the public blog routes (`/$blogSlug`, `/$blogSlug/$contentSlug`) when the
 *    blog/content is unknown, not published, or reserved — the loaders set a
 *    real HTTP 404 before throwing `notFound()`;
 *  - the catch-all route (`/$`) for any path the app does not handle;
 *  - the root route's `notFoundComponent` and the router's
 *    `defaultNotFoundComponent`, so no route ever falls back to a bare
 *    `<div>Page not found</div>`.
 *
 * It always links back to the site root, and to a blog home when we know one.
 */
export function NotFoundPage({
  title = "Page not found",
  message = "The page you are looking for does not exist, or it is not published.",
  blog,
}: {
  title?: string;
  message?: string;
  /** When the blog is known, offer a link back to its home. */
  blog?: { name: string; slug: string } | null;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-white text-neutral-900">
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-20 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-400">404</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-neutral-600">{message}</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <a
            href="/"
            className="rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-800"
          >
            Go to the site home
          </a>
          {blog ? (
            <a
              href={`/${blog.slug}`}
              className="rounded-md border border-neutral-300 px-5 py-2.5 text-sm font-medium text-neutral-700 hover:border-neutral-400"
            >
              Back to {blog.name}
            </a>
          ) : null}
        </div>
      </main>
    </div>
  );
}
