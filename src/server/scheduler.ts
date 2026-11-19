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
import { getModelProviderState, notConfiguredReason } from "./ai/modelProvider";
import {
  listEnabledAutomations,
  markAutomationEnqueued,
  timeToMinutes,
} from "./dal/automations";
import { createContentJob } from "./dal/contentJobs";

/** The single row name this worker owns in `scheduler_state`. */
export const WORKER_NAME = "publishing";

/** The automation half of the worker writes its own heartbeat row. */
export const AUTOMATION_WORKER_NAME = "automation";

/** How often the worker looks for due posts (the brief asks for at least once a minute). */
export const TICK_INTERVAL_MS = 30_000;

/** How many minutes after a publish slot the automation still counts it as due. */
const SLOT_WINDOW_MINUTES = 3;

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
  /** Phase 6a: what the automation half of the same tick did (honestly). */
  automation: AutomationTickResult;
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

  // Phase 6a: the same tick also asks each enabled blog whether an automation
  // slot is due. This never fabricates anything (see tickAutomation).
  const automation = await tickAutomation(now).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[scheduler] automation tick failed:", message);
    return {
      at: now,
      checked: 0,
      due: 0,
      enqueued: [],
      skipped: [],
      providerConfigured: false,
      note: `Automation tick failed: ${message}`,
    } satisfies AutomationTickResult;
  });

  if (published.length > 0) {
    console.log(
      `[scheduler] published ${String(published.length)} scheduled post(s): ` +
        published.map((p) => `#${String(p.id)} "${p.title}"`).join(", ")
    );
  }
  return { at: now, durationMs, published, automation, error };
}

// ---- Phase 6a: the automation half of the tick ----------------------------

export interface AutomationTickResult {
  at: string;
  /** Enabled automations on live blogs the tick looked at. */
  checked: number;
  /** How many of those had a publishing slot due at `at`. */
  due: number;
  /** Jobs really inserted by this tick (each one is a real content_jobs row). */
  enqueued: { blogId: number; jobId: number; topic: string }[];
  /** Due blogs where nothing was enqueued, with the honest reason why. */
  skipped: { blogId: number; reason: string }[];
  /** Whether a text-model key was present for this tick. */
  providerConfigured: boolean;
  /** One sentence describing the tick, written to the heartbeat row verbatim. */
  note: string;
}

