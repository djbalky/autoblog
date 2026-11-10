/**
 * Phase 5d smoke test — SEO + RSS, against the LIVE database and the LIVE server
 * (default http://localhost:3000, override with BASE_URL).
 *
 * What it proves, with real HTTP responses from the running site:
 *   1. `/<blog-slug>/sitemap.xml` is real XML (`application/xml`) containing the
 *      blog home, the published post and the published page, and NOT the draft
 *      post, the future-dated post or the draft page.
 *   2. `/<blog-slug>/feed.xml` is valid RSS 2.0 with absolute links/guids for the
 *      published posts only, with the author, and without drafts.
 *   3. An article page carries title, description, canonical, og:type=article,
 *      og:url, og:image, article:published_time, a Twitter card and a JSON-LD
 *      `BlogPosting` script that parses as JSON and matches the row.
 *   4. The blog home carries og:type=website, a canonical and a JSON-LD `Blog`.
 *   5. `/robots.txt` is valid and its `Sitemap:` lines really resolve; the root
 *      `/sitemap.xml` index lists this blog's sitemap.
 *   6. A blog with zero published posts still returns a valid empty feed and a
 *      one-URL sitemap; a draft blog's sitemap/feed are a real 404.
 *   7. XML escaping: a title containing `<`, `&` and `"` cannot break the feed.
 *
 * Everything it creates is deleted at the end (the blog row cascades). Nothing
 * is left behind.
 *
 * Run: bun scripts/phase5d-seo-smoke.ts
 */
import { get, run, migrate, usingPostgres } from "../src/server/store";
import { createBlog } from "../src/server/dal/blogs";
import { createPostForMember, setPostStatusForMember } from "../src/server/dal/posts";
import { createPageForMember, setPageStatusForMember } from "../src/server/dal/pages";
import { serializeBlocks } from "../src/components/blocks/types";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const stamp = Date.now().toString(36);
const out: Record<string, unknown> = {};
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  out[name] = ok ? true : { FAILED: true, detail };
  if (!ok) failures.push(name);
}

interface Fetched {
  status: number;
  contentType: string;
  body: string;
}

async function fetchDoc(path: string): Promise<Fetched> {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
  const raw = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    body: raw.replace(/\u0000/g, ""),
  };
}

/** Cheap well-formedness guard: XML declaration, one root, no raw ampersands. */
function looksLikeXml(body: string, root: string): boolean {
  if (!body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) return false;
  if (!body.includes(`<${root}`) || !body.includes(`</${root}>`)) return false;
  // Every ampersand must start a known entity / numeric reference.
  return !/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(body);
}

/** The JSON-LD payload of a page (first ld+json script), parsed. */
function jsonLd(html: string): unknown {
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return { PARSE_ERROR: m[1].slice(0, 200) };
  }
}

/** Undo the HTML entity escaping React applies to attribute values. */
function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function metaContent(html: string, attr: "property" | "name", key: string): string | null {
  const re = new RegExp(`<meta[^>]*${attr}="${key}"[^>]*content="([^"]*)"`);
  const m = re.exec(html);
  return m ? decodeEntities(m[1]) : null;
}

await migrate();
out.storage = usingPostgres() ? "postgres" : "sqlite";
out.baseUrl = BASE;

const admin = await get<{ id: number; display_name: string }>(
  "SELECT id, display_name FROM users WHERE email = ?",
  "admin@autonoblog.local"
);
if (!admin) throw new Error("admin user missing — cannot run the SEO smoke test");
const adminId = Number(admin.id);
out.owner = { id: adminId, name: admin.display_name };

// ---- Temp blogs ------------------------------------------------------------
const blog = await createBlog({
  ownerId: adminId,
  name: `Phase 5d SEO Blog ${stamp}`,
  tagline: "SEO and RSS smoke",
  description: "A temporary blog created by scripts/phase5d-seo-smoke.ts.",
});
const emptyBlog = await createBlog({
  ownerId: adminId,
  name: `Phase 5d Empty Blog ${stamp}`,
  tagline: "No posts here",
  description: "A temporary blog with no published posts.",
});
out.blogs = { seo: blog.slug, empty: emptyBlog.slug };

