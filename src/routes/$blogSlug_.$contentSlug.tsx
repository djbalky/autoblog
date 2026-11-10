/**
 * Autonoblog — PUBLIC ARTICLE / PAGE at `/<blog-slug>/<slug>` (Phase 5c, SEO in 5d).
 *
 * One route serves both content types, rendered with the SAME block renderer
 * the editor preview uses (`RenderBlocks` in "public" mode), so what an author
 * previews is what a visitor reads.
 *
 * Resolution is deterministic (see `getPublicContent` in dal/publicSite.ts):
 * a PUBLISHED POST wins; a published page is used only when no published post
 * has that slug. Draft, pending, scheduled and trashed rows of either type are
 * excluded in SQL, so they answer the same real 404 as a slug that never
 * existed.
 *
 * SEO (Phase 5d): `head()` emits title, description, canonical, Open Graph
 * (`og:type=article` plus published time/author), a Twitter card and JSON-LD —
 * all from the real row and from the ORIGIN of the current request (the loader
 * reads it, so it is the visitor's host, never a hardcoded domain). The JSON-LD
 * goes in through the router's `script:ld+json` meta, which JSON-escapes it, so
 * a title can never break out of the `<script>`.
 */
import { createFileRoute, notFound } from "@tanstack/react-router";
import { publicContentAction } from "~/server/rpc/public";
import type { PublicContent } from "~/server/dal/publicSite";
import { setHttpStatus } from "~/server/httpStatus";
import { currentOrigin } from "~/server/origin";
import { isReservedSlug } from "~/lib/reservedSlugs";
import { absoluteImage, absoluteUrl, isoDate, metaDescription } from "~/lib/seoMeta";
import { RenderBlocks } from "~/components/blocks/renderBlocks";
import { PublicShell, formatDate } from "~/components/public/PublicShell";
import { NotFoundPage } from "~/components/public/NotFoundPage";

/** The content plus the origin of this request (for absolute URLs). */
type ContentLoaderData = PublicContent & { origin: string };

export const Route = createFileRoute("/$blogSlug_/$contentSlug")({
  loader: async ({ params }): Promise<ContentLoaderData> => {
    if (isReservedSlug(params.blogSlug)) {
      await setHttpStatus(404);
      throw notFound();
    }
    const res = await publicContentAction({
      data: { blogSlug: params.blogSlug, slug: params.contentSlug },
    });
    if (!res.found) {
      await setHttpStatus(404);
      throw notFound();
    }
    return { ...res.content, origin: await currentOrigin() };
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
    const content = loaderData;
    const blog = content.blog;
    const description = metaDescription(content.excerpt);
    const url = absoluteUrl(content.origin, `/${blog.slug}/${content.slug}`);
    const feed = absoluteUrl(content.origin, `/${blog.slug}/feed.xml`);
    const image = content.image ? absoluteImage(content.origin, content.image.url) : null;
    const published = isoDate(content.publishedAt);
    const modified = isoDate(content.updatedAt) || published;
    const isArticle = content.kind === "post";

    const jsonLd: Record<string, unknown> = isArticle
      ? {
          "@context": "https://schema.org",
          "@type": "BlogPosting",
          headline: content.title,
          ...(description ? { description } : {}),
          ...(published ? { datePublished: published } : {}),
          ...(modified ? { dateModified: modified } : {}),
          author: { "@type": "Person", name: content.authorName },
          ...(image ? { image: [image] } : {}),
          ...(url ? { mainEntityOfPage: { "@type": "WebPage", "@id": url } } : {}),
          publisher: { "@type": "Organization", name: blog.name },
          ...(url ? { url } : {}),
        }
      : {
          "@context": "https://schema.org",
          "@type": "WebPage",
          name: content.title,
          ...(description ? { description } : {}),
          ...(published ? { datePublished: published } : {}),
          ...(modified ? { dateModified: modified } : {}),
          isPartOf: { "@type": "Blog", name: blog.name },
          ...(url ? { url } : {}),
        };

    return {
      meta: [
        { title: `${content.title} — ${blog.name}` },
        ...(description ? [{ name: "description", content: description }] : []),
        { property: "og:type", content: isArticle ? "article" : "website" },
        { property: "og:title", content: content.title },
        ...(description ? [{ property: "og:description", content: description }] : []),
        { property: "og:site_name", content: blog.name },
        ...(url ? [{ property: "og:url", content: url }] : []),
        ...(image ? [{ property: "og:image", content: image }] : []),
        ...(image && content.image?.alt ? [{ property: "og:image:alt", content: content.image.alt }] : []),
        ...(isArticle && published ? [{ property: "article:published_time", content: published }] : []),
        ...(isArticle && modified ? [{ property: "article:modified_time", content: modified }] : []),
        ...(isArticle ? [{ property: "article:author", content: content.authorName }] : []),
        { name: "twitter:card", content: image ? "summary_large_image" : "summary" },
        { name: "twitter:title", content: content.title },
        ...(description ? [{ name: "twitter:description", content: description }] : []),
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
      title="Article not found"
      message="This article or page is not published. It may have been unpublished, moved, or never existed at this address."
    />
  ),
  component: ContentRoute,
});

function ContentRoute() {
  const content = Route.useLoaderData();
  const { blog } = content;
  const published = formatDate(content.publishedAt);

  return (
    <PublicShell blog={blog}>
      <article>
        <nav className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          <a href={`/${blog.slug}`} className="hover:text-emerald-700">
            {blog.name}
          </a>
          {content.kind === "page" ? <span> · Page</span> : null}
        </nav>

        <h1 className="mt-3 text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
          {content.title}
        </h1>
        <p className="mt-3 flex flex-wrap items-center gap-x-2 text-sm text-neutral-500">
          {published ? <time dateTime={content.publishedAt}>{published}</time> : null}
          {published ? <span aria-hidden="true">·</span> : null}
          <span>By {content.authorName}</span>
        </p>

        {content.excerpt ? (
          <p className="mt-6 border-l-4 border-emerald-200 pl-4 text-base italic leading-7 text-neutral-600">
            {content.excerpt}
          </p>
        ) : null}

        <div className="mt-8">
          <RenderBlocks blocks={content.blocks} mode="public" />
        </div>
      </article>
    </PublicShell>
  );
}
