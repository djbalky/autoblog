/**
 * Autonoblog — /blogs/:blogId/jobs : the ContentJob list (Phase 6a).
 *
 * Reads real `content_jobs` rows and lets a permitted member insert ONE real row
 * in `queued` status. It never claims a job is progressing: with no AI provider
 * configured the new row stays queued and the screen says exactly why.
 */
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { createJobAction } from "../../server/rpc/automation";
import type { ContentJobRow } from "../../server/dal/contentJobs";
import type { ModelProviderState } from "../../server/ai/modelProvider";
import type { AutomationWorkerState } from "../../server/scheduler";
import { ProviderBanner } from "./ProviderBanner";

const STATUS_BADGE: Record<string, string> = {
  queued: "bg-neutral-100 text-neutral-700 ring-neutral-400/40",
  research: "bg-sky-50 text-sky-700 ring-sky-600/20",
  brief: "bg-sky-50 text-sky-700 ring-sky-600/20",
  draft: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
  fact_check: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
  seo: "bg-violet-50 text-violet-700 ring-violet-600/20",
  edit: "bg-violet-50 text-violet-700 ring-violet-600/20",
  media: "bg-violet-50 text-violet-700 ring-violet-600/20",
  internal_links: "bg-violet-50 text-violet-700 ring-violet-600/20",
  approval: "bg-amber-50 text-amber-700 ring-amber-600/20",
  publish: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  social: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  done: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  failed: "bg-red-50 text-red-700 ring-red-600/20",
  canceled: "bg-neutral-100 text-neutral-500 ring-neutral-400/30",
};

function badge(status: string): string {
  return STATUS_BADGE[status] ?? "bg-neutral-100 text-neutral-600 ring-neutral-400/30";
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export interface JobsListProps {
  blog: { id: number; name: string; slug: string };
  role: string;
  canManage: boolean;
  jobs: ContentJobRow[];
  provider: ModelProviderState;
  worker: AutomationWorkerState;
}

export function JobsList({ blog, role, canManage, jobs, provider, worker }: JobsListProps) {
  const [rows, setRows] = useState<ContentJobRow[]>(jobs);
  const [topic, setTopic] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await createJobAction({ data: { blogId: blog.id, topic, brief } });
    setBusy(false);
    if (!res.ok || !res.data) {
      setError(res.error ?? "The job could not be created.");
      return;
    }
    const job = res.data;
    setRows((current) => [job, ...current]);
    setTopic("");
    setBrief("");
    setNotice(
      provider.configured
        ? `Job #${String(job.id)} created in 'queued'. The agent runner (Phase 6b) has not picked it up yet, so its status is unchanged.`
        : `Job #${String(job.id)} created in 'queued'. It will stay queued: AI provider not configured (${provider.requiredEnvVar} missing), so no agent can run it.`
    );
  }

  return (
    <main className="min-h-dvh bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">Jobs</p>
            <h1 className="truncate text-lg font-bold text-neutral-900">{blog.name}</h1>
            <p className="truncate font-mono text-xs text-neutral-500">/{blog.slug}</p>
          </div>
          <nav className="flex flex-wrap items-center gap-2 text-sm">
            <Link
              to="/blogs/$blogId"
              params={{ blogId: String(blog.id) }}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-700 hover:bg-neutral-50"
            >
              ← Blog overview
            </Link>
            <Link
              to="/blogs/$blogId/posts"
              params={{ blogId: String(blog.id) }}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-700 hover:bg-neutral-50"
            >
              Posts
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

      <div className="mx-auto max-w-6xl px-6 py-8">
        <ProviderBanner provider={provider} />

        <section className="mb-6 rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="text-sm font-bold text-neutral-900">Create a job manually</h2>
          <p className="mt-1 text-xs text-neutral-500">
            This inserts one real <span className="font-mono">content_jobs</span> row in{" "}
            <span className="font-mono">queued</span>. Nothing runs it yet — a job only moves when a
            real agent run moves it.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-neutral-800">
              <span className="font-medium">Topic</span>
              <input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                disabled={!canManage}
                placeholder="e.g. how to start strength training at 40"
                className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
              />
            </label>
            <label className="text-sm text-neutral-800">
              <span className="font-medium">Brief (optional)</span>
              <input
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                disabled={!canManage}
                placeholder="angle, sources, must-mention points"
                className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={create}
              disabled={!canManage || busy || topic.trim().length < 3}
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create job"}
            </button>
            <span className="text-xs text-neutral-500">
              {canManage
                ? "A job needs a topic of at least 3 characters."
                : `Your role (${role}) cannot create jobs — that needs automation.manage.`}
            </span>
          </div>
          {error && (
            <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
          {notice && (
            <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              {notice}
            </p>
          )}
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-4 py-3">
            <h2 className="text-sm font-bold text-neutral-900">
              Content jobs <span className="font-normal text-neutral-500">({rows.length})</span>
            </h2>
            {worker.note && (
              <p className="text-[11px] text-neutral-500">Scheduler: {worker.note}</p>
            )}
          </div>

          {rows.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-medium text-neutral-700">No jobs yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-neutral-500">
                This blog has zero rows in <span className="font-mono">content_jobs</span>. Create
                one above, or enable automation — the scheduler only enqueues when an AI provider is
                configured.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                    <th className="px-4 py-2.5 font-medium">Job</th>
                    <th className="px-4 py-2.5 font-medium">Topic</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Agent</th>
                    <th className="px-4 py-2.5 font-medium">Started</th>
                    <th className="px-4 py-2.5 font-medium">Deadline</th>
                    <th className="px-4 py-2.5 font-medium">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((job) => (
                    <tr
                      key={job.id}
                      className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50/70"
                    >
                      <td className="px-4 py-3">
                        <Link
                          to="/blogs/$blogId/jobs/$jobId"
                          params={{ blogId: String(blog.id), jobId: String(job.id) }}
                          className="font-medium text-neutral-900 hover:text-emerald-700 hover:underline"
                        >
                          #{job.id}
                        </Link>
                      </td>
                      <td className="max-w-[18rem] px-4 py-3 text-neutral-700">
                        {job.topic || <span className="text-neutral-400">(no topic)</span>}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={
                            "rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset " +
                            badge(job.status)
                          }
                        >
                          {job.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-neutral-600">
                        {job.current_agent ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-neutral-600">{fmt(job.started_at)}</td>
                      <td className="px-4 py-3 text-neutral-600">{fmt(job.deadline)}</td>
                      <td className="max-w-[16rem] px-4 py-3 text-xs text-neutral-600">
                        {job.error ? (
                          <span className="text-red-700">{job.error}</span>
                        ) : job.result ? (
                          <span className="line-clamp-2">{job.result.slice(0, 160)}</span>
                        ) : (
                          <span className="text-neutral-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
