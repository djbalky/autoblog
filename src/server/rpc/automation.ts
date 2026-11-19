/**
 * Autonoblog — server RPCs for Phase 6a: per-blog automation settings + the
 * ContentJob pipeline screens.
 *
 * Every handler resolves the session user and then goes through the
 * membership-scoped DAL, so a non-member gets `{ forbidden: true }` and the
 * route renders a real 403 panel. Nothing here invents a job, a status change or
 * an agent run: a job is only ever inserted as `queued`, and the screens show
 * the model provider's real state (`getModelProviderState()`).
 */
import { createServerFn } from "@tanstack/react-start";
import { requireUser } from "../auth-context";
import { ensureInitialized } from "../init";
import { getBlog, type BlogRow } from "../dal/blogs";
import { getBlogMembership } from "../dal/posts";
import {
  DEFAULT_AUTOMATION,
  getAutomationConfig,
  saveAutomationConfig,
  validateAutomationInput,
  type AutomationConfigRow,
  type AutomationInput,
} from "../dal/automations";
import {
  createContentJob,
  getContentJobForMember,
  listAgentRunsForJob,
  listContentJobEvents,
  listContentJobsForMember,
  type AgentRunSummary,
  type ContentJobEventRow,
  type ContentJobRow,
} from "../dal/contentJobs";
import {
  getAutomationWorkerState,
  type AutomationWorkerState,
} from "../scheduler";
import { getModelProviderState, type ModelProviderState } from "../ai/modelProvider";
import { ROLE_PERMISSIONS, type RoleName } from "../roles";

export interface ActionResult<T = unknown> {
  ok: boolean;
  error?: string;
  forbidden?: boolean;
  data?: T;
}

const NOT_MEMBER = "You are not a member of this blog.";

/** Does this blog role carry the `automation.manage` permission? */
export function canManageAutomation(role: string): boolean {
  const perms = ROLE_PERMISSIONS[role as RoleName];
  if (!perms) return false;
  return perms.includes("*") || perms.includes("automation.manage");
}

interface BlogIdInput {
  blogId: number;
}
const asBlogId = (d: unknown) => d as BlogIdInput;

export interface AutomationPageData {
  forbidden: boolean;
  blog: Pick<BlogRow, "id" | "name" | "slug"> | null;
  role: string | null;
  canManage: boolean;
  /** The saved row, or the defaults with `persisted: false`. */
  config: AutomationConfigRow;
  /** The model provider's real state — drives the NOT CONFIGURED banner. */
  provider: ModelProviderState;
  /** What the scheduler's automation half last did. */
  worker: AutomationWorkerState;
  /** Jobs this blog really has for the current UTC day. */
  jobsToday: number;
}

export const automationLoadAction = createServerFn()
  .validator(asBlogId)
  .handler(async ({ data }): Promise<AutomationPageData> => {
    await ensureInitialized();
    const user = await requireUser();
    const blogId = Number(data.blogId);
    const provider = getModelProviderState();
    const worker = await getAutomationWorkerState();
    const empty: AutomationPageData = {
      forbidden: true,
      blog: null,
      role: null,
      canManage: false,
      // The defaults, not a fake saved row: `persisted: false` says so.
      config: {
        ...DEFAULT_AUTOMATION,
        publishTimes: [...DEFAULT_AUTOMATION.publishTimes],
        topics: [],
        socialNetworks: [],
        blogId: Number.isFinite(blogId) ? blogId : 0,
        persisted: false,
        lastEnqueuedAt: null,
        updatedAt: null,
      },
      provider,
      worker,
      jobsToday: 0,
    };
    if (!Number.isFinite(blogId)) return empty;
    const blog = await getBlog(blogId);
    if (!blog) return empty;
    const membership = await getBlogMembership(blogId, user.id);
    if (!membership) return empty;
    const [config, jobs] = await Promise.all([
      getAutomationConfig(blogId),
      listContentJobsForMember(blogId, user.id),
    ]);
    const dayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    return {
      forbidden: false,
      blog: { id: blog.id, name: blog.name, slug: blog.slug },
      role: membership.role,
      canManage: canManageAutomation(membership.role),
      config,
      provider,
      worker,
      jobsToday: jobs.filter((job) => job.created_at >= dayStart).length,
    };
  });

interface SaveInput {
  blogId: number;
  config: Partial<AutomationInput>;
}
const asSave = (d: unknown) => d as SaveInput;

export const saveAutomationAction = createServerFn({ method: "POST" })
  .validator(asSave)
  .handler(async ({ data }): Promise<ActionResult<AutomationConfigRow>> => {
    await ensureInitialized();
    const user = await requireUser();
    const blogId = Number(data.blogId);
    const blog = await getBlog(blogId);
    if (!blog) return { ok: false, forbidden: true, error: NOT_MEMBER };
    const membership = await getBlogMembership(blogId, user.id);
    if (!membership) return { ok: false, forbidden: true, error: NOT_MEMBER };
    if (!canManageAutomation(membership.role)) {
      return {
        ok: false,
        forbidden: true,
        error: `Your role (${membership.role}) cannot change automation settings — that needs the automation.manage permission (owner or administrator).`,
      };
    }
    const validated = validateAutomationInput(data.config ?? {});
    if (!validated.ok) return { ok: false, error: validated.error };
    const saved = await saveAutomationConfig(blogId, validated.value);
    return { ok: true, data: saved };
  });

