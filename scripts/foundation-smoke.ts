/**
 * Autonoblog — foundation-extension smoke test (Phase 1 follow-on).
 *
 * Runs the REAL migration against the live Postgres database, then verifies:
 *   1. the new tables and the agent_runs.content_job_id column exist,
 *   2. the free plan row is seeded,
 *   3. a round trip through the new DAL: createContentJob -> advanceContentJob
 *      (incl. a rejected backwards transition) -> recordUsage -> getUsageSummary
 *      -> addCredit -> getCreditBalance -> assertLimit,
 *   4. cleanup of the rows this script created.
 *
 * Run:  bun scripts/foundation-smoke.ts
 * It reads DATABASE_URL through src/server/pg.ts (which cleans the `="..."`
 * wrapping) and never prints the connection string.
 */
import {
  all,
  get,
  migrate,
  run,
  usingPostgres,
} from "../src/server/store";
import { seed } from "../src/server/seed";
import {
  advanceContentJob,
  createContentJob,
  getContentJob,
  listContentJobEvents,
  linkAgentRun,
} from "../src/server/dal/contentJobs";
import {
  addCredit,
  assertLimit,
  currentPeriod,
  getActiveSubscription,
  getCreditBalance,
  getUsageSummary,
  listPlans,
  recordUsage,
  subscribeUser,
} from "../src/server/dal/billing";

const TEST_USER_ID = 1; // admin@autonoblog.local
const TEST_BLOG_ID = 3; // "E2E Test Blog"