/** UTC "YYYY-MM-DD" of an ISO instant — the day bucket for the daily cap. */
function utcDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** Minutes since UTC midnight for an ISO instant. */
function utcMinutes(iso: string): number {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 0;
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** How many jobs this blog already has for the UTC day of `now`. */
async function jobsCreatedToday(blogId: number, now: string): Promise<number> {
  const dayStart = `${utcDay(now)}T00:00:00.000Z`;
  const row = await get<{ n: unknown }>(
    "SELECT COUNT(*) AS n FROM content_jobs WHERE blog_id = ? AND created_at >= ?",
    blogId,
    dayStart
  );
  return num(row?.n);
}

/**
 * One automation pass. Honesty rules:
 *  - A slot is "due" only inside a small window after its HH:MM (UTC, the same
 *    clock the times are stored in), so a restart does not backfill a whole day.
 *  - Nothing is enqueued unless a text-model provider is really configured
 *    (`getModelProviderState()`), because a job that no agent can ever pick up
 *    would be a lie in the queue. The reason is written to the heartbeat row and
 *    logged, so the UI can show exactly why a due slot produced no job.
 *  - It never writes a post, a revision or a result: it can only insert a
 *    ContentJob row in `queued`.
 */
export async function tickAutomation(
  now: string = nowIso()
): Promise<AutomationTickResult> {
  const result: AutomationTickResult = {
    at: now,
    checked: 0,
    due: 0,
    enqueued: [],
    skipped: [],
    providerConfigured: false,
    note: "",
  };

  await ensureInitialized();
  const provider = getModelProviderState();
  result.providerConfigured = provider.configured;

  const configs = await listEnabledAutomations();
  result.checked = configs.length;
  const nowMinutes = utcMinutes(now);

  for (const config of configs) {
    // Is any configured slot due right now?
    const dueSlot = config.publishTimes.find((time) => {
      const minutes = timeToMinutes(time);
      const delta = nowMinutes - minutes;
      if (delta < 0 || delta > SLOT_WINDOW_MINUTES) return false;
      // Already enqueued for this slot today?
      const slotIso = `${utcDay(now)}T${time}:00.000Z`;
      return !config.lastEnqueuedAt || config.lastEnqueuedAt < slotIso;
    });
    if (!dueSlot) continue;
    result.due += 1;

    if (!provider.configured) {
      result.skipped.push({ blogId: config.blogId, reason: notConfiguredReason() });
      continue;
    }
    const created = await jobsCreatedToday(config.blogId, now);
    if (created >= config.postsPerDay) {
      result.skipped.push({
        blogId: config.blogId,
        reason: `Daily limit reached (${String(created)}/${String(config.postsPerDay)} jobs today).`,
      });
      continue;
    }
    if (config.topics.length === 0) {
      result.skipped.push({
        blogId: config.blogId,
        reason: "No topics configured — add at least one topic on the automation screen.",
      });
      continue;
    }
    const topic = config.topics[created % config.topics.length];
    const job = await createContentJob(config.blogId, {
      status: "queued",
      topic,
      brief: `Enqueued by the automation worker for the ${dueSlot} UTC slot.`,
    });
    await markAutomationEnqueued(config.blogId, now);
    result.enqueued.push({ blogId: config.blogId, jobId: job.id, topic });
  }

  result.note = buildAutomationNote(result, provider.message);
  await writeHeartbeat({
    at: now,
    publishedCount: result.enqueued.length,
    error: "",
    name: AUTOMATION_WORKER_NAME,
    note: result.note,
  }).catch((err) => {
    console.error(
      "[scheduler] automation heartbeat write failed:",
      err instanceof Error ? err.message : err
    );
  });
  if (result.enqueued.length > 0) {
    console.log(
      `[scheduler] automation enqueued ${String(result.enqueued.length)} job(s): ` +
        result.enqueued.map((e) => `blog #${String(e.blogId)} -> job #${String(e.jobId)}`).join(", ")
    );
  } else if (result.due > 0) {
    console.log(`[scheduler] automation: ${result.note}`);
  }
  return result;
}

/** One honest sentence for the heartbeat row and the UI. */
function buildAutomationNote(result: AutomationTickResult, providerMessage: string): string {
  if (result.checked === 0) {
    return "No blog has automation enabled — nothing was due.";
  }
  if (result.due === 0) {
    return `${String(result.checked)} enabled blog(s) checked; no publishing slot was due at ${result.at}.`;
  }
  if (result.enqueued.length === 0) {
    const reasons = Array.from(new Set(result.skipped.map((s) => s.reason)));
    return `${String(result.due)} slot(s) due, 0 job(s) enqueued: ${reasons.join(" ")}`;
  }
  return `${String(result.enqueued.length)} job(s) enqueued for ${String(
    result.due
  )} due slot(s). ${providerMessage}`;
}

/** Rewrite one worker heartbeat row (start + every tick). */
async function writeHeartbeat(input: {
  at: string;
  publishedCount: number;
  error: string;
  started?: boolean;
  /** Which heartbeat row to write; defaults to the publishing worker. */
  name?: string;
  /** Free-text note shown verbatim in the UI (Phase 6a). */
  note?: string;
}): Promise<void> {
  const pid = typeof process !== "undefined" && process ? process.pid : 0;
  await run(
    `INSERT INTO scheduler_state
       (name, instance_id, pid, started_at, last_tick_at, last_published, last_error, interval_seconds, last_note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET
       instance_id = excluded.instance_id,
       pid = excluded.pid,
       last_tick_at = excluded.last_tick_at,
       last_published = excluded.last_published,
       last_error = excluded.last_error,
       interval_seconds = excluded.interval_seconds,
       last_note = excluded.last_note,
       updated_at = excluded.updated_at`,
    input.name ?? WORKER_NAME,
    INSTANCE_ID,
    pid,
    BOOT_AT,
    input.at,
    input.publishedCount,
    input.error,
    Math.round(TICK_INTERVAL_MS / 1000),
    input.note ?? "",
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
  /** Free-text note the last tick wrote (Phase 6a automation reason, …). */
  lastNote: string;
  /** Age of the heartbeat in seconds, null when there is none. */
  heartbeatAgeSeconds: number | null;
  /** True when the worker writes to the same database this page reads. */
  heartbeatPresent: boolean;
}

/** Read the heartbeat row and turn it into a state the UI can show truthfully. */
export async function getSchedulerState(): Promise<SchedulerState> {
  const row = await get<Record<string, unknown>>(
    "SELECT instance_id, pid, started_at, last_tick_at, last_published, last_error, interval_seconds, last_note FROM scheduler_state WHERE name = ?",
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
    lastNote: str(row?.last_note),
    heartbeatAgeSeconds: ageSeconds,
    heartbeatPresent: Boolean(row),
  };
}

export interface AutomationWorkerState {
  /** True when the automation heartbeat is fresh — the same worker process. */
  running: boolean;
  lastTickAt: string | null;
  /** Jobs the last automation tick really enqueued. */
  lastEnqueued: number;
  /** The last tick's own sentence: what it checked and why nothing happened. */
  note: string;
  /** The last tick's error, "" when it succeeded. */
  lastError: string;
  heartbeatAgeSeconds: number | null;
  heartbeatPresent: boolean;
  intervalSeconds: number;
}

/**
 * The automation half of the worker's heartbeat — the honest answer to
 * "did the scheduler look at my blog, and what did it decide?".
 */
export async function getAutomationWorkerState(): Promise<AutomationWorkerState> {
  const row = await get<Record<string, unknown>>(
    "SELECT last_tick_at, last_published, last_error, last_note, interval_seconds FROM scheduler_state WHERE name = ?",
    AUTOMATION_WORKER_NAME
  );
  const intervalSeconds = num(row?.interval_seconds) || Math.round(TICK_INTERVAL_MS / 1000);
  const lastTickAt = str(row?.last_tick_at) || null;
  const lastMs = lastTickAt ? new Date(lastTickAt).getTime() : NaN;
  const ageSeconds = Number.isNaN(lastMs) ? null : Math.max(0, Math.round((Date.now() - lastMs) / 1000));
  return {
    running: ageSeconds !== null && ageSeconds <= intervalSeconds * STALE_FACTOR,
    lastTickAt,
    lastEnqueued: num(row?.last_published),
    note: str(row?.last_note),
    lastError: str(row?.last_error),
    heartbeatAgeSeconds: ageSeconds,
    heartbeatPresent: Boolean(row),
    intervalSeconds,
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
