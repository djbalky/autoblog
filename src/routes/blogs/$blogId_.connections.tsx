/**
 * Autonoblog — /blogs/$blogId/connections : the same Connections panel scoped to
 * one blog. Blog-scoped credentials override the workspace ones for that blog
 * only; a non-member gets the real 403 panel.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { currentUserAction } from "../../server/rpc/auth";
import {
  connectionsLoadAction,
  type ConnectionsPageData,
} from "../../server/rpc/integrations";
import { ConnectionsPanel } from "../../components/integrations/ConnectionsPanel";

export const Route = createFileRoute("/blogs/$blogId_/connections")({
  loader: async ({ params }): Promise<ConnectionsPageData> => {
    const { user } = await currentUserAction();
    if (!user) throw redirect({ to: "/login" });
    return connectionsLoadAction({ data: { blogId: Number(params.blogId) } });
  },
  component: BlogConnectionsRoute,
});

function BlogConnectionsRoute() {
  const data = Route.useLoaderData();
  if (data.forbidden || !data.blog) {
    return (
      <main className="min-h-dvh bg-neutral-50 px-6 py-20">
        <div className="mx-auto max-w-lg rounded-lg border border-neutral-200 bg-white p-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">403</p>
          <h1 className="mt-1 text-xl font-bold text-neutral-900">Blog not available to you</h1>
          <p className="mt-2 text-sm text-neutral-600">
            Either this blog does not exist, or you are not a member of it. Connections are scoped
            to blog members in the database, so nothing is shown here.
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
  return <ConnectionsPanel data={data} />;
}