// A draft (not yet active) blog must not expose a sitemap or feed at all.
const draftBlogSitemap = await fetchDoc(`/${blog.slug}/sitemap.xml`);
check("draft_blog_sitemap_404", draftBlogSitemap.status === 404, draftBlogSitemap.status);
const draftBlogFeed = await fetchDoc(`/${blog.slug}/feed.xml`);
check("draft_blog_feed_404", draftBlogFeed.status === 404, draftBlogFeed.status);

await run("UPDATE blogs SET status = 'active' WHERE id IN (?, ?)", blog.id, emptyBlog.id);

// ---- Content ---------------------------------------------------------------
// A title with XML-hostile characters, to prove the escaping.
const nastyTitle = `Phase 5d <published> & "quoted" post ${stamp}`;
const postBlocks = serializeBlocks([
  { id: "h1", type: "heading", data: { level: 2, text: "Why SEO metadata matters" } },
  {
    id: "p1",
    type: "paragraph",
    data: { text: "This paragraph is stored as block JSON and rendered by the shared renderer." },
  },
  {
    id: "i1",
    type: "image",
    data: {
      url: "https://example.com/phase5d-og-image.png",
      alt: "Phase 5d og image alt",
      caption: "Phase 5d caption",
    },
  },
]);

const published = await createPostForMember(blog.id, adminId, {
  title: nastyTitle,
  content: postBlocks,
  excerpt: "A published post used to verify SEO metadata, sitemap and feed.",
});
if (!published) throw new Error("could not create the published post");
await setPostStatusForMember(published.id, adminId, "published");

const second = await createPostForMember(blog.id, adminId, {
  title: `Phase 5d second published post ${stamp}`,
  content: serializeBlocks([{ id: "s1", type: "paragraph", data: { text: "Second body." } }]),
  excerpt: "Second published excerpt.",
});
if (!second) throw new Error("could not create the second post");
await setPostStatusForMember(second.id, adminId, "published");
await run(
  "UPDATE posts SET published_at = ? WHERE id = ?",
  new Date(Date.now() - 3_600_000).toISOString(),
  second.id
);

const draft = await createPostForMember(blog.id, adminId, {
  title: `Phase 5d SECRET DRAFT ${stamp}`,
  content: serializeBlocks([{ id: "d1", type: "paragraph", data: { text: "SECRET DRAFT BODY" } }]),
});
if (!draft) throw new Error("could not create the draft post");

const future = await createPostForMember(blog.id, adminId, {
  title: `Phase 5d SECRET FUTURE ${stamp}`,
  content: serializeBlocks([{ id: "f1", type: "paragraph", data: { text: "SECRET FUTURE BODY" } }]),
});
if (!future) throw new Error("could not create the future post");
await setPostStatusForMember(future.id, adminId, "published");
await run(
  "UPDATE posts SET published_at = ? WHERE id = ?",
  new Date(Date.now() + 86_400_000).toISOString(),
  future.id
);

const page = await createPageForMember(blog.id, adminId, {
  title: `Phase 5d published page ${stamp}`,
  content: serializeBlocks(
    [{ id: "c1", type: "cta", data: { title: "Smoke CTA", buttonLabel: "Go", url: "https://example.com" } }],
    { excerpt: "Smoke page excerpt." }
  ),
});
if (!page) throw new Error("could not create the published page");
await setPageStatusForMember(page.id, adminId, "published");

const draftPage = await createPageForMember(blog.id, adminId, {
  title: `Phase 5d SECRET DRAFT page ${stamp}`,
  content: serializeBlocks([{ id: "dp1", type: "paragraph", data: { text: "SECRET DRAFT PAGE" } }]),
});
if (!draftPage) throw new Error("could not create the draft page");

out.content = {
  post: { id: published.id, slug: published.slug },
  second: { id: second.id, slug: second.slug },
  page: { id: page.id, slug: page.slug },
  draft: draft.slug,
  future: future.slug,
  draftPage: draftPage.slug,
};

const postUrl = `/${blog.slug}/${published.slug}`;
const postPath = `/${blog.slug}/${published.slug}`;

