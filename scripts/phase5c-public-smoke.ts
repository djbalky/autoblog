/**
 * Phase 5c smoke test — PUBLIC RENDERING + 404, against the LIVE database and
 * the LIVE server (default http://localhost:3000, override with BASE_URL).
 *
 * What it proves, with real HTTP responses and real HTML:
 *   1. `/<blog-slug>` renders the blog name/tagline/description and its
 *      PUBLISHED posts (title, excerpt, date, first image) — server-rendered.
 *   2. Real pagination: 8 published posts -> 6 on page 1, 2 on page 2, with
 *      honest "Showing X–Y of N" counts and prev/next links; a page past the end
 *      clamps to the last real page.
 *   3. `/<blog-slug>/<post-slug>` renders the article from the block JSON with
 *      the shared renderer (heading, list, quote, image + alt/caption), the
 *      publish date, the author display name and a link back to the blog home.
 *   4. `/<blog-slug>/<page-slug>` renders a published page the same way
 *      (hero / two-column / CTA page-builder blocks).
 *   5. Draft, scheduled, future-dated and trashed posts/pages answer HTTP 404
 *      and never leak their title or body text.
 *   6. A draft (unpublished) or archived blog answers HTTP 404.
 *   7. Unknown blog slug, unknown content slug, deep unknown path and reserved
 *      slugs answer HTTP 404 with the styled 404 page.
 *   8. Per-blog isolation: the temp blog's content never appears under another
 *      blog's address and vice versa.
 *
 * Everything it creates is deleted at the end (the blog row cascades to its
 * posts, revisions, pages and members). Nothing is left behind.
 *
 * Run: bun scripts/phase5c-public-smoke.ts
 */
import { all, get, migrate, run, usingPostgres } from "../src/server/store";
import { createBlog } from "../src/server/dal/blogs";
import { createPostForMember, setPostStatusForMember, savePostForMember } from "../src/server/dal/posts";
import { createPageForMember, setPageStatusForMember } from "../src/server/dal/pages";
import { serializeBlocks } from "../src/components/blocks/types";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const stamp = Date.now().toString(36);
const out: Record<string, unknown> = {};
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  out[name] = ok ? true : { FAILED: true, detail };
  if (!ok) failures.push(name);
}

async function fetchHtml(path: string): Promise<{ status: number; html: string }> {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
  const raw = await res.text();
  // The SSR stream can contain NUL bytes inside its inline serialisation; they
  // are not part of the document text, so strip them before asserting.
  return { status: res.status, html: raw.replace(/\u0000/g, "") };
}

await migrate();
out.storage = usingPostgres() ? "postgres" : "sqlite";
out.baseUrl = BASE;

const admin = await get<{ id: number; display_name: string }>(
  "SELECT id, display_name FROM users WHERE email = ?",
  "admin@autonoblog.local"
);
if (!admin) throw new Error("admin user missing — cannot run the public smoke test");
out.owner = { id: Number(admin.id), name: admin.display_name };

// ---- Temp blog -------------------------------------------------------------
const blog = await createBlog({
  ownerId: Number(admin.id),
  name: `Phase 5c Smoke Blog ${stamp}`,
  tagline: "Public rendering smoke",
  description: "A temporary blog created by scripts/phase5c-public-smoke.ts.",
});
out.blog = { id: blog.id, slug: blog.slug, status: blog.status };

// A blog created by the DAL is a DRAFT: it must not be publicly visible yet.
const draftBlogHome = await fetchHtml(`/${blog.slug}`);
check("draft_blog_is_404", draftBlogHome.status === 404, draftBlogHome.status);
check("draft_blog_hides_name", !draftBlogHome.html.includes(blog.name), "name leaked");

// The wizard publishes a blog (status 'active'); this is the same state change.
await run("UPDATE blogs SET status = 'active' WHERE id = ?", blog.id);
out.blogActivated = true;

