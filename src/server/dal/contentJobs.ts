/**
 * Autonoblog — DAL: ContentJob pipeline tracking.
 *
 * A ContentJob is one autonomous run from research to published (+ social):
 *
 *   ContentJob -> AgentRuns -> Post -> PostRevision -> Publish -> SocialPosts
 *
 * This module owns the ContentJob row, its status transitions and its event
 * audit trail. It does NOT run any agent: Phase 6 adds the agents that call
 * these functions. Nothing here fakes progress — a status only moves when a
 * caller (a real agent run, or an operator action) moves it.
 */
import { all, get, run, nowIso } from "../store";

/** The documented pipeline order. Index order is the progression order. */
export const CONTENT_JOB_PIPELINE = [
  "research",
  "brief",
  "draft",
  "fact_check",
  "seo",
  "edit",
  "media",
  "internal_links",
  "approval",
  "publish",
  "social",
  "done",
] as const;

export type ContentJobStatus =
  | (typeof CONTENT_JOB_PIPELINE)[number]
  | "failed"
  | "canceled";

/** Statuses that end a job; no further transition is allowed from them. */
export const TERMINAL_JOB_STATUSES: ContentJobStatus[] = [
  "done",
  "failed",
  "canceled",
];

/** The agent that normally owns each pipeline step. */
export const STEP_AGENT: Record<string, string> = {
  research: "research",
  brief: "topic_keyword",
  draft: "writer",
  fact_check: "fact_check",
  seo: "seo",
  edit: "editor",
  media: "image_media",
  internal_links: "internal_linking",
  approval: "publisher",
  publish: "publisher",
  social: "social_distribution",
  done: "publisher",
};

export interface ContentJobRow {
  id: number;
  blog_id: number;
  target_post_id: number | null;
  status: ContentJobStatus;
  current_agent: string | null;
  started_at: string;
  deadline: string | null;
  result: string;
  error: string;
  created_at: string;
  updated_at: string;
}

export interface ContentJobEventRow {
  id: number;
  job_id: number;
  agent: string | null;
  action: string;
  detail: string;
  created_at: string;
}

