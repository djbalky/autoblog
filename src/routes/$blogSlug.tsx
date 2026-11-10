/**
 * Autonoblog — PUBLIC BLOG HOME at `/<blog-slug>` (Phase 5c, SEO in 5d).
 *
 * Server-rendered from the database: the blog's name/tagline/description plus
 * its published posts, newest first, one page at a time (PUBLIC_PAGE_SIZE = 6)
 * with a real "showing X–Y of N" line and prev/next links that are built from
 * the real total.
 *
 * Visibility rules (enforced in SQL, see src/server/dal/publicSite.ts):
 *  - the blog must be `active` — a draft/archived blog is a 404;
 *  - only posts with `status = 'published'` and a real, non-future
 *    `published_at` are listed.
 *
 * SEO (Phase 5d): `head()` emits title, description, a self-referencing
 * canonical, Open Graph (`og:type=website`) and a Twitter card, plus JSON-LD
 * `Blog` — all from the real blog row, its real posts and the ORIGIN of the
 * current request. `og:image` is only emitted when the newest published post
 * really has an image.
 *
 * A blog slug that is reserved by the app (`/login`, `/dashboard`, …) or a slug
 * with no active blog behind it answers a real HTTP 404 through the styled
 * NotFoundPage — never an empty blog shell.
 */
import { createFileRoute, notFound } from "@tanstack/react-router";
import { publicBlogHomeAction } from "~/server/rpc/public";
import type { PublicBlogHome } from "~/server/dal/publicSite";
import { setHttpStatus } from "~/server/httpStatus";
import { currentOrigin } from "~/server/origin";
import { isReservedSlug } from "~/lib/reservedSlugs";
import { absoluteImage, absoluteUrl, isoDate, metaDescription } from "~/lib/seoMeta";
import { PublicShell, PostCard } from "~/components/public/PublicShell";
import { NotFoundPage } from "~/components/public/NotFoundPage";

interface BlogHomeSearch {
  /** Absent on the canonical `/<slug>` URL; only present for older/newer pages. */
  page?: number;
}

/** The blog home payload plus the origin of this request (for absolute URLs). */
type HomeLoaderData = PublicBlogHome & { origin: string };

export const Route = createFileRoute("/$blogSlug")({
  // `page` stays optional so the canonical blog URL is exactly `/<blog-slug>`
  // (a required-with-default param makes the router redirect `/blog` to
  // `/blog?page=1`, which would be a needless extra hop for every visitor).
  validateSearch: (search: Record<string, unknown>): BlogHomeSearch => {
    const n = Number(search.page);
    if (!Number.isFinite(n) || n < 2) return {};
    return { page: Math.floor(n) };
  },
  loaderDeps: ({ search }): BlogHomeSearch => ({ page: search.page }),
  loader: async ({ params, deps }): Promise<HomeLoaderData> => {
    if (isReservedSlug(params.blogSlug)) {
      await setHttpStatus(404);
      throw notFound();
    }
    const res = await publicBlogHomeAction({
      data: { blogSlug: params.blogSlug, page: deps.page ?? 1 },
    });
    if (!res.found) {
      await setHttpStatus(404);
      throw notFound();
    }
    return { ...res.home, origin: await currentOrigin() };
  },
  head: ({ loaderData }) => {
    if (!loaderData) {
      return {
        meta: [
          { title: "Page not found — Autonoblog" },
          { name: "robots", content: "noindex" },
        ],
      };
    }
    const home = loaderData;
    const blog = home.blog;
    const description = metaDescription(
      blog.description.trim() || blog.tagline.trim() || `${blog.name} on Autonoblog.`
    );
    const path = home.page > 1 ? `/${blog.slug}?page=${String(home.page)}` : `/${blog.slug}`;
    const url = absoluteUrl(home.origin, path);
    const feed = absoluteUrl(home.origin, `/${blog.slug}/feed.xml`);
    const lead = home.posts.find((p) => p.image)?.image ?? null;
    const image = lead ? absoluteImage(home.origin, lead.url) : null;

    const jsonLd: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "Blog",
      name: blog.name,
      ...(description ? { description } : {}),
      ...(url ? { url } : {}),
      ...(feed ? { "@id": feed } : {}),
      publisher: { "@type": "Organization", name: blog.name },
      // The newest published posts on this page — real rows only.
      ...(home.posts.length
        ? {
            blogPost: home.posts.map((post) => ({
              "@type": "BlogPosting",
              headline: post.title,
              ...(absoluteUrl(home.origin, `/${blog.slug}/${post.slug}`)
                ? { url: absoluteUrl(home.origin, `/${blog.slug}/${post.slug}`) }
                : {}),
              ...(isoDate(post.publishedAt) ? { datePublished: isoDate(post.publishedAt) } : {}),
            })),
          }
        : {}),
    };

    return {
      meta: [
        { title: blog.tagline.trim() ? `${blog.name} — ${blog.tagline.trim()}` : blog.name },
        { name: "description", content: description },
        { property: "og:type", content: "website" },
        { property: "og:title", content: blog.name },
        { property: "og:description", content: description },
        { property: "og:site_name", content: blog.name },
        ...(url ? [{ property: "og:url", content: url }] : []),
        ...(image ? [{ property: "og:image", content: image }] : []),
        { name: "twitter:card", content: image ? "summary_large_image" : "summary" },
        { name: "twitter:title", content: blog.name },
        { name: "twitter:description", content: description },
        ...(image ? [{ name: "twitter:image", content: image }] : []),
        { "script:ld+json": jsonLd },
      ],
      links: [
        ...(url ? [{ rel: "canonical", href: url }] : []),
        ...(feed
          ? [{ rel: "alternate", type: "application/rss+xml", title: `${blog.name} feed`, href: feed }]
          : []),
      ],
    };
  },
  notFoundComponent: () => (
    <NotFoundPage
      title="Blog not found"
      message="There is no published blog at this address. It may have been renamed, archived, or never existed."
    />
  ),
  component: BlogHomeRoute,
});

