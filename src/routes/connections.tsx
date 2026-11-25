/**
 * Autonoblog — /connections : the workspace Connections screen (Phase 6b-prep).
 *
 * The loader resolves the session server-side and hands the provider cards, the
 * masked secrets and the text-model state to the client component. Saving,
 * testing and disconnecting all go through the server RPCs in
 * src/server/rpc/integrations.ts — nothing here is a mock.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { currentUserAction } from "../server/rpc/auth";
import {
  connectionsLoadAction,
  type ConnectionsPageData,
} from "../server/rpc/integrations";
import { ConnectionsPanel } from "../components/integrations/ConnectionsPanel";

export const Route = createFileRoute("/connections")({
  loader: async (): Promise<ConnectionsPageData> => {
    const { user } = await currentUserAction();
    if (!user) throw redirect({ to: "/login" });
    return connectionsLoadAction({ data: { blogId: null } });
  },
  component: ConnectionsRoute,
});

function ConnectionsRoute() {
  const data = Route.useLoaderData();
  if (data.forbidden) {
    return (
      <main className="min-h-dvh bg-neutral-50 px-6 py-20">
        <div className="mx-auto max-w-lg rounded-lg border border-neutral-200 bg-white p-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">403</p>
          <h1 className="mt-1 text-xl font-bold text-neutral-900">Connections not available</h1>
          <p className="mt-2 text-sm text-neutral-600">
            Connections are scoped to the signed-in account in the database, so nothing is shown
            here.
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