const postBlocks = serializeBlocks([
  { id: "p1", type: "heading", data: { level: 2, text: "Why public rendering matters" } },
  {
    id: "p2",
    type: "paragraph",
    data: { text: "This paragraph is stored as **block JSON** and rendered by the shared renderer." },
  },
  { id: "p3", type: "list", data: { items: ["First real item", "Second real item"], ordered: false } },
  { id: "p4", type: "quote", data: { text: "Preview and published output must never diverge.", cite: "Autonoblog" } },
  {
    id: "p5",
    type: "image",
    data: {
      url: "https://example.com/phase5c-smoke-image.png",
      alt: "Phase 5c smoke image alt",
      caption: "Phase 5c smoke caption",
    },
  },
]);
const pageBlocks = serializeBlocks(
  [
    { id: "h1", type: "hero", data: { headline: "Smoke page hero", subtext: "Hero subtext", bg: "#f0fdf4" } },
    { id: "c1", type: "two-column", data: { left: "Left column text", right: "Right column text" } },
    { id: "t1", type: "cta", data: { title: "Smoke CTA", buttonLabel: "Try it", url: "https://example.com" } },
  ],
  { excerpt: "Smoke page excerpt for the meta description." }
);

// ---- Content: 8 published posts (pagination), draft, scheduled, trashed ----
const publishedPost = await createPostForMember(blog.id, Number(admin.id), {
  title: "Phase 5c published post",
  content: postBlocks,
  excerpt: "A published post used to verify public rendering.",
});
if (!publishedPost) throw new Error("could not create the published post");
await setPostStatusForMember(publishedPost.id, Number(admin.id), "published");

// Seven more published posts (older), so pagination has two real pages.
const extraIds: number[] = [];
for (let i = 1; i <= 7; i++) {
  const p = await createPostForMember(blog.id, Number(admin.id), {
    title: `Phase 5c filler post ${i}`,
    content: serializeBlocks([{ id: `f${i}`, type: "paragraph", data: { text: `Filler body ${i}` } }]),
    excerpt: `Filler excerpt ${i}`,
  });
  if (!p) throw new Error(`could not create filler post ${i}`);
  await setPostStatusForMember(p.id, Number(admin.id), "published");
  // Older published_at so ordering is deterministic: newest is the main post.
  await run(
    "UPDATE posts SET published_at = ? WHERE id = ?",
    new Date(Date.now() - i * 3600_000).toISOString(),
    p.id
  );
  extraIds.push(p.id);
}

const draftPost = await createPostForMember(blog.id, Number(admin.id), {
  title: "Phase 5c SECRET DRAFT title",
  content: serializeBlocks([
    { id: "d1", type: "paragraph", data: { text: "SECRET DRAFT BODY — must never be public." } },
  ]),
});
if (!draftPost) throw new Error("could not create the draft post");

const scheduledPost = await createPostForMember(blog.id, Number(admin.id), {
  title: "Phase 5c SECRET SCHEDULED title",
  content: serializeBlocks([{ id: "s1", type: "paragraph", data: { text: "SCHEDULED BODY" } }]),
});
await savePostForMember(scheduledPost!.id, Number(admin.id), {
  status: "scheduled",
  scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
});

const trashedPost = await createPostForMember(blog.id, Number(admin.id), {
  title: "Phase 5c SECRET TRASHED title",
  content: serializeBlocks([{ id: "t1", type: "paragraph", data: { text: "TRASHED BODY" } }]),
});
await setPostStatusForMember(trashedPost!.id, Number(admin.id), "published");
await setPostStatusForMember(trashedPost!.id, Number(admin.id), "trashed");

// A row that is 'published' but dated in the future must also stay hidden.
const futurePost = await createPostForMember(blog.id, Number(admin.id), {
  title: "Phase 5c SECRET FUTURE title",
  content: serializeBlocks([{ id: "u1", type: "paragraph", data: { text: "FUTURE BODY" } }]),
});
await setPostStatusForMember(futurePost!.id, Number(admin.id), "published");
await run(
  "UPDATE posts SET published_at = ? WHERE id = ?",
  new Date(Date.now() + 86_400_000).toISOString(),
  futurePost!.id
);