function BlogHomeRoute() {
  const home = Route.useLoaderData();
  const { blog, posts, total, page, totalPages } = home;
  const first = total === 0 ? 0 : (page - 1) * home.pageSize + 1;
  const last = (page - 1) * home.pageSize + posts.length;
  const href = (p: number) => (p <= 1 ? `/${blog.slug}` : `/${blog.slug}?page=${p}`);
  // One contiguous string so the count reads as a sentence in the HTML.
  const countLine =
    `Showing ${String(first)}–${String(last)} of ${String(total)} published post${total === 1 ? "" : "s"}` +
    (totalPages > 1 ? ` · page ${String(page)} of ${String(totalPages)}` : "");

  return (
    <PublicShell blog={blog}>
      <header className="border-b border-neutral-200 pb-8">
        <h1 className="text-4xl font-bold tracking-tight">{blog.name}</h1>
        {blog.tagline ? (
          <p className="mt-2 text-lg text-neutral-600">{blog.tagline}</p>
        ) : null}
        {blog.description ? (
          <p className="mt-3 max-w-2xl text-sm leading-6 text-neutral-600">{blog.description}</p>
        ) : null}
      </header>

      {posts.length === 0 ? (
        <section className="mt-10 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-6 py-16 text-center">
          <h2 className="text-base font-semibold text-neutral-800">No published posts yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-neutral-600">
            This blog is live, but nothing has been published here yet. Articles appear here the
            moment they are published.
          </p>
        </section>
      ) : (
        <>
          <section className="mt-8 space-y-8">
            {posts.map((post) => (
              <PostCard key={post.id} blog={blog} post={post} />
            ))}
          </section>

          <nav
            aria-label="Post pagination"
            className="mt-8 flex flex-wrap items-center justify-between gap-3 text-sm"
          >
            <p className="text-neutral-500">{countLine}</p>
            <div className="flex gap-2">
              {page > 1 ? (
                <a
                  href={href(page - 1)}
                  rel="prev"
                  className="rounded-md border border-neutral-300 px-3 py-1.5 font-medium text-neutral-700 hover:border-neutral-400"
                >
                  ← Newer posts
                </a>
              ) : null}
              {page < totalPages ? (
                <a
                  href={href(page + 1)}
                  rel="next"
                  className="rounded-md border border-neutral-300 px-3 py-1.5 font-medium text-neutral-700 hover:border-neutral-400"
                >
                  Older posts →
                </a>
              ) : null}
            </div>
          </nav>
        </>
      )}
    </PublicShell>
  );
}
