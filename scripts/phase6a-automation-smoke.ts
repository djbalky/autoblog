/**
 * Phase 6a smoke test — automation config + ContentJob pipeline, against the
 * LIVE database (Neon via DATABASE_URL; the SQLite dev fallback also works).
 *
 * What it proves, with real rows read back from the database:
 *   1. `blog_automations` starts absent (defaults, persisted:false), validates
 *      bad input, and a save round-trips every field through the DB.
 *   2. A manual "create job" writes ONE real `content_jobs` row in `queued`,
 *      with its topic/brief and its `created` event, and the list/detail reads
 *      it back — for a member only (a non-member gets null).
 *   3. With no text-model provider configured, a DUE automation slot enqueues
 *      NOTHING: no content_jobs row, no posts row, and the worker heartbeat
 *      records the honest reason naming the env var.
 *
 * Run: bun scripts/phase6a-automation-smoke.ts
 */
import { get, run, migrate, usingPostgres } from "../src/server/store";
import { createBlog } from "../src/server/dal/blogs";
import {
  getAutomationConfig,
  saveAutomationConfig,
  validateAutomationInput,
} from "../src/server/dal/automations";
import {
  createContentJob,
  getContentJobForMember,
  listContentJobEvents,
  listContentJobsForMember,
} from "../src/server/dal/contentJobs";
import {
  AUTOMATION_WORKER_NAME,
  getAutomationWorkerState,
  tickAutomation,
} from "../src/server/scheduler";
import { resolveModelProviderState } from "../src/server/ai/modelProvider";

const stamp = Date.now().toString(36);
const out: Record<string, unknown> = {};
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  out[name] = ok ? true : { FAILED: true, detail };
  if (!ok) failures.push(name);
}

await migrate();
out.storage = usingPostgres() ? "postgres" : "sqlite";

const admin = await get<{ id: number }>(
  "SELECT id FROM users WHERE email = ?",
  "admin@autonoblog.local"
);
if (!admin) throw new Error("admin user missing — cannot run the Phase 6a smoke test");
const adminId = Number(admin.id);

// ---- Temp blog -------------------------------------------------------------
const blog = await createBlog({
  ownerId: adminId,
  name: `Phase 6a Automation Blog ${stamp}`,
  tagline: "Automation smoke",
  description: "A temporary blog created by scripts/phase6a-automation-smoke.ts.",
});
await run("UPDATE blogs SET status = 'active' WHERE id = ?", blog.id);
out.blog = { id: blog.id, slug: blog.slug };

// ---- 1. Config: defaults -> validation -> save -> reload -------------------
const defaults = await getAutomationConfig(blog.id);
check("config_starts_unpersisted", defaults.persisted === false, defaults);
check("config_defaults_two_slots", defaults.publishTimes.length === 2, defaults.publishTimes);
check("config_default_posts_per_day", defaults.postsPerDay === 2, defaults.postsPerDay);
check("config_default_disabled", defaults.enabled === false, defaults.enabled);

const badTime = validateAutomationInput({
  enabled: true,
  postsPerDay: 2,
  publishTimes: ["9am"],
  topics: ["x"],
  language: "en",
  tone: "t",
  targetAudience: "",
  minWordCount: 1000,
  seoRequireMeta: true,
  seoRequireInternalLinks: true,
  seoKeywords: "",
  approvalMode: "manual",
  socialNetworks: [],
});
check("validation_rejects_bad_time", badTime.ok === false, badTime);

const tooManyTimes = validateAutomationInput({
  enabled: true,
  postsPerDay: 1,
  publishTimes: ["09:00", "17:00"],
  topics: [],
  language: "en",
  tone: "t",
  targetAudience: "",
  minWordCount: 1000,
  seoRequireMeta: true,
  seoRequireInternalLinks: true,
  seoKeywords: "",
  approvalMode: "manual",
  socialNetworks: [],
});
check("validation_rejects_more_times_than_posts", tooManyTimes.ok === false, tooManyTimes);

const topics = ["strength training", "recovery and sleep"];
const savedRow = await saveAutomationConfig(blog.id, {
  enabled: true,
  postsPerDay: 2,
  publishTimes: ["08:30", "16:45"],
  topics,
  language: "de",
  tone: "friendly expert",
  targetAudience: "new gym members over 40",
  minWordCount: 1500,
  seoRequireMeta: true,
  seoRequireInternalLinks: false,
  seoKeywords: "strength training, over 40",
  approvalMode: "automatic",
  socialNetworks: ["x", "linkedin"],
});

