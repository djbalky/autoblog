/**
 * Phase 4a smoke test — runs against the live database (DATABASE_URL).
 * Proves: membership scoping, save->revision increment, publish, schedule,
 * duplicate slug safety. Prints a compact JSON summary.
 */
import { all, get, migrate, run, usingPostgres } from "../src/server/store";
import {
  createPostForMember,
  savePostForMember,
  setPostStatusForMember,
  listPostsForMember,
  getPostForMember,
  listRevisionsForMember,
  duplicatePostForMember,
  getBlogMembership,
} from "../src/server/dal/posts";

const out: Record<string, unknown> = {};
await migrate();
out.storage = usingPostgres() ? "postgres" : "sqlite";

const admin = await get<{ id: number }>("SELECT id FROM users WHERE email = ?", "admin@autonoblog.local");
const other = await get<{ id: number }>("SELECT id FROM users WHERE email <> ? ORDER BY id LIMIT 1", "admin@autonoblog.local");
out.adminId = admin?.id;
out.otherUserId = other?.id;

const adminBlog = await get<{ id: number }>(
  "SELECT b.id FROM blogs b JOIN blog_members bm ON bm.blog_id = b.id WHERE bm.user_id = ? ORDER BY b.id LIMIT 1",
  admin!.id
);
const otherBlog = await get<{ id: number }>(
  "SELECT b.id FROM blogs b JOIN blog_members bm ON bm.blog_id = b.id WHERE bm.user_id = ? ORDER BY b.id LIMIT 1",
  other!.id
);
out.adminBlogId = adminBlog?.id;
out.otherBlogId = otherBlog?.id;
out.adminMembership = await getBlogMembership(adminBlog!.id, admin!.id);
out.adminInOtherBlog = await getBlogMembership(otherBlog!.id, admin!.id);

const content = JSON.stringify({ version: 1, blocks: [
  { id: "b1", type: "heading", data: { level: 2, text: "Smoke heading" } },
  { id: "b2", type: "paragraph", data: { text: "Real paragraph written by the Phase 4a smoke test." } },
  { id: "b3", type: "list", data: { items: ["one", "two"] } },
  { id: "b4", type: "quote", data: { text: "Quoted." } },
  { id: "b5", type: "image", data: { url: "https://example.com/x.jpg", alt: "alt" } },
]});

const p1 = await createPostForMember(adminBlog!.id, admin!.id, { title: "Phase 4a smoke post" });
out.created = p1 && { id: p1.id, status: p1.status, slug: p1.slug, revisions: (await listRevisionsForMember(p1.id, admin!.id)).length };
const saved = await savePostForMember(p1!.id, admin!.id, { title: "Phase 4a smoke post", content, excerpt: "smoke" });
out.afterSave = saved && { status: saved.status, revisions: (await listRevisionsForMember(p1!.id, admin!.id)).length };
const published = await setPostStatusForMember(p1!.id, admin!.id, "published");
out.afterPublish = published && { status: published.status, published_at: published.published_at };
const p2 = await createPostForMember(adminBlog!.id, admin!.id, { title: "Phase 4a scheduled post" });
const future = new Date(Date.now() + 86400000).toISOString();
const scheduled = await savePostForMember(p2!.id, admin!.id, { status: "scheduled", scheduledAt: future, content });
out.afterSchedule = scheduled && { status: scheduled.status, scheduled_at: scheduled.scheduled_at };
const dup = await duplicatePostForMember(p1!.id, admin!.id);
out.duplicate = dup && { id: dup.id, slug: dup.slug, status: dup.status };

// ---- Isolation: the other user must not see or touch this blog's posts ----
out.isolation = {
  listForOtherBlogByOthers: (await listPostsForMember(adminBlog!.id, other!.id)).length,
  listForOtherUserOwnBlog: (await listPostsForMember(otherBlog!.id, other!.id)).filter((p) => p.id === p1!.id).length,
  getPostAsNonMember: await getPostForMember(p1!.id, other!.id),
  savePostAsNonMember: await savePostForMember(p1!.id, other!.id, { title: "hijack" }),
  createAsNonMember: await createPostForMember(adminBlog!.id, other!.id, { title: "hijack" }),
  revisionsAsNonMember: (await listRevisionsForMember(p1!.id, other!.id)).length,
  duplicateAsNonMember: await duplicatePostForMember(p1!.id, other!.id),
};

// Close the test drafts so the blog is left tidy (published one stays visible).
await run("DELETE FROM posts WHERE id IN (?, ?)", dup!.id, p2!.id);
out.left = await all<{ id: number; title: string; status: string }>(
  "SELECT id, title, status FROM posts WHERE blog_id = ? ORDER BY id",
  adminBlog!.id
);
console.log(JSON.stringify(out, null, 2));
