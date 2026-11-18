/**
 * Autonoblog — /blogs/:blogId/jobs/:jobId : one ContentJob (Phase 6a).
 *
 * Shows the job row as the database holds it plus its real timeline:
 *  - `content_job_events` rows (what actually happened, oldest first),
 *  - `agent_runs` rows attributed to this job (none until Phase 6b runs agents).
 *
 * No invented steps: a pipeline stage that has not happened is not drawn as if
 * it had. The next stage is named only as "waiting", with the reason.
 */
import { Link } from "@tanstack/react-router";
import type {
  AgentRunSummary,
  ContentJobEventRow,
  ContentJobRow,
} from "../../server/dal/contentJobs";
import type { ModelProviderState } from "../../server/ai/modelProvider";
import type { AutomationWorkerState } from "../../server/scheduler";
import { ProviderBanner } from "./ProviderBanner";

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export interface JobDetailProps {
  blog: { id: number; name: string; slug: string };
  role: string;
  job: ContentJobRow | null;
  events: ContentJobEventRow[];
  agentRuns: AgentRunSummary[];
  provider: ModelProviderState;
  worker: AutomationWorkerState;
}

export function JobDetail({
  blog,
  role,
  job,
  events,
  agentRuns,
  provider,
  worker,
}: JobDetailProps) {
  return (
    <main className="min-h-dvh bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">
              Content job
            </p>
            <h1 className="truncate text-lg font-bold text-neutral-900">
              {job ? `#${String(job.id)} · ${job.topic || "(no topic)"}` : "Job not found"}
            </h1>
            <p className="truncate font-mono text-xs text-neutral-500">/{blog.slug}</p>
          </div>
          <nav className="flex flex-wrap items-center gap-2 text-sm">
            <Link
              to="/blogs/$blogId/jobs"
              params={{ blogId: String(blog.id) }}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-700 hover:bg-neutral-50"
            >
              ← All jobs
            </Link>
            <Link
              to="/blogs/$blogId/automation"
              params={{ blogId: String(blog.id) }}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-700 hover:bg-neutral-50"
            >
              Automation
            </Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-8">
        <ProviderBanner provider={provider} />

        {!job ? (
          <div className="rounded-lg border border-neutral-200 bg-white p-10 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">404</p>
            <h2 className="mt-1 text-xl font-bold text-neutral-900">Job not found</h2>
            <p className="mt-2 text-sm text-neutral-600">
              No row in <span className="font-mono">content_jobs</span> with this id belongs to this
              blog.
            </p>
          </div>
        ) : (
          <>
            <section className="rounded-lg border border-neutral-200 bg-white p-6">
              <h2 className="text-sm font-bold text-neutral-900">Job row</h2>
              <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Status
                  </dt>
                  <dd className="font-mono text-neutral-900">{job.status}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Current agent
                  </dt>
                  <dd className="font-mono text-neutral-900">{job.current_agent ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Started
                  </dt>
                  <dd className="text-neutral-800">{fmt(job.started_at)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Deadline
                  </dt>
                  <dd className="text-neutral-800">{fmt(job.deadline)}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Topic
                  </dt>
                  <dd className="text-neutral-800">{job.topic || "—"}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Brief
                  </dt>
                  <dd className="whitespace-pre-wrap text-neutral-800">{job.brief || "—"}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Result
                  </dt>
                  <dd className="whitespace-pre-wrap font-mono text-xs text-neutral-800">
                    {job.result || "—"}
                  </dd>
                </div>
                {job.error && (
                  <div className="sm:col-span-2">
                    <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                      Error
                    </dt>
                    <dd className="text-sm text-red-700">{job.error}</dd>
                  </div>
                )}
                {job.target_post_id != null && (
                  <div className="sm:col-span-2">
                    <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                      Post
                    </dt>
                    <dd>
                      <Link
                        to="/blogs/$blogId/posts/$postId"
                        params={{
                          blogId: String(blog.id),
                          postId: String(job.target_post_id),
                        }}
                        className="text-neutral-900 underline underline-offset-2"
                      >
                        post #{job.target_post_id}
                      </Link>
                    </dd>
                  </div>
                )}
              </dl>

              {job.status === "queued" && (
                <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  This job is queued and nothing has run it.{" "}
                  {provider.configured
                    ? "A model key is present; the agent runner that consumes queued jobs ships in Phase 6b."
                    : `AI provider not configured (${provider.requiredEnvVar} missing) — jobs cannot run yet.`}
                </p>
              )}
              {worker.note && (
                <p className="mt-2 text-[11px] text-neutral-500">
                  Scheduler last check: {worker.note}
                </p>
              )}
            </section>

            <section className="mt-6 rounded-lg border border-neutral-200 bg-white p-6">
              <h2 className="text-sm font-bold text-neutral-900">
                Timeline <span className="font-normal text-neutral-500">({events.length} events)</span>
              </h2>
              {events.length === 0 ? (
                <p className="mt-2 text-sm text-neutral-500">
                  No events recorded for this job yet.
                </p>
              ) : (
                <ol className="mt-3 space-y-3">
                  {events.map((event) => (
                    <li key={event.id} className="flex gap-3">
                      <span
                        aria-hidden="true"
                        className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-neutral-400"
                      />
                      <div className="min-w-0">
                        <p className="text-sm text-neutral-900">
                          <span className="font-mono">{event.action}</span>
                          {event.agent ? (
                            <span className="text-neutral-500"> · agent {event.agent}</span>
                          ) : null}
                        </p>
                        {event.detail && (
                          <p className="break-words font-mono text-xs text-neutral-600">
                            {event.detail}
                          </p>
                        )}
                        <p className="text-[11px] text-neutral-400">{fmt(event.created_at)}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="mt-6 rounded-lg border border-neutral-200 bg-white p-6">
              <h2 className="text-sm font-bold text-neutral-900">
                Agent runs{" "}
                <span className="font-normal text-neutral-500">({agentRuns.length})</span>
              </h2>
              {agentRuns.length === 0 ? (
                <p className="mt-2 text-sm text-neutral-500">
                  No agent run is attributed to this job. Agents start writing runs in Phase 6b —
                  none are invented here.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-neutral-100 text-sm">
                  {agentRuns.map((run) => (
                    <li key={run.id} className="py-2">
                      <span className="font-mono text-xs text-neutral-900">
                        run #{run.id} · agent {run.agent_id} · {run.status}
                      </span>
                      <p className="text-xs text-neutral-600">
                        started {fmt(run.started_at)} · finished {fmt(run.finished_at)}
                      </p>
                      {run.log && (
                        <p className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-neutral-500">
                          {run.log}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <p className="mt-6 text-xs text-neutral-500">
              You are signed in as <b className="capitalize">{role}</b> of this blog.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
