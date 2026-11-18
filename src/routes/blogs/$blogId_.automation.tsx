/**
 * Autonoblog — /blogs/$blogId/automation : per-blog automation settings.
 *
 * The loader resolves the session + membership server-side and hands the saved
 * config, the model provider's real state and the worker's last check to the
 * client component. A non-member gets the real 403 panel below.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { currentUserAction } from "../../server/rpc/auth";
import { automationLoadAction, type AutomationPageData } from "../../server/rpc/automation";
import { AutomationSettings } from "../../components/automation/AutomationSettings";

export const Route = createFileRoute("/blogs/$blogId_/automation")({
  loader: async ({ params }): Promise<AutomationPageData> => {
    const { user } = await currentUserAction();
    if (!user) throw redirect({ to: "/login" });
    return automationLoadAction({ data: { blogId: Number(params.blogId) } });
  },
  component: AutomationRoute,
});

function AutomationRoute() {
  const data = Route.useLoaderData();
  if (data.forbidden || !data.blog) {
    return (
      <main className="min-h-dvh bg-neutral-50 px-6 py-20">
        <div className="mx-auto max-w-lg rounded-lg border border-neutral-200 bg-white p-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">403</p>
          <h1 className="mt-1 text-xl font-bold text-neutral-900">Blog not available to you</h1>
          <p className="mt-2 text-sm text-neutral-600">
            Either this blog does not exist, or you are not a member of it. Automation settings are
            scoped to blog members in the database, so nothing is shown here.
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
    <AutomationSettings
      blog={data.blog}
      role={data.role ?? "member"}
      canManage={data.canManage}
      config={data.config}
      provider={data.provider}
      worker={data.worker}
      jobsToday={data.jobsToday}
    />
  );
}