// ---- Content: one published page + one draft page --------------------------
const publishedPage = await createPageForMember(blog.id, Number(admin.id), {
  title: "Phase 5c published page",
  content: pageBlocks,
});
if (!publishedPage) throw new Error("could not create the published page");
await setPageStatusForMember(publishedPage.id, Number(admin.id), "published");

const draftPage = await createPageForMember(blog.id, Number(admin.id), {
  title: "Phase 5c SECRET DRAFT page title",
  content: serializeBlocks([
    { id: "dp1", type: "paragraph", data: { text: "SECRET DRAFT PAGE BODY" } },
  ]),
});
if (!draftPage) throw new Error("could not create the draft page");

out.content = {
  publishedPost: { id: publishedPost.id, slug: publishedPost.slug },
  fillerPosts: extraIds.length,
  draftPost: { id: draftPost.id, slug: draftPost.slug },
  scheduledPost: { id: scheduledPost!.id, slug: scheduledPost!.slug },
  trashedPost: { id: trashedPost!.id, slug: trashedPost!.slug },
  futurePost: { id: futurePost!.id, slug: futurePost!.slug },
  publishedPage: { id: publishedPage.id, slug: publishedPage.slug },
  draftPage: { id: draftPage.id, slug: draftPage.slug },
};

// ---- 1. Blog home ----------------------------------------------------------
const home = await fetchHtml(`/${blog.slug}`);
check("home_status_200", home.status === 200, home.status);
check("home_blog_name", home.html.includes(blog.name));
check("home_tagline", home.html.includes("Public rendering smoke"));
check("home_published_post_title", home.html.includes("Phase 5c published post"));
check("home_published_excerpt", home.html.includes("A published post used to verify public rendering."));
check("home_card_image", home.html.includes("https://example.com/phase5c-smoke-image.png"));
check("home_shows_6_of_8", home.html.includes("Showing 1–6 of 8 published posts"), "count line missing");
check("home_older_link", home.html.includes(`href="/${blog.slug}?page=2"`));
check("home_draft_absent", !home.html.includes("SECRET DRAFT title"), "draft title leaked");
check("home_scheduled_absent", !home.html.includes("SECRET SCHEDULED title"), "scheduled title leaked");
check("home_trashed_absent", !home.html.includes("SECRET TRASHED title"), "trashed title leaked");
check("home_future_absent", !home.html.includes("SECRET FUTURE title"), "future-dated title leaked");
check("home_meta_title", /<title>[^<]*Phase 5c Smoke Blog[^<]*<\/title>/.test(home.html), "title tag");
check(
  "home_meta_description",
  home.html.includes('name="description" content="A temporary blog created by scripts/phase5c-public-smoke.ts."'),
  "description meta"
);

// ---- 2. Pagination ---------------------------------------------------------
const page2 = await fetchHtml(`/${blog.slug}?page=2`);
check("page2_status_200", page2.status === 200, page2.status);
check("page2_shows_7_8_of_8", page2.html.includes("Showing 7–8 of 8 published posts"), "page 2 count");
check("page2_newer_link", page2.html.includes(`href="/${blog.slug}"`));
check("page2_no_older_link", !page2.html.includes(`href="/${blog.slug}?page=3"`));
const pastEnd = await fetchHtml(`/${blog.slug}?page=99`);
check("page_past_end_clamps", pastEnd.status === 200 && pastEnd.html.includes("Showing 7–8 of 8"), pastEnd.status);

