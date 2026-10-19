/**
 * Phase 4b smoke test — runs against the LIVE database (DATABASE_URL).
 *
 * Proves, with real SQL: page create -> save (revision 1->2) -> publish
 * (status + published_at) -> schedule (status + scheduled_at) -> duplicate slug
 * uniqueness -> isolation (a non-member sees/touches nothing). Leaves one
 * published test page in the admin's blog for UI inspection and deletes the
 * temporary drafts. Prints a compact JSON summary; never prints the URL.
 */
import { all, get, migrate, usingPostgres } from "../src/server/store";
import {
  createPageForMember,
  savePageForMember,
  setPageStatusForMember,
  listPagesForMember,
  getPageForMember,
  listPageRevisionsForMember,
  duplicatePageForMember,
  deletePageForMember,
  pageStatusCounts,
} from "../src/server/dal/pages";
import { getBlogMembership } from "../src/server/dal/posts";

const out: Record<string, unknown> = {};
await migrate();
out.storage = usingPostgres() ? "postgres" : "sqlite";

const admin = await get<{ id: number }>(
  "SELECT id FROM users WHERE email = ?",
  "admin@autonoblog.local"
);
const other = await get<{ id: number }>(
  "SELECT id FROM users WHERE email <> ? ORDER BY id LIMIT 1",
  "admin@autonoblog.local"
);
out.adminId = admin?.id;
out.otherUserId = other?.id;

// The brief asks for the published test page to land in blog 3.
const blog3 = await get<{ id: number }>(
  "SELECT b.id FROM blogs b JOIN blog_members bm ON bm.blog_id = b.id WHERE bm.user_id = ? AND b.id = 3",
  admin!.id
);
const adminBlog = blog3 ?? (await get<{ id: number }>(
  "SELECT b.id FROM blogs b JOIN blog_members bm ON bm.blog_id = b.id WHERE bm.user_id = ? ORDER BY b.id LIMIT 1",
  admin!.id
));
const otherBlog = await get<{ id: number }>(
  "SELECT b.id FROM blogs b JOIN blog_members bm ON bm.blog_id = b.id WHERE bm.user_id = ? ORDER BY b.id LIMIT 1",
  other!.id
);
out.adminBlogId = adminBlog?.id;
out.otherBlogId = otherBlog?.id;
out.adminMembership = await getBlogMembership(adminBlog!.id, admin!.id);
out.adminInOtherBlog = await getBlogMembership(otherBlog!.id, admin!.id);

const pageContent = (label: string) =>
  JSON.stringify({
    version: 1,
    excerpt: `${label} excerpt`,
    blocks: [
      { id: "b1", type: "hero", data: { headline: `${label} hero`, subtext: "Sub", bg: "#f0fdf4" } },
      { id: "b2", type: "paragraph", data: { text: `Real paragraph for the ${label} smoke page.` } },
      { id: "b3", type: "two-column", data: { left: "Left", right: "Right" } },
      { id: "b4", type: "cta", data: { title: "Go", buttonLabel: "Sign up", url: "https://example.com" } },
      { id: "b5", type: "spacer", data: { height: 32 } },
    ],
  });

// ---- create -> save (revision 1 -> 2) --------------------------------------
const p1 = await createPageForMember(adminBlog!.id, admin!.id, {
  title: "Phase 4b smoke page",
  content: pageContent("v1"),
});
out.created = p1 && {
  id: p1.id,
  status: p1.status,
  slug: p1.slug,
  published_at: p1.published_at,
  revisions: (await listPageRevisionsForMember(p1.id, admin!.id)).length,
};
const saved = await savePageForMember(p1!.id, admin!.id, {
  title: "Phase 4b smoke page",
  content: pageContent("v2"),
});
out.afterSave = saved && {
  status: saved.page.status,
  revisionNumber: saved.revisionNumber,
  revisions: (await listPageRevisionsForMember(p1!.id, admin!.id)).length,
};

// The five new/existing block types must survive a round trip through the DB.
out.blocksPersisted = JSON.parse((await getPageForMember(p1!.id, admin!.id))!.content).blocks.map(
  (b: { type: string }) => b.type
);

// ---- publish ---------------------------------------------------------------
const published = await setPageStatusForMember(p1!.id, admin!.id, "published");
out.afterPublish = published && {
  status: published.page.status,
  published_at: published.page.published_at,
  revisionNumber: published.revisionNumber,
};

// ---- schedule --------------------------------------------------------------
const p2 = await createPageForMember(adminBlog!.id, admin!.id, {
  title: "Phase 4b scheduled page",
  content: pageContent("sched"),
});
const future = new Date(Date.now() + 86400000).toISOString();
const scheduled = await savePageForMember(p2!.id, admin!.id, {
  status: "scheduled",
  scheduledAt: future,
  content: pageContent("sched"),
});
out.afterSchedule = scheduled && {
  status: scheduled.page.status,
  scheduled_at: scheduled.page.scheduled_at,
  published_at: scheduled.page.published_at,
};

// ---- unpublish clears published_at -----------------------------------------
const unp = await setPageStatusForMember(p1!.id, admin!.id, "draft");
out.afterUnpublish = unp && { status: unp.page.status, published_at: unp.page.published_at };
await setPageStatusForMember(p1!.id, admin!.id, "published");

// ---- duplicate slug uniqueness --------------------------------------------
const dup = await duplicatePageForMember(p1!.id, admin!.id);
out.duplicate = dup && { id: dup.id, slug: dup.slug, status: dup.status };
const dupAgain = await duplicatePageForMember(p1!.id, admin!.id);
out.duplicateAgainSlug = dupAgain?.slug;
out.slugsUnique =
  new Set([p1!.slug, dup!.slug, dupAgain!.slug]).size === 3 &&
  p1!.slug !== dup!.slug &&
  dup!.slug !== dupAgain!.slug;

out.counts = await pageStatusCounts(adminBlog!.id, admin!.id);

// ---- Isolation: the other user must not see or touch this blog's pages -----
out.isolation = {
  listForAdminBlogByOther: (await listPagesForMember(adminBlog!.id, other!.id)).length,
  getPageAsNonMember: await getPageForMember(p1!.id, other!.id),
  savePageAsNonMember: await savePageForMember(p1!.id, other!.id, { title: "hijack" }),
  createAsNonMember: await createPageForMember(adminBlog!.id, other!.id, { title: "hijack" }),
  revisionsAsNonMember: (await listPageRevisionsForMember(p1!.id, other!.id)).length,
  duplicateAsNonMember: await duplicatePageForMember(p1!.id, other!.id),
  deleteAsNonMember: await deletePageForMember(p1!.id, other!.id),
  countsForAdminBlogByOther: await pageStatusCounts(adminBlog!.id, other!.id),
};

// ---- Tidy up: delete the temporary drafts, keep the published page ---------
for (const p of [p2!.id, dup!.id, dupAgain!.id]) await deletePageForMember(p, admin!.id);
out.left = await all<{ id: number; title: string; status: string }>(
  "SELECT id, title, status FROM pages WHERE blog_id = ? ORDER BY id",
  adminBlog!.id
);
out.pageRevisionsLeft = (
  await all<{ n: unknown }>(
    "SELECT COUNT(*) AS n FROM page_revisions r JOIN pages p ON p.id = r.page_id WHERE p.blog_id = ?",
    adminBlog!.id
  )
).map((r) => Number(r.n));
console.log(JSON.stringify(out, null, 2));
