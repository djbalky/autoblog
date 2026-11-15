/**
 * Autonoblog — the publishing engine worker (Phase 5e).
 *
 * The editor has always been able to store `status='scheduled'` with a
 * `scheduled_at`. Nothing ever acted on it, so a scheduled post never went live.
 * This module is the missing half: a real worker that runs INSIDE the live
 * server process (there is no cron here — `startPublishingScheduler()` is called
 * once by `serve.ts` at start-up) and flips due rows to `published`.
 *
 * Honesty rules this file follows:
 *  - It only ever reports posts it really updated. The claim is a single atomic
 *    `UPDATE posts SET status='published' … WHERE status='scheduled' AND due
 *    RETURNING id` — the database decides, once per row, so two overlapping
 *    ticks (or two server instances) can never publish the same post twice.
 *    That atomic UPDATE is the ONLY concurrency guard; no advisory lock is used
 *    (Neon's HTTP driver is stateless, so a session-level lock would not hold).
 *  - It never touches drafts, trashed rows, or rows whose due time is still in
 *    the future: all excluded by that same WHERE clause.
 *  - Every publish writes the same `activity_logs` row a manual publish writes,
 *    with `user_id = NULL` (no human did it) and the scheduled instant in the
 *    detail, so the audit trail says exactly what happened and why.
 *  - The heartbeat row in `scheduler_state` is written only by this worker, so
 *    the admin panel can say "running / last tick N seconds ago" truthfully — and
 *    can say "not running" when it is not.
 *
 * Scope: posts. Pages also carry a `scheduled` status, but the autonomous
 * publishing pipeline (and therefore this worker) is about articles; a scheduled
 * page stays scheduled until a human publishes it. Documented, not hidden.
 */
import { all, get, run, nowIso } from "./store";
import { ensureInitialized } from "./init";
import { logActivity } from "./dal/activity";

/** The single row name this worker owns in `scheduler_state`. */
export const WORKER_NAME = "publishing";

/** How often the worker looks for due posts (the brief asks for at least once a minute). */
export const TICK_INTERVAL_MS = 30_000;

/** A heartbeat older than this many intervals means the worker is NOT running. */
const STALE_FACTOR = 3;

/** This process's identity, written into the heartbeat row. */
const INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** When this worker instance started (constant for the life of the process). */
const BOOT_AT = nowIso();

export interface PublishedByWorker {
  id: number;
  blogId: number;
  title: string;
  slug: string;
  scheduledAt: string;
}