// ---- 3. Published post -----------------------------------------------------
const postUrl = `/${blog.slug}/${publishedPost.slug}`;
const post = await fetchHtml(postUrl);
check("post_status_200", post.status === 200, post.status);
check("post_title", post.html.includes("Phase 5c published post"));
check("post_heading_block", post.html.includes("Why public rendering matters"));
check("post_paragraph_block", post.html.includes("This paragraph is stored as"));
check("post_bold_inline", post.html.includes("<strong"));
check("post_list_block", post.html.includes("First real item") && post.html.includes("<ul"));
check("post_quote_block", post.html.includes("<blockquote") && post.html.includes("Autonoblog"));
check("post_image_block", post.html.includes('src="https://example.com/phase5c-smoke-image.png"'));
check("post_image_alt", post.html.includes('alt="Phase 5c smoke image alt"'));
check("post_image_caption", post.html.includes("Phase 5c smoke caption"));
check("post_author", post.html.includes(admin.display_name), "author display name missing");
check("post_blog_link", post.html.includes(`href="/${blog.slug}"`));
check("post_publish_date", post.html.includes("<time"), "no <time> element");
check("post_meta_title", /<title>Phase 5c published post — [^<]*<\/title>/.test(post.html), "post title tag");
check(
  "post_meta_description",
  post.html.includes('name="description" content="A published post used to verify public rendering."'),
  "post description meta"
);

// ---- 4. Published page -----------------------------------------------------
const pageUrl = `/${blog.slug}/${publishedPage.slug}`;
const pubPage = await fetchHtml(pageUrl);
check("page_status_200", pubPage.status === 200, pubPage.status);
check("page_title", pubPage.html.includes("Phase 5c published page"));
check("page_hero_block", pubPage.html.includes("Smoke page hero"));
check("page_two_column_block", pubPage.html.includes("Left column text") && pubPage.html.includes("Right column text"));
check("page_cta_block", pubPage.html.includes("Smoke CTA") && pubPage.html.includes('href="https://example.com"'));
check(
  "page_meta_description",
  pubPage.html.includes('name="description" content="Smoke page excerpt for the meta description."'),
  "page description meta"
);

// ---- 5. Draft / scheduled / trashed / future -> real 404, no leakage -------
for (const [label, slug, secretTitle, secretBody] of [
  ["draft_post", draftPost.slug, "SECRET DRAFT title", "SECRET DRAFT BODY"],
  ["scheduled_post", scheduledPost!.slug, "SECRET SCHEDULED title", "SCHEDULED BODY"],
  ["trashed_post", trashedPost!.slug, "SECRET TRASHED title", "TRASHED BODY"],
  ["future_post", futurePost!.slug, "SECRET FUTURE title", "FUTURE BODY"],
  ["draft_page", draftPage.slug, "SECRET DRAFT page title", "SECRET DRAFT PAGE BODY"],
] as const) {
  const res = await fetchHtml(`/${blog.slug}/${slug}`);
  check(`${label}_status_404`, res.status === 404, res.status);
  check(`${label}_title_absent`, !res.html.includes(secretTitle), "title leaked");
  check(`${label}_body_absent`, !res.html.includes(secretBody), "body leaked");
  check(`${label}_styled_404`, res.html.includes("not found"), "no 404 page text");
}

// ---- 6. Archived blog -> 404 ----------------------------------------------
await run("UPDATE blogs SET status = 'archived' WHERE id = ?", blog.id);
const archived = await fetchHtml(`/${blog.slug}`);
check("archived_blog_status_404", archived.status === 404, archived.status);
check("archived_blog_content_absent", !archived.html.includes("Phase 5c published post"), "content leaked");
const archivedPost = await fetchHtml(postUrl);
check("archived_blog_post_status_404", archivedPost.status === 404, archivedPost.status);
await run("UPDATE blogs SET status = 'active' WHERE id = ?", blog.id);
const reactivated = await fetchHtml(`/${blog.slug}`);
check("reactivated_blog_status_200", reactivated.status === 200, reactivated.status);

// ---- 7. Unknown + reserved paths ------------------------------------------
const unknownBlog = await fetchHtml(`/no-such-blog-${stamp}`);
check("unknown_blog_404", unknownBlog.status === 404, unknownBlog.status);
check("unknown_blog_styled", unknownBlog.html.includes("Blog not found"), "no blog-not-found text");

const unknownSlug = await fetchHtml(`/${blog.slug}/no-such-slug-${stamp}`);
check("unknown_slug_404", unknownSlug.status === 404, unknownSlug.status);
check("unknown_slug_styled", unknownSlug.html.includes("Article not found"), "no article-not-found text");