// ---- 1. Sitemap ------------------------------------------------------------
const sitemap = await fetchDoc(`/${blog.slug}/sitemap.xml`);
check("sitemap_status_200", sitemap.status === 200, sitemap.status);
check("sitemap_content_type", sitemap.contentType.includes("application/xml"), sitemap.contentType);
check("sitemap_is_xml", looksLikeXml(sitemap.body, "urlset"), sitemap.body.slice(0, 120));
check("sitemap_has_blog_home", sitemap.body.includes(`<loc>${BASE}/${blog.slug}</loc>`));
check("sitemap_has_published_post", sitemap.body.includes(`<loc>${BASE}${postPath}</loc>`));
check("sitemap_has_published_page", sitemap.body.includes(`<loc>${BASE}/${blog.slug}/${page.slug}</loc>`));
check("sitemap_has_lastmod", /<lastmod>\d{4}-\d{2}-\d{2}T[\d:.]+Z<\/lastmod>/.test(sitemap.body));
check("sitemap_excludes_draft", !sitemap.body.includes(draft.slug), "draft in sitemap");
check("sitemap_excludes_future", !sitemap.body.includes(future.slug), "future post in sitemap");
check("sitemap_excludes_draft_page", !sitemap.body.includes(draftPage.slug), "draft page in sitemap");
check(
  "sitemap_url_count",
  (sitemap.body.match(/<url>/g) ?? []).length === 4,
  (sitemap.body.match(/<url>/g) ?? []).length
);

// ---- 2. Feed ---------------------------------------------------------------
const feed = await fetchDoc(`/${blog.slug}/feed.xml`);
check("feed_status_200", feed.status === 200, feed.status);
check("feed_content_type", feed.contentType.includes("application/xml"), feed.contentType);
check("feed_is_rss", looksLikeXml(feed.body, "rss"), feed.body.slice(0, 120));
check("feed_channel_title", feed.body.includes(`<title>Phase 5d SEO Blog ${stamp}</title>`));
check("feed_absolute_link", feed.body.includes(`<link>${BASE}/${blog.slug}</link>`));
check(
  "feed_absolute_item_link",
  feed.body.includes(`<link>${BASE}${postPath}</link>`),
  "item link not absolute"
);
check("feed_guid", feed.body.includes(`<guid isPermaLink="true">${BASE}${postPath}</guid>`));
check("feed_pubdate", /<pubDate>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT<\/pubDate>/.test(feed.body));
check("feed_description", feed.body.includes("A published post used to verify SEO metadata, sitemap and feed."));
check("feed_author", feed.body.includes(`<dc:creator>${admin.display_name}</dc:creator>`));
check("feed_second_post", feed.body.includes(`Phase 5d second published post ${stamp}`));
check("feed_excludes_draft", !feed.body.includes("SECRET DRAFT"), "draft leaked into feed");
check("feed_excludes_future", !feed.body.includes("SECRET FUTURE"), "future post leaked into feed");
// XML escaping: the raw title never appears unescaped, the escaped one does.
check("feed_title_escaped", feed.body.includes("Phase 5d &lt;published&gt; &amp; &quot;quoted&quot; post"));
check("feed_no_raw_title", !feed.body.includes("Phase 5d <published>"), "unescaped title in feed");

// ---- 3. Article metadata ---------------------------------------------------
const article = await fetchDoc(postPath);
check("article_status_200", article.status === 200, article.status);
const html = article.body;
check("article_title_tag", /<title>Phase 5d &lt;published&gt; &amp; &quot;quoted&quot; post[^<]*— Phase 5d SEO Blog[^<]*<\/title>/.test(html) || /<title>[^<]*Phase 5d[^<]*—[^<]*<\/title>/.test(html), "title tag");
check("article_meta_description", metaContent(html, "name", "description") === "A published post used to verify SEO metadata, sitemap and feed.");
check("article_canonical", html.includes(`<link rel="canonical" href="${BASE}${postPath}"`));
check("article_og_type_article", metaContent(html, "property", "og:type") === "article");
check("article_og_url", metaContent(html, "property", "og:url") === `${BASE}${postPath}`);
check("article_og_site_name", metaContent(html, "property", "og:site_name") === `Phase 5d SEO Blog ${stamp}`);
check("article_og_title", metaContent(html, "property", "og:title") === nastyTitle, metaContent(html, "property", "og:title"));
check("article_og_description", metaContent(html, "property", "og:description") === "A published post used to verify SEO metadata, sitemap and feed.");
check("article_og_image", metaContent(html, "property", "og:image") === "https://example.com/phase5d-og-image.png");
check("article_published_time", /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(metaContent(html, "property", "article:published_time") ?? ""));
check("article_author_meta", metaContent(html, "property", "article:author") === admin.display_name);
check("article_twitter_card", metaContent(html, "name", "twitter:card") === "summary_large_image");
check("article_twitter_title", metaContent(html, "name", "twitter:title") === nastyTitle);

