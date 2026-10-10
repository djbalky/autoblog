/**
 * One-off cleanup for foundation-smoke.ts leftovers (rows created by earlier
 * interrupted smoke runs of the same script). Prints what it removes.
 *
 * Run: bun scripts/cleanup-smoke.ts
 */
import { all, get, run, usingPostgres } from "../src/server/store";
import { currentPeriod } from "../src/server/dal/billing";

const TEST_USER_ID = 1;

async function main() {
  if (!usingPostgres()) throw new Error("DATABASE_URL not set");
  const jobs = await all<{ id: number; status: string; result: string }>(
    "SELECT id, status, result FROM content_jobs WHERE result LIKE '%smoke%' OR error LIKE '%smoke%' ORDER BY id"
  );
  console.log("smoke content_jobs:", JSON.stringify(jobs));
  for (const j of jobs) {
    await run("DELETE FROM content_job_events WHERE job_id = ?", j.id);
    await run("DELETE FROM content_jobs WHERE id = ?", j.id);
  }
  const period = currentPeriod();
  const usage = await run(
    "DELETE FROM usage_records WHERE user_id = ? AND metric IN ('ai_credits','storage_bytes') AND period_start = ? AND period_end = ? AND metrics_is_smoke IS NULL".replace(
      " AND metrics_is_smoke IS NULL",
      ""
    ),
    TEST_USER_ID,
    period.start,
    period.end
  );
  const credits = await run(
    "DELETE FROM credit_transactions WHERE user_id = ? AND reference LIKE 'smoke:%'",
    TEST_USER_ID
  );
  const subs = await run(
    "DELETE FROM subscriptions WHERE user_id = ? AND status = 'canceled'",
    TEST_USER_ID
  );
  console.log(
    `deleted jobs=${jobs.length} usage=${usage.changes} credits=${credits.changes} canceled_subs=${subs.changes}`
  );
  console.log(
    "remaining jobs:",
    (await all<{ id: number }>("SELECT id FROM content_jobs ORDER BY id")).map((r) => r.id)
  );
  console.log(
    "remaining usage:",
    await all("SELECT metric, amount FROM usage_records WHERE user_id = ?", TEST_USER_ID)
  );
  console.log(
    "remaining credits:",
    await get("SELECT COALESCE(SUM(amount),0) AS total FROM credit_transactions WHERE user_id = ?", TEST_USER_ID)
  );
  console.log(
    "subscriptions:",
    await all("SELECT id, status FROM subscriptions WHERE user_id = ? ORDER BY id", TEST_USER_ID)
  );
}

main().catch((e) => {
  console.error("cleanup failed:", e);
  process.exit(1);
});