function step(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  if (!usingPostgres()) {
    throw new Error(
      "DATABASE_URL is not set — refusing to run the smoke test against SQLite."
    );
  }

  step("1. migrate + seed (live Neon Postgres)");
  await migrate();
  await seed();
  console.log("migrate() + seed() completed without error");

  step("2. tables in information_schema");
  const expected = [
    "plans",
    "subscriptions",
    "usage_records",
    "credit_transactions",
    "content_jobs",
    "content_job_events",
  ];
  const rows = await all<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (${expected.map(() => "?").join(", ")})`,
    ...expected
  );
  const found = rows.map((r) => r.table_name).sort();
  console.log("found:", found.join(", "));
  console.log(
    "missing:",
    expected.filter((t) => !found.includes(t)).join(", ") || "(none)"
  );

  step("3. agent_runs.content_job_id column");
  const col = await get<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'agent_runs' AND column_name = 'content_job_id'`
  );
  console.log(col ? `${col.column_name} ${col.data_type}` : "MISSING");

  step("4. seeded plans");
  for (const p of await listPlans()) {
    console.log(
      `${p.key} | ${p.name} | ${p.monthly_price_cents} cents | active=${p.active} | ${JSON.stringify(p.limits)}`
    );
  }

  step("5. test user/blog exist");
  const user = await get<{ id: number; email: string }>(
    "SELECT id, email FROM users WHERE id = ?",
    TEST_USER_ID
  );
  const blog = await get<{ id: number; name: string }>(
    "SELECT id, name FROM blogs WHERE id = ?",
    TEST_BLOG_ID
  );
  console.log("user:", JSON.stringify(user), "blog:", JSON.stringify(blog));
  if (!user || !blog) throw new Error("test user/blog missing in live DB");

  step("6. subscribeUser(admin, 'free')");
  const sub = await subscribeUser(TEST_USER_ID, "free");
  console.log(
    `subscription#${sub.id} plan=${sub.plan_key} status=${sub.status} period ${sub.current_period_start} -> ${sub.current_period_end}`
  );
  console.log(
    "getActiveSubscription:",
    JSON.stringify(await getActiveSubscription(TEST_USER_ID))
  );

  step("7. createContentJob -> advanceContentJob");
  const job = await createContentJob(TEST_BLOG_ID, {
    deadline: new Date(Date.now() + 3600_000).toISOString(),
  });
  console.log(`created content_job#${job.id} status=${job.status} agent=${job.current_agent}`);
  const briefed = await advanceContentJob(job.id, "brief", "topic_keyword", {
    keywords: ["smoke test", "foundation"],
  });
  console.log(`after brief: status=${briefed.status} result=${briefed.result}`);
  const drafted = await advanceContentJob(job.id, "draft", "writer", "smoke draft body");
  console.log(`after draft: status=${drafted.status} agent=${drafted.current_agent}`);
  console.log(
    "events:",
    (await listContentJobEvents(job.id)).map((e) => `${e.action}(${e.agent})`).join(", ")
  );
  try {
    await advanceContentJob(job.id, "research", "research");
    console.log("REGRESSION: backwards transition was accepted");
  } catch (err) {
    console.log(`backwards transition rejected: ${(err as Error).message}`);
  }
  console.log("linkAgentRun(0) ->", await linkAgentRun(job.id, 0));

  step("8. recordUsage + getUsageSummary");
  const period = currentPeriod();
  console.log("period:", period.start, "->", period.end);
  console.log("recordUsage ai_credits 5 ->", await recordUsage(TEST_USER_ID, "ai_credits", 5, period));
  console.log("recordUsage ai_credits 3 ->", await recordUsage(TEST_USER_ID, "ai_credits", 3, period));
  console.log("recordUsage storage_bytes 1024 ->", await recordUsage(TEST_USER_ID, "storage_bytes", 1024, period));
  const summary = await getUsageSummary(TEST_USER_ID);
  console.log("usage summary:", JSON.stringify(summary, null, 2));

  step("9. addCredit + getCreditBalance + assertLimit");
  const ref = `smoke:content_job:${job.id}`;
  console.log("grant +20 ->", await addCredit(TEST_USER_ID, 20, "smoke test grant", ref));
  console.log("spend -2 ->", await addCredit(TEST_USER_ID, -2, "smoke test spend", ref));
  console.log("balance ->", await getCreditBalance(TEST_USER_ID));
  console.log("assertLimit(ai_credits, 10):", JSON.stringify(await assertLimit(TEST_USER_ID, "ai_credits", 10)));
  console.log("assertLimit(ai_credits, 100):", JSON.stringify(await assertLimit(TEST_USER_ID, "ai_credits", 100)));
  console.log("assertLimit(posts_published, 3):", JSON.stringify(await assertLimit(TEST_USER_ID, "posts_published", 3)));
  console.log("assertLimit(bandwidth, 1):", JSON.stringify(await assertLimit(TEST_USER_ID, "bandwidth", 1)));

  step("10. cleanup of smoke-test rows");
  const deletedJob = await run("DELETE FROM content_jobs WHERE id = ?", job.id);
  const deletedEvents = await run("DELETE FROM content_job_events WHERE job_id = ?", job.id);
  const deletedUsage = await run(
    "DELETE FROM usage_records WHERE user_id = ? AND metric = ? AND period_start = ? AND period_end = ?",
    TEST_USER_ID,
    "ai_credits",
    period.start,
    period.end
  );
  const deletedUsage2 = await run(
    "DELETE FROM usage_records WHERE user_id = ? AND metric = ? AND period_start = ? AND period_end = ?",
    TEST_USER_ID,
    "storage_bytes",
    period.start,
    period.end
  );
  const deletedCredits = await run(
    "DELETE FROM credit_transactions WHERE user_id = ? AND reference = ?",
    TEST_USER_ID,
    ref
  );
  console.log(
    `deleted: job=${deletedJob.changes} events=${deletedEvents.changes} usage=${deletedUsage.changes + deletedUsage2.changes} credits=${deletedCredits.changes}`
  );
  console.log("getContentJob after delete:", await getContentJob(job.id));
  console.log("credit balance after cleanup:", await getCreditBalance(TEST_USER_ID));
  console.log("usage summary after cleanup:", JSON.stringify((await getUsageSummary(TEST_USER_ID)).used));
  console.log(
    "\nNOTE: the admin user's 'free' subscription row is left in place (real state, not test noise)."
  );
  console.log("\nSMOKE TEST COMPLETE");
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
