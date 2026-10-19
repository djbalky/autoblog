/**
 * Autonoblog — /blogs/$blogId/pages : the pages list route.
 *
 * `$blogId_` keeps this a sibling of `/blogs/$blogId` (the blog overview is its
 * own page, not an outlet). The loader resolves session + membership
 * server-side; a non-member gets the real 403 panel below.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { currentUserAction } from "../../server/rpc/auth";
import { pagesIndexAction } from "../../server/rpc/pages";
import { PagesList } from "../../components/pages/PagesList";
import type { PagesIndexData } from "../../server/rpc/pages";

export const Route = createFileRoute("/blogs/$blogId_/pages")({
  loader: async ({ params }): Promise<PagesIndexData> => {
    const { user } = await currentUserAction();
    if (!user) throw redirect({ to: "/login" });
    return pagesIndexAction({ data: { blogId: Number(params.blogId) } });
  },
  component: PagesRoute,
});

function PagesRoute() {
  const data = Route.useLoaderData();
  if (data.forbidden || !data.blog) {
    return (
      <main className="min-h-dvh bg-neutral-50 px-6 py-20">
        <div className="mx-auto max-w-lg rounded-lg border border-neutral-200 bg-white p-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">403</p>
          <h1 className="mt-1 text-xl font-bold text-neutral-900">Pages unavailable</h1>
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
  return (
    <PagesList blog={data.blog} role={data.role ?? "member"} pages={data.pages} counts={data.counts} />
  );
}