// ---- Jobs -----------------------------------------------------------------

export interface JobsIndexData {
  forbidden: boolean;
  blog: Pick<BlogRow, "id" | "name" | "slug"> | null;
  role: string | null;
  canManage: boolean;
  jobs: ContentJobRow[];
  provider: ModelProviderState;
  worker: AutomationWorkerState;
}

export const jobsIndexAction = createServerFn()
  .validator(asBlogId)
  .handler(async ({ data }): Promise<JobsIndexData> => {
    await ensureInitialized();
    const user = await requireUser();
    const blogId = Number(data.blogId);
    const provider = getModelProviderState();
    const worker = await getAutomationWorkerState();
    const empty: JobsIndexData = {
      forbidden: true,
      blog: null,
      role: null,
      canManage: false,
      jobs: [],
      provider,
      worker,
    };
    if (!Number.isFinite(blogId)) return empty;
    const blog = await getBlog(blogId);
    if (!blog) return empty;
    const membership = await getBlogMembership(blogId, user.id);
    if (!membership) return empty;
    const jobs = await listContentJobsForMember(blogId, user.id);
    return {
      forbidden: false,
      blog: { id: blog.id, name: blog.name, slug: blog.slug },
      role: membership.role,
      canManage: canManageAutomation(membership.role),
      jobs,
      provider,
      worker,
    };
  });

interface JobInput {
  blogId: number;
  jobId: number;
}
const asJob = (d: unknown) => d as JobInput;

export interface JobDetailData {
  forbidden: boolean;
  blog: Pick<BlogRow, "id" | "name" | "slug"> | null;
  role: string | null;
  job: ContentJobRow | null;
  events: ContentJobEventRow[];
  /** Real agent_runs rows attributed to this job (empty until agents exist). */
  agentRuns: AgentRunSummary[];
  provider: ModelProviderState;
  worker: AutomationWorkerState;
}

export const jobDetailAction = createServerFn()
  .validator(asJob)
  .handler(async ({ data }): Promise<JobDetailData> => {
    await ensureInitialized();
    const user = await requireUser();
    const blogId = Number(data.blogId);
    const provider = getModelProviderState();
    const worker = await getAutomationWorkerState();
    const empty: JobDetailData = {
      forbidden: true,
      blog: null,
      role: null,
      job: null,
      events: [],
      agentRuns: [],
      provider,
      worker,
    };
    if (!Number.isFinite(blogId) || !Number.isFinite(Number(data.jobId))) return empty;
    const blog = await getBlog(blogId);
    if (!blog) return empty;
    const membership = await getBlogMembership(blogId, user.id);
    if (!membership) return empty;
    const job = await getContentJobForMember(Number(data.jobId), blogId, user.id);
    const blogRef = { id: blog.id, name: blog.name, slug: blog.slug };
    if (!job) {
      return {
        forbidden: false,
        blog: blogRef,
        role: membership.role,
        job: null,
        events: [],
        agentRuns: [],
        provider,
        worker,
      };
    }
    const [events, agentRuns] = await Promise.all([
      listContentJobEvents(job.id),
      listAgentRunsForJob(job.id),
    ]);
    return {
      forbidden: false,
      blog: blogRef,
      role: membership.role,
      job,
      events,
      agentRuns,
      provider,
      worker,
    };
  });

interface CreateJobInput {
  blogId: number;
  topic: string;
  brief?: string;
}
const asCreateJob = (d: unknown) => d as CreateJobInput;

/**
 * Operator action: insert ONE real ContentJob row in `queued`. It does not run
 * anything — with no model provider the row stays `queued` and the screens say
 * why, which is exactly what the row reflects.
 */
export const createJobAction = createServerFn({ method: "POST" })
  .validator(asCreateJob)
  .handler(async ({ data }): Promise<ActionResult<ContentJobRow>> => {
    await ensureInitialized();
    const user = await requireUser();
    const blogId = Number(data.blogId);
    const blog = await getBlog(blogId);
    if (!blog) return { ok: false, forbidden: true, error: NOT_MEMBER };
    const membership = await getBlogMembership(blogId, user.id);
    if (!membership) return { ok: false, forbidden: true, error: NOT_MEMBER };
    if (!canManageAutomation(membership.role)) {
      return {
        ok: false,
        forbidden: true,
        error: `Your role (${membership.role}) cannot create jobs — that needs the automation.manage permission (owner or administrator).`,
      };
    }
    const topic = (data.topic ?? "").trim();
    if (topic.length < 3) {
      return { ok: false, error: "Give the job a topic of at least 3 characters." };
    }
    if (topic.length > 200) {
      return { ok: false, error: "Keep the topic under 200 characters." };
    }
    const job = await createContentJob(blogId, {
      status: "queued",
      topic,
      brief: (data.brief ?? "").trim().slice(0, 2000),
    });
    return { ok: true, data: job };
  });
