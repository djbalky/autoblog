/**
 * Autonoblog — /blogs/$blogId/pages/$pageId : the page builder route.
 *
 * `$pageId` may be the literal `new`, which loads an empty builder that writes
 * a real `pages` row when the author creates the draft.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { currentUserAction } from "../../server/rpc/auth";
import { pageEditorLoadAction } from "../../server/rpc/pages";
import { PageBuilder } from "../../components/pages/PageBuilder";
import type { PageEditorData } from "../../server/rpc/pages";

export const Route = createFileRoute("/blogs/$blogId_/pages_/$pageId")({
  loader: async ({ params }): Promise<PageEditorData> => {
    const { user } = await currentUserAction();
    if (!user) throw redirect({ to: "/login" });
    const raw = String(params.pageId);
    return pageEditorLoadAction({
      data: {
        blogId: Number(params.blogId),
        pageId: raw === "new" ? null : Number(raw),
      },
    });
  },
  component: BuilderRoute,
});

function BuilderRoute() {
  const data = Route.useLoaderData();
  const { pageId } = Route.useParams();
  if (data.forbidden || !data.blog) {
    return (
      <main className="min-h-dvh bg-neutral-50 px-6 py-20">
        <div className="mx-auto max-w-lg rounded-lg border border-neutral-200 bg-white p-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">403</p>
          <h1 className="mt-1 text-xl font-bold text-neutral-900">Page builder unavailable</h1>
          <p className="mt-2 text-sm text-neutral-600">
            This blog either does not exist or you are not one of its members — page rows are
            filtered by blog membership in the database.
          </p>
          <a
            href="/dashboard"
            className="mt-5 inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white"
          >
            Back to dashboard
          </a>
        </div>
      </main>
    );
  }
  // A real page id that resolved to nothing (deleted, or in another blog).
  if (data.page === null && String(pageId) !== "new") {
    return (
      <main className="min-h-dvh bg-neutral-50 px-6 py-20">
        <div className="mx-auto max-w-lg rounded-lg border border-neutral-200 bg-white p-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">404</p>
          <h1 className="mt-1 text-xl font-bold text-neutral-900">Page not found</h1>
          <p className="mt-2 text-sm text-neutral-600">
            This page does not exist in this blog (it may have been deleted, or it belongs to a
            different blog).
          </p>
          <a
            href={`/blogs/${data.blog.id}/pages`}
            className="mt-5 inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white"
          >
            Back to pages
          </a>
        </div>
      </main>
    );
  }
  return (
    <PageBuilder
      blog={data.blog}
      role={data.role ?? "member"}
      page={data.page}
      revisions={data.revisions}
    />
  );
}
