/**
 * Autonoblog — Phase 3 dashboard gallery smoke test.
 *
 * Runs the REAL gallery query (listBlogCardsForUser) against whatever store the
 * app is using (live Postgres when DATABASE_URL is set) and prints, per user,
 * exactly the blogs that user is a member of — proving the multi-user scoping.
 *
 * Run:  bun scripts/gallery-smoke.ts
 * It prints no connection string.
 */
import { listBlogCardsForUser, countBlogsForUser } from "../src/server/dal/blogs";
import { usingPostgres } from "../src/server/store";

const USERS: Array<{ id: number; label: string }> = [
  { id: 1, label: "admin (Site Owner)" },
  { id: 2, label: "user 2" },
  { id: 6, label: "user 6" },
  { id: 987654, label: "no-such-user (must be empty)" },
];

async function main() {
  console.log(
    `storage: ${usingPostgres() ? "postgres (live)" : "sqlite (dev fallback)"}`
  );
  let failures = 0;

  for (const u of USERS) {
    const cards = await listBlogCardsForUser(u.id);
    const n = await countBlogsForUser(u.id);
    console.log(
      `\nuser ${u.id} (${u.label}): ${cards.length} blog(s) [countBlogsForUser=${n}]`
    );
    for (const c of cards) {
      console.log(
        `  #${c.id} "${c.name}" /${c.slug} status=${c.status} role=${c.member_role} ` +
          `posts=${c.post_count} published=${c.published_count} pages=${c.page_count} ` +
          `posts_per_day=${c.posts_per_day ?? "none"} auto_publish=${c.auto_publish ?? "none"} ` +
          `created=${String(c.created_at).slice(0, 10)}`
      );
      if (typeof c.post_count !== "number" || Number.isNaN(c.post_count)) {
        console.log(`  !! post_count is not a number (${typeof c.post_count})`);
        failures++;
      }
    }
    if (cards.length !== n) {
      console.log(`  !! card count ${cards.length} != countBlogsForUser ${n}`);
      failures++;
    }
  }

  // Cross-user isolation assertion: user 1's ids must not contain blog 1 or 2.
  const admin = await listBlogCardsForUser(1);
  const adminIds = admin.map((b) => b.id);
  const leaked = [1, 2].filter((id) => adminIds.includes(id));
  console.log(`\nadmin blog ids: [${adminIds.join(", ")}]`);
  if (leaked.length) {
    console.log(`!! LEAK: admin sees blog(s) ${leaked.join(", ")} they don't own`);
    failures++;
  } else {
    console.log("isolation OK: admin does not see blogs 1 or 2 (owned by users 2 and 6)");
  }
  const other = await listBlogCardsForUser(6);
  if (other.some((b) => b.id === 3)) {
    console.log("!! LEAK: user 6 sees blog 3 (admin's)");
    failures++;
  } else {
    console.log("isolation OK: user 6 does not see blog 3");
  }

  console.log(
    failures === 0
      ? "\nGALLERY SMOKE PASS"
      : `\nGALLERY SMOKE FAIL (${failures} problem(s))`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
