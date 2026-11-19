/**
 * Autonoblog — /blogs/$blogId/jobs : the ContentJob list route.
 *
 * `$blogId_` keeps this route a sibling of `/blogs/$blogId` (no outlet). The
 * loader resolves the session + membership; a non-member sees the 403 panel.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { currentUserAction } from "../../server/rpc/auth";
import { jobsIndexAction, type JobsIndexData } from "../../server/rpc/automation";
import { JobsList } from "../../components/automation/JobsList";

export const Route = createFileRoute("/blogs/$blogId_/jobs")({
  loader: async ({ params }): Promise<JobsIndexData> => {
    const { user } = await currentUserAction();
    if (!user) throw redirect({ to: "/login" });
    return jobsIndexAction({ data: { blogId: Number(params.blogId) } });
  },
  component: JobsRoute,
});

function JobsRoute() {
  const data = Route.useLoaderData();
  if (data.forbidden || !data.blog) {
    return (
      <main className="min-h-dvh bg-neutral-50 px-6 py-20">
        <div className="mx-auto max-w-lg rounded-lg border border-neutral-200 bg-white p-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">403</p>
          <h1 className="mt-1 text-xl font-bold text-neutral-900">Blog not available to you</h1>
          <p className="mt-2 text-sm text-neutral-600">
            Either this blog does not exist, or you are not a member of it. Jobs are scoped to blog
            members in the database, so nothing is listed here.
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
    <JobsList
      blog={data.blog}
      role={data.role ?? "member"}
      canManage={data.canManage}
      jobs={data.jobs}
      provider={data.provider}
      worker={data.worker}
    />
  );
}