const deepPath = await fetchHtml(`/definitely/not/a/route/${stamp}`);
check("deep_unknown_path_404", deepPath.status === 404, deepPath.status);
check("deep_unknown_path_styled", deepPath.html.includes("Page not found"), "no 404 text");
check("deep_unknown_path_home_link", deepPath.html.includes('href="/"'), "no link to site root");

// Reserved slugs can never resolve to a blog: /login stays the app's login page,
// /admin (no app route) is a real 404 rather than a blog lookup.
const login = await fetchHtml("/login");
check("reserved_login_not_shadowed", login.status === 200 && !login.html.includes(blog.name), login.status);
const adminPath = await fetchHtml("/admin");
check("reserved_admin_404", adminPath.status === 404, adminPath.status);

// ---- 8. Per-blog isolation ------------------------------------------------
const otherBlog = await get<{ id: number; slug: string }>(
  "SELECT b.id, b.slug FROM blogs b WHERE b.id = 3"
);
if (otherBlog) {
  const otherHome = await fetchHtml(`/${otherBlog.slug}`);
  check("other_blog_status_200", otherHome.status === 200, otherHome.status);
  check("other_blog_hides_temp_blog", !otherHome.html.includes(blog.name), "temp blog leaked into blog 3");
  check(
    "other_blog_hides_temp_posts",
    !otherHome.html.includes("Phase 5c published post") && !otherHome.html.includes("Phase 5c filler post"),
    "temp posts leaked into blog 3"
  );
  const crossBlog = await fetchHtml(`/${otherBlog.slug}/${publishedPost.slug}`);
  check("cross_blog_slug_404", crossBlog.status === 404, crossBlog.status);
  check("cross_blog_title_absent", !crossBlog.html.includes("Phase 5c published post"), "content leaked across blogs");
  check("home_hides_other_blog_posts", !home.html.includes("Phase 4a smoke post"), "blog 3 content leaked");
}

// ---- Cleanup ---------------------------------------------------------------
await run("DELETE FROM blogs WHERE id = ?", blog.id);
out.cleanup = {
  blogRows: Number((await get<{ n: unknown }>("SELECT COUNT(*) AS n FROM blogs WHERE id = ?", blog.id))?.n ?? 0),
  postRows: Number(
    (await get<{ n: unknown }>("SELECT COUNT(*) AS n FROM posts WHERE blog_id = ?", blog.id))?.n ?? 0
  ),
  pageRows: Number(
    (await get<{ n: unknown }>("SELECT COUNT(*) AS n FROM pages WHERE blog_id = ?", blog.id))?.n ?? 0
  ),
  memberRows: Number(
    (await get<{ n: unknown }>("SELECT COUNT(*) AS n FROM blog_members WHERE blog_id = ?", blog.id))?.n ?? 0
  ),
  postRevisions: Number(
    (
      await get<{ n: unknown }>(
        "SELECT COUNT(*) AS n FROM post_revisions r JOIN posts p ON p.id = r.post_id WHERE p.blog_id = ?",
        blog.id
      )
    )?.n ?? 0
  ),
  pageRevisions: Number(
    (
      await get<{ n: unknown }>(
        "SELECT COUNT(*) AS n FROM page_revisions r JOIN pages p ON p.id = r.page_id WHERE p.blog_id = ?",
        blog.id
      )
    )?.n ?? 0
  ),
};
check(
  "cleanup_complete",
  Object.values(out.cleanup as Record<string, number>).every((n) => n === 0),
  out.cleanup
);

// The deleted blog must be gone from the public site too.
const afterCleanup = await fetchHtml(`/${blog.slug}`);
check("deleted_blog_404", afterCleanup.status === 404, afterCleanup.status);

out.failures = failures;
out.passed = failures.length === 0;
out.checks = Object.keys(out).length;
console.log(JSON.stringify(out, null, 2));
if (failures.length > 0) {
  console.error(`\nFAILED ${failures.length} check(s): ${failures.join(", ")}`);
  process.exit(1);
}
