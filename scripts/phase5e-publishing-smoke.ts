/**
 * Phase 5e smoke test — the publishing engine, against the LIVE database and the
 * LIVE server (default http://localhost:3000, override with BASE_URL).
 *
 * What it proves, with real HTTP responses from the running site:
 *   1. A post scheduled a few seconds in the future is flipped to `published` by
 *      the REAL in-process worker (it waits for an actual tick — no manual call),
 *      answers 200 on its URL and appears in that blog's sitemap and feed.
 *   2. A post scheduled far in the future is NOT published by the same ticks.
 *   3. The worker writes the audit row a manual publish writes (activity_logs,
 *      user_id NULL) and its heartbeat row is fresh (worker really running).
 *   4. Renaming a published post records a redirect and the OLD URL answers a
 *      real 301 to the NEW one (absolute Location under the public origin).
 *   5. A chain resolves: A→B then B→C means A lands on C, in one hop.
 *   6. A redirect never shadows live content: a redirect pointing at a path that
 *      a published post occupies answers that post (200), not a 301.
 *   7. A redirect whose target was unpublished does not bounce into a 404 loop:
 *      the old URL answers 404.
 *   8. Canonical/og:url/sitemap/feed URLs carry the PUBLIC origin, never the
 *      proxy's preview host.
 *
 * Everything it creates is deleted at the end (the blog row cascades).
 *
 * Run: bun scripts/phase5e-publishing-smoke.ts
 */