const raw = await get<Record<string, unknown>>(
  "SELECT * FROM blog_automations WHERE blog_id = ?",
  blog.id
);
check("config_row_written", Boolean(raw), raw);
check("config_row_enabled", Number(raw?.enabled) === 1, raw?.enabled);
check("config_row_times_json", String(raw?.publish_times) === '["08:30","16:45"]', raw?.publish_times);
check("config_row_topics_json", String(raw?.topics) === JSON.stringify(topics), raw?.topics);
check("config_row_language", String(raw?.language) === "de", raw?.language);
check("config_row_approval", String(raw?.approval_mode) === "automatic", raw?.approval_mode);
check("config_row_social", String(raw?.social_networks) === '["x","linkedin"]', raw?.social_networks);

const reloaded = await getAutomationConfig(blog.id);
check("config_reload_persisted", reloaded.persisted === true, reloaded.persisted);
check("config_reload_enabled", reloaded.enabled === true, reloaded.enabled);
check("config_reload_times", reloaded.publishTimes.join(",") === "08:30,16:45", reloaded.publishTimes);
check("config_reload_topics", reloaded.topics.join("|") === topics.join("|"), reloaded.topics);
check("config_reload_tone", reloaded.tone === "friendly expert", reloaded.tone);
check("config_reload_audience", reloaded.targetAudience === "new gym members over 40", reloaded.targetAudience);
check("config_reload_min_words", reloaded.minWordCount === 1500, reloaded.minWordCount);
check("config_reload_seo_flags", reloaded.seoRequireMeta === true && reloaded.seoRequireInternalLinks === false, reloaded);
check("config_reload_social", reloaded.socialNetworks.join(",") === "x,linkedin", reloaded.socialNetworks);
check("save_returns_row", savedRow.persisted === true && savedRow.updatedAt !== null, savedRow.updatedAt);

// Saving again must UPDATE, not duplicate (UNIQUE blog_id).
await saveAutomationConfig(blog.id, {
  ...reloaded,
  minWordCount: 1600,
});
const rowsAfterSecondSave = await get<{ n: unknown }>(
  "SELECT COUNT(*) AS n FROM blog_automations WHERE blog_id = ?",
  blog.id
);
check("config_single_row_per_blog", Number(rowsAfterSecondSave?.n ?? 0) === 1, rowsAfterSecondSave);
check(
  "config_update_applied",
  (await getAutomationConfig(blog.id)).minWordCount === 1600,
  "second save did not persist"
);

// ---- 2. Manual job creation writes a real row ------------------------------
const job = await createContentJob(blog.id, {
  status: "queued",
  topic: "how to start strength training at 40",
  brief: "Cover form, progression and recovery; no medical claims.",
});
check("job_row_created", job.id > 0 && job.status === "queued", job);
const jobRaw = await get<Record<string, unknown>>(
  "SELECT * FROM content_jobs WHERE id = ?",
  job.id
);
check("job_row_in_db", Boolean(jobRaw), jobRaw);
check("job_status_queued", String(jobRaw?.status) === "queued", jobRaw?.status);
check("job_topic_stored", String(jobRaw?.topic) === "how to start strength training at 40", jobRaw?.topic);
check(
  "job_brief_stored",
  String(jobRaw?.brief) === "Cover form, progression and recovery; no medical claims.",
  jobRaw?.brief
);
check("job_has_no_result_yet", String(jobRaw?.result) === "", jobRaw?.result);

const events = await listContentJobEvents(job.id);
check("job_created_event", events.some((e) => e.action === "created"), events.map((e) => e.action));

const memberList = await listContentJobsForMember(blog.id, adminId);
check("job_list_reads_it_back", memberList.some((j) => j.id === job.id), memberList.length);
const detail = await getContentJobForMember(job.id, blog.id, adminId);
check("job_detail_reads_it_back", detail?.id === job.id && detail?.topic === job.topic, detail);

// Per-blog isolation: a user who is not a member of this blog sees nothing.
const outsider = await get<{ id: number }>(
  `SELECT u.id FROM users u
    WHERE u.id <> ?
      AND NOT EXISTS (SELECT 1 FROM blog_members bm WHERE bm.blog_id = ? AND bm.user_id = u.id)
    LIMIT 1`,
  adminId,
  blog.id
);
if (outsider) {
  const outsiderJob = await getContentJobForMember(job.id, blog.id, Number(outsider.id));
  const outsiderList = await listContentJobsForMember(blog.id, Number(outsider.id));
  check("non_member_cannot_read_job", outsiderJob === null, outsiderJob);
  check("non_member_sees_no_jobs", outsiderList.length === 0, outsiderList.length);
}

// ---- 3. The worker fabricates nothing without a model provider -------------
const provider = await resolveModelProviderState({ blogId: blog.id });
out.provider = { configured: provider.configured, provider: provider.provider, envVar: provider.requiredEnvVar };