export interface TickResult {
  at: string;
  durationMs: number;
  published: PublishedByWorker[];
  error: string;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

/**
 * One tick: publish every scheduled post that is due, then record the heartbeat.
 *
 * The UPDATE is atomic by itself: each row is claimed by exactly one tick, and
 * `RETURNING` tells us precisely which rows this tick published. `published_at`
 * becomes the real instant the post went live (not the planned one) — the
 * planned instant stays in `scheduled_at`.
 */
export async function tickPublishing(now: string = nowIso()): Promise<TickResult> {
  const startedAt = Date.now();
  const published: PublishedByWorker[] = [];
  let error = "";

  try {
    await ensureInitialized();
    const rows = await all<Record<string, unknown>>(
      `UPDATE posts
          SET status = 'published', published_at = ?, updated_at = ?
        WHERE status = 'scheduled'
          AND COALESCE(NULLIF(scheduled_at, ''), published_at) IS NOT NULL
          AND COALESCE(NULLIF(scheduled_at, ''), published_at) <= ?
        RETURNING id, blog_id, title, slug, scheduled_at`,
      now,
      now,
      now
    );

    for (const row of rows) {
      const item: PublishedByWorker = {
        id: num(row.id),
        blogId: num(row.blog_id),
        title: str(row.title),
        slug: str(row.slug),
        scheduledAt: str(row.scheduled_at),
      };
      published.push(item);
      // Same audit row a manual publish writes, with no user id: nobody clicked.
      await logActivity({
        userId: null,
        blogId: item.blogId,
        action: "post.published",
        entityType: "post",
        entityId: item.id,
        detail: item.scheduledAt
          ? `Published by the publishing worker (scheduled for ${item.scheduledAt})`
          : "Published by the publishing worker",
      });
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error("[scheduler] tick failed:", error);
  }

  const durationMs = Date.now() - startedAt;
  await writeHeartbeat({ at: now, publishedCount: published.length, error }).catch((err) => {
    console.error("[scheduler] heartbeat write failed:", err instanceof Error ? err.message : err);
  });

  if (published.length > 0) {
    console.log(
      `[scheduler] published ${String(published.length)} scheduled post(s): ` +
        published.map((p) => `#${String(p.id)} "${p.title}"`).join(", ")
    );
  }
  return { at: now, durationMs, published, error };
}

/** Rewrite the worker's single heartbeat row (start + every tick). */
async function writeHeartbeat(input: {
  at: string;
  publishedCount: number;
  error: string;
  started?: boolean;
}): Promise<void> {
  const pid = typeof process !== "undefined" && process ? process.pid : 0;
  await run(
    `INSERT INTO scheduler_state
       (name, instance_id, pid, started_at, last_tick_at, last_published, last_error, interval_seconds, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET
       instance_id = excluded.instance_id,
       pid = excluded.pid,
       last_tick_at = excluded.last_tick_at,
       last_published = excluded.last_published,
       last_error = excluded.last_error,
       interval_seconds = excluded.interval_seconds,
       updated_at = excluded.updated_at`,
    WORKER_NAME,
    INSTANCE_ID,
    pid,
    BOOT_AT,
    input.at,
    input.publishedCount,
    input.error,
    Math.round(TICK_INTERVAL_MS / 1000),
    nowIso()
  );
}

// ---- Worker lifecycle ------------------------------------------------------

let started = false;
let ticking = false;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the in-process worker. Idempotent: calling it twice in one process does
 * nothing the second time. A slow tick never stacks — the next interval is
 * skipped while one is in flight, and a failed tick is caught so the worker
 * survives it and tries again.
 */
export function startPublishingScheduler(): void {
  if (started) return;
  started = true;

  const boot = nowIso();
  void writeHeartbeat({ at: boot, publishedCount: 0, error: "", started: true }).catch(() => {
    // The first tick below retries the heartbeat; a DB that is down at boot is
    // not a reason to take the web server down with it.
  });
  console.log(
    `[scheduler] publishing worker started (pid ${String(process.pid)}, every ${String(
      Math.round(TICK_INTERVAL_MS / 1000)
    )}s)`
  );

  const runOnce = (): void => {
    if (ticking) return; // never run two ticks concurrently
    ticking = true;
    void tickPublishing()
      .catch((err) => {
        console.error("[scheduler] unexpected tick error:", err instanceof Error ? err.message : err);
      })
      .finally(() => {
        ticking = false;
      });
  };

  runOnce();
  timer = setInterval(runOnce, TICK_INTERVAL_MS);
  // Do not hold a short-lived process (a script that imports this module) open.
  (timer as unknown as { unref?: () => void }).unref?.();
}

/** Stop the worker (used by smoke scripts; the server never stops it). */
export function stopPublishingScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

// ---- Honest state for the admin UI ----------------------------------------

export interface SchedulerState {
  /** True only when a heartbeat was written within STALE_FACTOR intervals. */
  running: boolean;
  /** The last tick the worker really recorded, or null when it never ticked. */
  lastTickAt: string | null;
  /** When the running worker instance started. */
  startedAt: string | null;
  /** Process id of the worker that wrote the heartbeat. */
  pid: number | null;
  /** Seconds between ticks, as the worker recorded it. */
  intervalSeconds: number;
  /** How many posts the last tick published. */
  lastPublished: number;
  /** The error the last tick hit, "" when it succeeded. */
  lastError: string;
  /** Age of the heartbeat in seconds, null when there is none. */
  heartbeatAgeSeconds: number | null;
  /** True when the worker writes to the same database this page reads. */
  heartbeatPresent: boolean;
}

/** Read the heartbeat row and turn it into a state the UI can show truthfully. */
export async function getSchedulerState(): Promise<SchedulerState> {
  const row = await get<Record<string, unknown>>(
    "SELECT instance_id, pid, started_at, last_tick_at, last_published, last_error, interval_seconds FROM scheduler_state WHERE name = ?",
    WORKER_NAME
  );
  const intervalSeconds = num(row?.interval_seconds) || Math.round(TICK_INTERVAL_MS / 1000);
  const lastTickAt = str(row?.last_tick_at) || null;
  const lastMs = lastTickAt ? new Date(lastTickAt).getTime() : NaN;
  const ageSeconds = Number.isNaN(lastMs) ? null : Math.max(0, Math.round((Date.now() - lastMs) / 1000));
  return {
    running: ageSeconds !== null && ageSeconds <= intervalSeconds * STALE_FACTOR,
    lastTickAt,
    startedAt: str(row?.started_at) || null,
    pid: row?.pid == null ? null : num(row.pid),
    intervalSeconds,
    lastPublished: num(row?.last_published),
    lastError: str(row?.last_error),
    heartbeatAgeSeconds: ageSeconds,
    heartbeatPresent: Boolean(row),
  };
}

export interface QueuedPost {
  id: number;
  title: string;
  slug: string;
  /** The instant the worker will publish it (scheduled_at, else published_at). */
  dueAt: string;
  /** True when the due instant has already passed but the row is still scheduled. */
  overdue: boolean;
}

/**
 * The posts this blog has queued for the worker, soonest first — read from the
 * real rows, membership-scoped like every other member query.
 */
export async function listQueuedPostsForMember(
  blogId: number,
  userId: number,
  now: string = nowIso()
): Promise<QueuedPost[]> {
  const rows = await all<Record<string, unknown>>(
    `SELECT p.id, p.title, p.slug,
            COALESCE(NULLIF(p.scheduled_at, ''), p.published_at) AS due_at
       FROM posts p
       JOIN blog_members bm ON bm.blog_id = p.blog_id AND bm.user_id = ?
      WHERE p.blog_id = ? AND p.status = 'scheduled'
      ORDER BY due_at ASC, p.id ASC`,
    userId,
    blogId
  );
  return rows.map((r) => {
    const dueAt = str(r.due_at);
    const dueMs = dueAt ? new Date(dueAt).getTime() : NaN;
    return {
      id: num(r.id),
      title: str(r.title),
      slug: str(r.slug),
      dueAt,
      overdue: !Number.isNaN(dueMs) && dueMs <= new Date(now).getTime(),
    };
  });
}