import { get, run, migrate, usingPostgres } from "../src/server/store";
import { createBlog } from "../src/server/dal/blogs";
import { createPostForMember, setPostStatusForMember, savePostForMember } from "../src/server/dal/posts";
import { serializeBlocks } from "../src/components/blocks/types";
import { DEFAULT_PUBLIC_ORIGIN, configuredPublicOrigin } from "../src/server/publicOrigin";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const PUBLIC = configuredPublicOrigin() || DEFAULT_PUBLIC_ORIGIN;
const stamp = Date.now().toString(36);
const out: Record<string, unknown> = {};
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  out[name] = ok ? true : { FAILED: true, detail };
  if (!ok) failures.push(name);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchStatus(path: string): Promise<{ status: number; location: string | null; body: string }> {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

await migrate();
out.storage = usingPostgres() ? "postgres" : "sqlite";
out.baseUrl = BASE;
out.publicOrigin = PUBLIC;

const admin = await get<{ id: number }>("SELECT id FROM users WHERE email = ?", "admin@autonoblog.local");
if (!admin) throw new Error("admin user missing — cannot run the publishing smoke test");
const adminId = Number(admin.id);

// ---- Temp blog -------------------------------------------------------------
const blog = await createBlog({
  ownerId: adminId,
  name: `Phase 5e Publishing Blog ${stamp}`,
  tagline: "Publishing engine smoke",
  description: "A temporary blog created by scripts/phase5e-publishing-smoke.ts.",
});
await run("UPDATE blogs SET status = 'active' WHERE id = ?", blog.id);
out.blog = blog.slug;

// ---- 3. The worker's heartbeat is real -------------------------------------
const heartbeat = await get<{ last_tick_at: unknown; interval_seconds: unknown; pid: unknown }>(
  "SELECT last_tick_at, interval_seconds, pid FROM scheduler_state WHERE name = ?",
  "publishing"
);
const lastTickMs = heartbeat?.last_tick_at ? new Date(String(heartbeat.last_tick_at)).getTime() : NaN;
const ageSeconds = Number.isNaN(lastTickMs) ? null : Math.round((Date.now() - lastTickMs) / 1000);
out.heartbeat = { ageSeconds, intervalSeconds: Number(heartbeat?.interval_seconds ?? 0), pid: heartbeat?.pid };
check("worker_heartbeat_present", Boolean(heartbeat), "no scheduler_state row — the worker is not running");
check(
  "worker_heartbeat_fresh",
  ageSeconds !== null && ageSeconds <= Number(heartbeat?.interval_seconds ?? 30) * 3,
  out.heartbeat
);

// ---- 1. A due-scheduled post goes live on its own --------------------------
const body = serializeBlocks([{ id: "p1", type: "paragraph", data: { text: "Scheduled body." } }]);
const due = await createPostForMember(blog.id, adminId, {
  title: `Phase 5e due post ${stamp}`,
  content: body,
  excerpt: "A post scheduled a few seconds from now.",
});
if (!due) throw new Error("could not create the due post");
const dueAt = new Date(Date.now() + 4_000).toISOString();
await setPostStatusForMember(due.id, adminId, "scheduled", dueAt);
const beforeTick = await get<{ status: unknown }>("SELECT status FROM posts WHERE id = ?", due.id);
check("scheduled_before_tick", String(beforeTick?.status) === "scheduled", beforeTick?.status);

// A far-future post must NOT be published by the same ticks.
const future = await createPostForMember(blog.id, adminId, {
  title: `Phase 5e future post ${stamp}`,
  content: body,
  excerpt: "A post scheduled for tomorrow.",
});
if (!future) throw new Error("could not create the future post");
await setPostStatusForMember(future.id, adminId, "scheduled", new Date(Date.now() + 86_400_000).toISOString());

// Wait for a REAL tick (interval 30s) — nothing is called by hand.
const deadline = Date.now() + 45_000;
let publishedRow: { status: unknown; published_at: unknown } | undefined;
while (Date.now() < deadline) {
  publishedRow = await get<{ status: unknown; published_at: unknown }>(
    "SELECT status, published_at FROM posts WHERE id = ?",
    due.id
  );
  if (String(publishedRow?.status) === "published") break;
  await sleep(2_000);
}
out.publishedByWorker = { status: publishedRow?.status, publishedAt: publishedRow?.published_at };
check("worker_published_due_post", String(publishedRow?.status) === "published", publishedRow?.status);
check(
  "published_at_is_real",
  Boolean(publishedRow?.published_at) && new Date(String(publishedRow?.published_at)).getTime() <= Date.now() + 1000,
  publishedRow?.published_at
);

const futureRow = await get<{ status: unknown }>("SELECT status FROM posts WHERE id = ?", future.id);
check("future_post_still_scheduled", String(futureRow?.status) === "scheduled", futureRow?.status);

// The audit row a manual publish writes, with no user id.
const audit = await get<{ n: unknown }>(
  "SELECT COUNT(*) AS n FROM activity_logs WHERE entity_type = 'post' AND entity_id = ? AND action = 'post.published' AND user_id IS NULL",
  due.id
);
check("worker_wrote_activity_row", Number(audit?.n ?? 0) >= 1, audit);

// Public: 200, in the sitemap, in the feed.
const duePath = `/${blog.slug}/${due.slug}`;
const duePage = await fetchStatus(duePath);
check("published_post_is_public", duePage.status === 200, duePage.status);
const sitemap = await fetchStatus(`/${blog.slug}/sitemap.xml`);
check("published_post_in_sitemap", sitemap.body.includes(`<loc>${PUBLIC}${duePath}</loc>`), sitemap.body.slice(0, 200));
const feed = await fetchStatus(`/${blog.slug}/feed.xml`);
check("published_post_in_feed", feed.body.includes(`${PUBLIC}${duePath}`), "missing from feed");
check("future_post_not_public", (await fetchStatus(`/${blog.slug}/${future.slug}`)).status === 404);
check("future_post_not_in_sitemap", !sitemap.body.includes(future.slug));

// ---- 8. Canonical URLs carry the public origin -----------------------------
const html = duePage.body;
check("canonical_uses_public_origin", html.includes(`<link rel="canonical" href="${PUBLIC}${duePath}"`), "canonical host wrong");
check("og_url_uses_public_origin", html.includes(`property="og:url" content="${PUBLIC}${duePath}"`), "og:url host wrong");
check("no_preview_host_in_html", !html.includes("preview.bl.run"), "proxy preview host leaked into the page");
check("sitemap_uses_public_origin", sitemap.body.includes(`<loc>${PUBLIC}/${blog.slug}</loc>`));
check("feed_uses_public_origin", feed.body.includes(`<link>${PUBLIC}/${blog.slug}</link>`));

// ---- 4. Renaming a published post 301s the old URL -------------------------
const renamed = await savePostForMember(due.id, adminId, { slug: `${due.slug}-renamed` });
if (!renamed) throw new Error("could not rename the published post");
const newPath = `/${blog.slug}/${renamed.slug}`;
const oldUrl = await fetchStatus(duePath);
check("old_url_301", oldUrl.status === 301, oldUrl.status);
check("old_url_location_absolute", oldUrl.location === `${PUBLIC}${newPath}`, oldUrl.location);
check("new_url_200", (await fetchStatus(newPath)).status === 200);
const redirectRow = await get<{ n: unknown }>(
  "SELECT COUNT(*) AS n FROM redirects WHERE blog_id = ? AND from_path = ? AND to_path = ?",
  blog.id,
  duePath,
  newPath
);
check("redirect_row_recorded", Number(redirectRow?.n ?? 0) === 1, redirectRow);

// ---- 5. Chains resolve (A→B→C lands on C, one hop) -------------------------
const renamedAgain = await savePostForMember(due.id, adminId, { slug: `${due.slug}-final` });
if (!renamedAgain) throw new Error("could not rename the post a second time");
const finalPath = `/${blog.slug}/${renamedAgain.slug}`;
const chain = await fetchStatus(duePath);
check("chain_resolves_to_final", chain.status === 301 && chain.location === `${PUBLIC}${finalPath}`, chain.location);
const midHop = await fetchStatus(newPath);
check("mid_hop_resolves_to_final", midHop.status === 301 && midHop.location === `${PUBLIC}${finalPath}`, midHop.location);
check("final_url_200", (await fetchStatus(finalPath)).status === 200);

// ---- 6. A redirect never shadows live content ------------------------------
// Publish a NEW post at the very slug an old redirect points from.
const shadowFrom = `${due.slug}-shadow`;
await run(
  `INSERT INTO redirects (blog_id, from_path, to_path, created_at) VALUES (?, ?, ?, ?)`,
  blog.id,
  `/${blog.slug}/${shadowFrom}`,
  finalPath,
  new Date().toISOString()
);
const shadowPost = await createPostForMember(blog.id, adminId, {
  title: `Phase 5e shadow post ${stamp}`,
  content: body,
  excerpt: "Takes over a path that had a redirect.",
  slug: shadowFrom,
});
if (!shadowPost) throw new Error("could not create the shadow post");
await setPostStatusForMember(shadowPost.id, adminId, "published");
const shadowUrl = await fetchStatus(`/${blog.slug}/${shadowPost.slug}`);
check("redirect_never_shadows_live_post", shadowUrl.status === 200, shadowUrl.status);

// ---- 7. A redirect whose target was unpublished does not loop --------------
await setPostStatusForMember(renamedAgain.id, adminId, "draft");
const unpublished = await fetchStatus(duePath);
check("redirect_to_unpublished_is_404", unpublished.status === 404, unpublished.status);

// ---- Cleanup ---------------------------------------------------------------
await run("DELETE FROM blogs WHERE id = ?", blog.id);
const leftovers = Number(
  (await get<{ n: unknown }>("SELECT COUNT(*) AS n FROM redirects WHERE blog_id = ?", blog.id))?.n ?? 0
);
const blogRows = Number((await get<{ n: unknown }>("SELECT COUNT(*) AS n FROM blogs WHERE id = ?", blog.id))?.n ?? 0);
out.cleanup = { redirects: leftovers, blogs: blogRows };
check("cleanup_complete", leftovers === 0 && blogRows === 0, out.cleanup);

out.failures = failures;
out.passed = failures.length === 0;
out.checks = Object.keys(out).length;
console.log(JSON.stringify(out, null, 2));
if (failures.length > 0) {
  console.error(`\nFAILED ${failures.length} check(s): ${failures.join(", ")}`);
  process.exit(1);
}
