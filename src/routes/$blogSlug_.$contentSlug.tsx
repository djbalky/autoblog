/**
 * Autonoblog — PUBLIC ARTICLE / PAGE at `/<blog-slug>/<slug>` (Phase 5c).
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
 */
import { createFileRoute, notFound } from "@tanstack/react-router";
import { publicContentAction } from "~/server/rpc/public";
import type { PublicContent } from "~/server/dal/publicSite";
import { setHttpStatus } from "~/server/httpStatus";
import { isReservedSlug } from "~/lib/reservedSlugs";
import { RenderBlocks } from "~/components/blocks/renderBlocks";
import { PublicShell, formatDate } from "~/components/public/PublicShell";
import { NotFoundPage } from "~/components/public/NotFoundPage";

export const Route = createFileRoute("/$blogSlug_/$contentSlug")({
  loader: async ({ params }): Promise<PublicContent> => {
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
    return res.content;
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
    const description = loaderData.excerpt.trim().slice(0, 160);
    return {
      meta: [
        { title: `${loaderData.title} — ${loaderData.blog.name}` },
        ...(description ? [{ name: "description", content: description }] : []),
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
