/**
 * Autonoblog — the publishing scheduler panel (Phase 5e).
 *
 * Small, honest, read-only panel shown on a blog's posts screen:
 *  - whether the in-process publishing worker is really running (from its
 *    heartbeat row, not from a guess),
 *  - when it last ticked,
 *  - which of this blog's posts are queued, with the real instants they are due.
 *
 * There is nothing to click: the worker runs inside the site's own server
 * process (see src/server/scheduler.ts). If it is not running the panel says so
 * plainly instead of showing a "scheduled" success that will never happen.
 */
import type { QueuedPost, SchedulerState } from "../../server/scheduler";

/** ISO text -> "2026-11-05 14:03 UTC" (no locale/timezone drift on hydration). */
function fmtUtc(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function fmtAge(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 60) return `${String(seconds)}s ago`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ago`;
  return `${String(Math.floor(seconds / 3600))}h ago`;
}

export function SchedulerPanel({
  scheduler,
  queue,
  blogSlug,
  blogId,
}: {
  scheduler: SchedulerState;
  queue: QueuedPost[];
  blogSlug: string;
  blogId: number;
}) {
  const running = scheduler.running;
  return (
    <section className="mb-6 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-neutral-900 dark:text-white">Publishing scheduler</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            The publishing worker runs inside the site&apos;s server process and checks for due
            posts every {scheduler.intervalSeconds}s.
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${
            running
              ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-500/30"
              : "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-500/30"
          }`}
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${running ? "bg-emerald-500" : "bg-amber-500"}`}
          />
          {running ? "Worker running" : "Worker not running"}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-neutral-600 sm:grid-cols-4 dark:text-neutral-400">
        <div>
          <dt className="font-medium text-neutral-500 dark:text-neutral-500">Last tick</dt>
          <dd>
            {scheduler.lastTickAt ? fmtUtc(scheduler.lastTickAt) : "never"}
            <span className="text-neutral-400"> ({fmtAge(scheduler.heartbeatAgeSeconds)})</span>
          </dd>
        </div>
        <div>
          <dt className="font-medium text-neutral-500 dark:text-neutral-500">Worker started</dt>
          <dd>{fmtUtc(scheduler.startedAt)}</dd>
        </div>
        <div>
          <dt className="font-medium text-neutral-500 dark:text-neutral-500">Published last tick</dt>
          <dd>{scheduler.lastPublished}</dd>
        </div>
        <div>
          <dt className="font-medium text-neutral-500 dark:text-neutral-500">Queued here</dt>
          <dd>{queue.length}</dd>
        </div>
      </dl>

      {!running && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {scheduler.heartbeatPresent
            ? `No heartbeat for ${fmtAge(scheduler.heartbeatAgeSeconds)} — the worker has stopped, so scheduled posts will NOT go live on their own until the site's server is running again (the worker starts with it).`
            : "The worker has never ticked in this database, so scheduled posts will NOT go live on their own. It starts together with the site's server process."}
        </p>
      )}

      {scheduler.lastError && (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          Last tick error: {scheduler.lastError}
        </p>
      )}

      <div className="mt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Scheduled posts
        </h3>
        {queue.length === 0 ? (
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            Nothing is scheduled. A post you schedule in the editor appears here with the instant it
            will be published.
          </p>
        ) : (
          <ul className="mt-1 divide-y divide-neutral-100 text-xs dark:divide-neutral-800">
            {queue.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <a
                  href={`/blogs/${String(blogId)}/posts/${String(item.id)}`}
                  className="font-medium text-neutral-800 underline-offset-2 hover:underline dark:text-neutral-200"
                >
                  {item.title}
                </a>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-neutral-400 dark:text-neutral-500">
                    /{blogSlug}/{item.slug}
                  </span>
                  <span className={item.overdue ? "text-amber-700 dark:text-amber-300" : "text-neutral-500 dark:text-neutral-400"}>
                    {item.dueAt
                      ? `${fmtUtc(item.dueAt)}${item.overdue ? " — due now, next tick publishes it" : ""}`
                      : "no time set — will not publish"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