// Make a slot due right now and clear the "already enqueued" marker, so the
// worker really believes a slot is due. Nothing may be created from it.
const nowIso = new Date().toISOString();
const nowHHMM = nowIso.slice(11, 16);
await run(
  "UPDATE blog_automations SET publish_times = ?, last_enqueued_at = NULL WHERE blog_id = ?",
  JSON.stringify([nowHHMM]),
  blog.id
);

const jobsBefore = Number(
  (await get<{ n: unknown }>("SELECT COUNT(*) AS n FROM content_jobs WHERE blog_id = ?", blog.id))?.n ?? 0
);
const postsBefore = Number(
  (await get<{ n: unknown }>("SELECT COUNT(*) AS n FROM posts WHERE blog_id = ?", blog.id))?.n ?? 0
);

const tick = await tickAutomation(nowIso);
out.tick = {
  checked: tick.checked,
  due: tick.due,
  enqueued: tick.enqueued.length,
  providerConfigured: tick.providerConfigured,
  note: tick.note,
};

const jobsAfter = Number(
  (await get<{ n: unknown }>("SELECT COUNT(*) AS n FROM content_jobs WHERE blog_id = ?", blog.id))?.n ?? 0
);
const postsAfter = Number(
  (await get<{ n: unknown }>("SELECT COUNT(*) AS n FROM posts WHERE blog_id = ?", blog.id))?.n ?? 0
);

check("worker_saw_the_due_slot", tick.due >= 1, out.tick);
if (!provider.configured) {
  check("worker_enqueued_nothing", tick.enqueued.length === 0, tick.enqueued);
  check("worker_job_count_unchanged", jobsAfter === jobsBefore, { jobsBefore, jobsAfter });
  check("worker_created_no_post", postsAfter === postsBefore, { postsBefore, postsAfter });
  check(
    "worker_note_names_env_var",
    tick.note.includes(provider.requiredEnvVar),
    tick.note
  );
  const skippedForBlog = tick.skipped.find((s) => s.blogId === Number(blog.id));
  check(
    "worker_skip_reason_honest",
    Boolean(skippedForBlog) && skippedForBlog!.reason.includes(provider.requiredEnvVar),
    tick.skipped
  );
} else {
  // A key exists in this environment: the tick may enqueue, but every job it
  // claims must exist as a real row in `queued` — and it still may not invent a
  // post.
  for (const item of tick.enqueued) {
    const realJob = await get<{ id: unknown; status: unknown }>(
      "SELECT id, status FROM content_jobs WHERE id = ?",
      item.jobId
    );
    check(
      `enqueued_job_${String(item.jobId)}_is_real`,
      Boolean(realJob) && String(realJob?.status) === "queued",
      realJob
    );
  }
  check("worker_created_no_post", postsAfter === postsBefore, { postsBefore, postsAfter });
  check("worker_job_count_matches_enqueued", jobsAfter === jobsBefore + tick.enqueued.length, {
    jobsBefore,
    jobsAfter,
    enqueued: tick.enqueued.length,
  });
}

const workerState = await getAutomationWorkerState();
check("automation_heartbeat_written", workerState.heartbeatPresent, workerState);
check("automation_heartbeat_fresh", workerState.running, workerState);
check(
  "automation_heartbeat_row_named",
  Boolean(await get<{ name: string }>("SELECT name FROM scheduler_state WHERE name = ?", AUTOMATION_WORKER_NAME)),
  AUTOMATION_WORKER_NAME
);

// ---- Cleanup ---------------------------------------------------------------
await run("DELETE FROM blogs WHERE id = ?", blog.id);
const leftovers = {
  blogs: Number((await get<{ n: unknown }>("SELECT COUNT(*) AS n FROM blogs WHERE id = ?", blog.id))?.n ?? 0),
  configs: Number(
    (await get<{ n: unknown }>("SELECT COUNT(*) AS n FROM blog_automations WHERE blog_id = ?", blog.id))?.n ?? 0
  ),
  jobs: Number(
    (await get<{ n: unknown }>("SELECT COUNT(*) AS n FROM content_jobs WHERE blog_id = ?", blog.id))?.n ?? 0
  ),
};
out.cleanup = leftovers;
check("cleanup_complete", leftovers.blogs === 0 && leftovers.configs === 0 && leftovers.jobs === 0, leftovers);

out.failures = failures;
out.passed = failures.length === 0;
out.checks = Object.keys(out).length;
console.log(JSON.stringify(out, null, 2));
if (failures.length > 0) {
  console.error(`\nFAILED ${failures.length} check(s): ${failures.join(", ")}`);
  process.exit(1);
}