const ld = jsonLd(html) as Record<string, unknown> | null;
check("article_jsonld_present", ld !== null && typeof ld === "object" && !("PARSE_ERROR" in ld), ld);
check("article_jsonld_type", ld?.["@type"] === "BlogPosting", ld?.["@type"]);
check("article_jsonld_headline", ld?.headline === nastyTitle, ld?.headline);
check("article_jsonld_url", ld?.url === `${BASE}${postPath}`, ld?.url);
check(
  "article_jsonld_dates",
  typeof ld?.datePublished === "string" && typeof ld?.dateModified === "string",
  { published: ld?.datePublished, modified: ld?.dateModified }
);
check("article_jsonld_author", (ld?.author as { name?: string } | undefined)?.name === admin.display_name);
check("article_jsonld_image", JSON.stringify(ld?.image ?? []).includes("https://example.com/phase5d-og-image.png"));
check(
  "article_jsonld_main_entity",
  (ld?.mainEntityOfPage as { "@id"?: string } | undefined)?.["@id"] === `${BASE}${postPath}`
);
check(
  "article_jsonld_publisher",
  (ld?.publisher as { name?: string } | undefined)?.name === `Phase 5d SEO Blog ${stamp}`
);

// ---- 4. Blog home metadata -------------------------------------------------
const home = await fetchDoc(`/${blog.slug}`);
check("home_status_200", home.status === 200, home.status);
check("home_canonical", home.body.includes(`<link rel="canonical" href="${BASE}/${blog.slug}"`));
check("home_og_type_website", metaContent(home.body, "property", "og:type") === "website");
check("home_og_url", metaContent(home.body, "property", "og:url") === `${BASE}/${blog.slug}`);
check("home_og_site_name", metaContent(home.body, "property", "og:site_name") === `Phase 5d SEO Blog ${stamp}`);
const homeLd = jsonLd(home.body) as Record<string, unknown> | null;
check("home_jsonld_type", homeLd?.["@type"] === "Blog", homeLd?.["@type"]);
check("home_jsonld_name", homeLd?.name === `Phase 5d SEO Blog ${stamp}`);
check("home_jsonld_posts", Array.isArray(homeLd?.blogPost) && (homeLd.blogPost as unknown[]).length === 2);
check(
  "home_feed_alternate",
  home.body.includes(`type="application/rss+xml"`) && home.body.includes(`/${blog.slug}/feed.xml`)
);

// ---- 5. robots.txt + sitemap index ----------------------------------------
const robots = await fetchDoc("/robots.txt");
check("robots_status_200", robots.status === 200, robots.status);
check("robots_content_type", robots.contentType.includes("text/plain"), robots.contentType);
check("robots_user_agent", /^User-agent: \*$/m.test(robots.body), robots.body.slice(0, 80));
check("robots_disallows_app", /^Disallow: \/dashboard$/m.test(robots.body));
const sitemapLines = robots.body
  .split("\n")
  .filter((l) => l.toLowerCase().startsWith("sitemap:"))
  .map((l) => l.slice("sitemap:".length).trim());
check("robots_lists_sitemaps", sitemapLines.length > 0, robots.body);
check(
  "robots_sitemaps_all_resolve",
  (await Promise.all(sitemapLines.map(async (u) => (await fetch(u, { redirect: "manual" })).status))).every(
    (s) => s === 200
  ),
  sitemapLines
);
check("robots_points_at_this_blog", sitemapLines.includes(`${BASE}/${blog.slug}/sitemap.xml`), sitemapLines);