function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function mapJob(row: Record<string, unknown>): ContentJobRow {
  return {
    id: toNum(row.id),
    blog_id: toNum(row.blog_id),
    target_post_id:
      row.target_post_id === null || row.target_post_id === undefined
        ? null
        : toNum(row.target_post_id),
    status: String(row.status ?? "research") as ContentJobStatus,
    current_agent:
      row.current_agent === null || row.current_agent === undefined
        ? null
        : String(row.current_agent),
    started_at: String(row.started_at ?? ""),
    deadline:
      row.deadline === null || row.deadline === undefined
        ? null
        : String(row.deadline),
    result: String(row.result ?? ""),
    error: String(row.error ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

/** Serialise a step result: strings are stored as-is, objects as JSON. */
function serializeResult(result: unknown): string {
  if (result === undefined) return "";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

async function addEvent(
  jobId: number,
  agent: string | null,
  action: string,
  detail = ""
): Promise<void> {
  await run(
    `INSERT INTO content_job_events (job_id, agent, action, detail, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    jobId,
    agent,
    action,
    detail,
    nowIso()
  );
}

// ---- Reads -----------------------------------------------------------------

export async function getContentJob(
  jobId: number
): Promise<ContentJobRow | null> {
  const row = await get<Record<string, unknown>>(
    "SELECT * FROM content_jobs WHERE id = ?",
    jobId
  );
  return row ? mapJob(row) : null;
}

/** Jobs newest first, optionally scoped to one blog. */
export async function listContentJobs(blogId?: number): Promise<ContentJobRow[]> {
  const rows = blogId
    ? await all<Record<string, unknown>>(
        "SELECT * FROM content_jobs WHERE blog_id = ? ORDER BY created_at DESC, id DESC",
        blogId
      )
    : await all<Record<string, unknown>>(
        "SELECT * FROM content_jobs ORDER BY created_at DESC, id DESC"
      );
  return rows.map(mapJob);
}

/** Audit trail for one job, oldest first. */
export async function listContentJobEvents(
  jobId: number
): Promise<ContentJobEventRow[]> {
  const rows = await all<Record<string, unknown>>(
    "SELECT * FROM content_job_events WHERE job_id = ? ORDER BY created_at ASC, id ASC",
    jobId
  );
  return rows.map((r) => ({
    id: toNum(r.id),
    job_id: toNum(r.job_id),
    agent:
      r.agent === null || r.agent === undefined ? null : String(r.agent),
    action: String(r.action ?? ""),
    detail: String(r.detail ?? ""),
    created_at: String(r.created_at ?? ""),
  }));
}

/** Agent runs attributed to a job (the ContentJob -> AgentRuns edge). */
export async function listAgentRunsForJob(
  jobId: number
): Promise<Record<string, unknown>[]> {
  return all<Record<string, unknown>>(
    "SELECT * FROM agent_runs WHERE content_job_id = ? ORDER BY started_at ASC, id ASC",
    jobId
  );
}

// ---- Writes ----------------------------------------------------------------

/**
 * Create a job in the `research` status. `targetPostId` stays null until a post
 * exists (see linkContentJobPost). Records a `created` event.
 */
export async function createContentJob(
  blogId: number,
  input: { targetPostId?: number | null; deadline?: string | null; agent?: string } = {}
): Promise<ContentJobRow> {
  const now = nowIso();
  const agent = input.agent ?? STEP_AGENT.research;
  const info = await run(
    `INSERT INTO content_jobs
       (blog_id, target_post_id, status, current_agent, started_at, deadline,
        result, error, created_at, updated_at)
     VALUES (?, ?, 'research', ?, ?, ?, '', '', ?, ?)`,
    blogId,
    input.targetPostId ?? null,
    agent,
    now,
    input.deadline ?? null,
    now,
    now
  );
  const jobId = info.lastInsertRowid;
  await addEvent(jobId, agent, "created", `status=research`);
  const job = await getContentJob(jobId);
  if (!job) throw new Error("createContentJob: row not found after insert");
  return job;
}

/**
 * Whether `from -> to` is a legal transition:
 *  - any non-terminal status may go to `failed` or `canceled`;
 *  - otherwise the job may move forward along CONTENT_JOB_PIPELINE (skipping
 *    steps is allowed, because a configured pipeline can start at `draft`);
 *  - it may never move backwards, and never out of a terminal status.
 * Exported so callers/tests can explain a rejection instead of guessing.
 */
export function canAdvance(from: ContentJobStatus, to: ContentJobStatus): boolean {
  if (TERMINAL_JOB_STATUSES.includes(from)) return false;
  if (to === "failed" || to === "canceled") return true;
  const fi = CONTENT_JOB_PIPELINE.indexOf(from as (typeof CONTENT_JOB_PIPELINE)[number]);
  const ti = CONTENT_JOB_PIPELINE.indexOf(to as (typeof CONTENT_JOB_PIPELINE)[number]);
  if (fi === -1 || ti === -1) return false;
  return ti > fi;
}

/**
 * Move a job to `nextStatus`, recording which agent did it and (optionally) the
 * step result. Throws on an illegal transition (see canAdvance) rather than
 * silently writing a bogus status. `result` is stored as JSON when it is an
 * object, verbatim when it is a string.
 */
export async function advanceContentJob(
  jobId: number,
  nextStatus: ContentJobStatus,
  agent: string,
  result?: unknown
): Promise<ContentJobRow> {
  const job = await getContentJob(jobId);
  if (!job) throw new Error(`ContentJob ${jobId} not found`);
  if (job.status === nextStatus) {
    throw new Error(`ContentJob ${jobId} is already in status '${nextStatus}'`);
  }
  if (!canAdvance(job.status, nextStatus)) {
    throw new Error(
      `Illegal ContentJob transition: '${job.status}' -> '${nextStatus}' (pipeline: ${CONTENT_JOB_PIPELINE.join(" -> ")})`
    );
  }
  const now = nowIso();
  const isTerminal = TERMINAL_JOB_STATUSES.includes(nextStatus);
  if (result === undefined) {
    await run(
      `UPDATE content_jobs
          SET status = ?, current_agent = ?, updated_at = ?
        WHERE id = ?`,
      nextStatus,
      // A finished job is owned by nobody; keep the last agent on the event log.
      isTerminal && nextStatus === "done" ? null : agent,
      now,
      jobId
    );
  } else {
    await run(
      `UPDATE content_jobs
          SET status = ?, current_agent = ?, result = ?, updated_at = ?
        WHERE id = ?`,
      nextStatus,
      isTerminal && nextStatus === "done" ? null : agent,
      serializeResult(result),
      now,
      jobId
    );
  }
  await addEvent(
    jobId,
    agent,
    `advance:${nextStatus}`,
    result === undefined ? `${job.status} -> ${nextStatus}` : serializeResult(result)
  );
  const updated = await getContentJob(jobId);
  if (!updated) throw new Error(`ContentJob ${jobId} vanished during update`);
  return updated;
}

/** Mark a job failed with the real error message (kept on the row). */
export async function failContentJob(
  jobId: number,
  error: string
): Promise<ContentJobRow> {
  const job = await getContentJob(jobId);
  if (!job) throw new Error(`ContentJob ${jobId} not found`);
  if (TERMINAL_JOB_STATUSES.includes(job.status)) {
    throw new Error(
      `ContentJob ${jobId} is already terminal ('${job.status}') and cannot fail`
    );
  }
  const now = nowIso();
  await run(
    `UPDATE content_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
    error,
    now,
    jobId
  );
  await addEvent(jobId, job.current_agent, "failed", error);
  const updated = await getContentJob(jobId);
  if (!updated) throw new Error(`ContentJob ${jobId} vanished during update`);
  return updated;
}

/** Cancel a job (operator action) without marking it an error. */
export async function cancelContentJob(
  jobId: number,
  reason = ""
): Promise<ContentJobRow> {
  const job = await getContentJob(jobId);
  if (!job) throw new Error(`ContentJob ${jobId} not found`);
  if (TERMINAL_JOB_STATUSES.includes(job.status)) {
    throw new Error(
      `ContentJob ${jobId} is already terminal ('${job.status}') and cannot be canceled`
    );
  }
  const now = nowIso();
  await run(
    `UPDATE content_jobs SET status = 'canceled', current_agent = NULL, updated_at = ? WHERE id = ?`,
    now,
    jobId
  );
  await addEvent(jobId, job.current_agent, "canceled", reason);
  const updated = await getContentJob(jobId);
  if (!updated) throw new Error(`ContentJob ${jobId} vanished during update`);
  return updated;
}

/** Attach the post a job is producing (nullable until the draft exists). */
export async function linkContentJobPost(
  jobId: number,
  postId: number
): Promise<void> {
  await run(
    "UPDATE content_jobs SET target_post_id = ?, updated_at = ? WHERE id = ?",
    postId,
    nowIso(),
    jobId
  );
  await addEvent(jobId, null, "linked_post", `post_id=${postId}`);
}

/**
 * Attribute an agent run to a job (the ContentJob -> AgentRuns edge). Returns
 * false when the agent run id does not exist, so the caller can report that
 * honestly instead of assuming success.
 */
export async function linkAgentRun(
  jobId: number,
  agentRunId: number
): Promise<boolean> {
  const res = await run(
    "UPDATE agent_runs SET content_job_id = ? WHERE id = ?",
    jobId,
    agentRunId
  );
  if (res.changes === 0) return false;
  await addEvent(jobId, null, "linked_agent_run", `agent_run_id=${agentRunId}`);
  return true;
}
