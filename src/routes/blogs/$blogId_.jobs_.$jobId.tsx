/**
 * Autonoblog — /blogs/$blogId/jobs/$jobId : one ContentJob with its real timeline.
 *
 * A job id from another blog (or a non-member) comes back as a real "not found",
 * never as somebody else's job.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { currentUserAction } from "../../server/rpc/auth";
import { jobDetailAction, type JobDetailData } from "../../server/rpc/automation";
import { JobDetail } from "../../components/automation/JobDetail";

export const Route = createFileRoute("/blogs/$blogId_/jobs_/$jobId")({
  loader: async ({ params }): Promise<JobDetailData> => {
    const { user } = await currentUserAction();
    if (!user) throw redirect({ to: "/login" });
    return jobDetailAction({
      data: { blogId: Number(params.blogId), jobId: Number(params.jobId) },
    });
  },
  component: JobDetailRoute,
});

function JobDetailRoute() {
  const data = Route.useLoaderData();
  if (data.forbidden || !data.blog) {
    return (
      <main className="min-h-dvh bg-neutral-50 px-6 py-20">
        <div className="mx-auto max-w-lg rounded-lg border border-neutral-200 bg-white p-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">403</p>
          <h1 className="mt-1 text-xl font-bold text-neutral-900">Blog not available to you</h1>
          <p className="mt-2 text-sm text-neutral-600">
            Either this blog does not exist, or you are not a member of it.
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
    <JobDetail
      blog={data.blog}
      role={data.role ?? "member"}
      job={data.job}
      events={data.events}
      agentRuns={data.agentRuns}
      provider={data.provider}
      worker={data.worker}
    />
  );
}