const index = await fetchDoc("/sitemap.xml");
check("sitemap_index_status_200", index.status === 200, index.status);
check("sitemap_index_content_type", index.contentType.includes("application/xml"), index.contentType);
check("sitemap_index_is_xml", looksLikeXml(index.body, "sitemapindex"), index.body.slice(0, 120));
check("sitemap_index_lists_blog", index.body.includes(`<loc>${BASE}/${blog.slug}/sitemap.xml</loc>`));

// ---- 6. Empty blog: valid empty feed + one-URL sitemap --------------------
const emptyFeed = await fetchDoc(`/${emptyBlog.slug}/feed.xml`);
check("empty_feed_status_200", emptyFeed.status === 200, emptyFeed.status);
check("empty_feed_is_rss", looksLikeXml(emptyFeed.body, "rss"), emptyFeed.body.slice(0, 120));
check("empty_feed_has_no_items", !emptyFeed.body.includes("<item>"), "unexpected item");
check("empty_feed_has_channel", emptyFeed.body.includes(`<link>${BASE}/${emptyBlog.slug}</link>`));
const emptySitemap = await fetchDoc(`/${emptyBlog.slug}/sitemap.xml`);
check("empty_sitemap_status_200", emptySitemap.status === 200, emptySitemap.status);
check("empty_sitemap_is_xml", looksLikeXml(emptySitemap.body, "urlset"), emptySitemap.body.slice(0, 120));
check("empty_sitemap_one_url", (emptySitemap.body.match(/<url>/g) ?? []).length === 1);

// ---- 7. Unknown blog -> real 404 (never an empty document) ---------------
const unknownSitemap = await fetchDoc(`/no-such-blog-${stamp}/sitemap.xml`);
check("unknown_blog_sitemap_404", unknownSitemap.status === 404, unknownSitemap.status);
const unknownFeed = await fetchDoc(`/no-such-blog-${stamp}/feed.xml`);
check("unknown_blog_feed_404", unknownFeed.status === 404, unknownFeed.status);

// ---- 8. Isolation: this blog's URLs never appear under another blog ------
const other = await get<{ slug: string }>("SELECT slug FROM blogs WHERE id = 3");
if (other) {
  const otherFeed = await fetchDoc(`/${other.slug}/feed.xml`);
  check("isolation_other_feed", !otherFeed.body.includes(`Phase 5d SEO Blog ${stamp}`), "temp blog leaked");
  const otherSitemap = await fetchDoc(`/${other.slug}/sitemap.xml`);
  check("isolation_other_sitemap", !otherSitemap.body.includes(blog.slug), "temp blog leaked into blog 3 sitemap");
}

// ---- Cleanup ---------------------------------------------------------------
await run("DELETE FROM blogs WHERE id IN (?, ?)", blog.id, emptyBlog.id);
const leftovers = {
  blogs: Number(
    (await get<{ n: unknown }>("SELECT COUNT(*) AS n FROM blogs WHERE id IN (?, ?)", blog.id, emptyBlog.id))?.n ?? 0
  ),
  posts: Number(
    (
      await get<{ n: unknown }>(
        "SELECT COUNT(*) AS n FROM posts WHERE blog_id IN (?, ?)",
        blog.id,
        emptyBlog.id
      )
    )?.n ?? 0
  ),
  pages: Number(
    (
      await get<{ n: unknown }>(
        "SELECT COUNT(*) AS n FROM pages WHERE blog_id IN (?, ?)",
        blog.id,
        emptyBlog.id
      )
    )?.n ?? 0
  ),
};
out.cleanup = leftovers;
check("cleanup_complete", Object.values(leftovers).every((n) => n === 0), leftovers);
check("deleted_blog_sitemap_404", (await fetchDoc(`/${blog.slug}/sitemap.xml`)).status === 404);

out.failures = failures;
out.passed = failures.length === 0;
out.checks = Object.keys(out).length;
console.log(JSON.stringify(out, null, 2));
if (failures.length > 0) {
  console.error(`\nFAILED ${failures.length} check(s): ${failures.join(", ")}`);
  process.exit(1);
}
