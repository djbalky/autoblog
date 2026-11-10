/**
 * Autonoblog — DAL: the PUBLIC (anonymous) read layer (Phase 5c).
 *
 * This is the only module that reads content for a visitor who is not signed
 * in, and it is deliberately narrower than the member-scoped DALs:
 *
 *  - A blog is publicly visible only when `blogs.status = 'active'`. A draft or
 *    archived blog is indistinguishable from a blog that never existed.
 *  - A post is publicly visible only when `status = 'published'` AND it has a
 *    real `published_at` that is not in the future. Draft, pending, scheduled
 *    and trashed rows are excluded by SQL, so they cannot leak into the HTML,
 *    into a count, or into an excerpt.
 *  - Pages follow the same rule (`status = 'published'` + `published_at`).
 *  - Every query is scoped by the `blog_id` resolved from the slug in the URL,
 *    so content of one blog can never be rendered under another blog's address.
 *
 * Nothing here is membership-scoped on purpose: this is published, public
 * content. It is also strictly read-only — there is no write path for an
 * anonymous visitor anywhere in this module.
 */
import { all, get } from "../store";
import { mediaPublicPath } from "./media";
import { parseBlocks, suggestExcerpt, type Block } from "../../components/blocks/types";

/** How many published posts the blog home shows per page. */
export const PUBLIC_PAGE_SIZE = 6;

export interface PublicBlog {
  id: number;
  name: string;
  slug: string;
  tagline: string;
  description: string;
  /** Display name of the blog owner (users.display_name) — the fallback author. */
  ownerName: string;
}

export interface PublicImage {
  url: string;
  alt: string;
}

export interface PublicPostCard {
  id: number;
  title: string;
  slug: string;
  excerpt: string;
  publishedAt: string;
  image: PublicImage | null;
}

export interface PublicBlogHome {
  blog: PublicBlog;
  posts: PublicPostCard[];
  /** Total published posts in this blog (real COUNT, not the page length). */
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export type PublicContentKind = "post" | "page";

export interface PublicContent {
  kind: PublicContentKind;
  blog: PublicBlog;
  id: number;
  title: string;
  slug: string;
  blocks: Block[];
  excerpt: string;
  publishedAt: string;
  /** Real "last changed" timestamp (posts/pages.updated_at) — sitemap + JSON-LD. */
  updatedAt: string;
  /** Author display name, or the blog owner's when the row has no author. */
  authorName: string;
  /**
   * The content's own lead image (featured media, else the first image block),
   * used for `og:image` and JSON-LD. Null when the content really has none.
   */
  image: PublicImage | null;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

/** A stored image URL is only usable when it is http(s) or root-relative. */
const SAFE_IMAGE_URL = /^(https?:\/\/|\/)/i;
function safeImage(url: string, alt: string): PublicImage | null {
  const u = url.trim();
  if (!u || u === "/" || u === "#") return null;
  return SAFE_IMAGE_URL.test(u) ? { url: u, alt } : null;
}

/** First usable image inside a block list (used as the card thumbnail). */
function firstImageInBlocks(blocks: Block[]): PublicImage | null {
  for (const b of blocks) {
    if (b.type === "image") {
      const img = safeImage(b.data.url, b.data.caption || b.data.alt || "");
      if (img) return img;
    }
  }
  return null;
}

// ---- Blog lookup -----------------------------------------------------------

/** The active blog for this public slug, or null (draft/archived/unknown). */
export async function getPublicBlog(slug: string): Promise<PublicBlog | null> {
  const clean = (slug ?? "").trim().toLowerCase();
  if (!clean) return null;
  const row = await get<Record<string, unknown>>(
    `SELECT b.id, b.name, b.slug, b.tagline, b.description, u.display_name AS owner_name
       FROM blogs b
       LEFT JOIN users u ON u.id = b.owner_id
      WHERE b.slug = ? AND b.status = 'active'`,
    clean
  );
  if (!row) return null;
  return {
    id: num(row.id),
    name: str(row.name),
    slug: str(row.slug),
    tagline: str(row.tagline),
    description: str(row.description),
    ownerName: str(row.owner_name),
  };
}

// ---- Blog home -------------------------------------------------------------

/** Real count of published posts in a blog. */
export async function countPublishedPosts(blogId: number, now: string): Promise<number> {
  const row = await get<{ n: unknown }>(
    `SELECT COUNT(*) AS n FROM posts
      WHERE blog_id = ? AND status = 'published'
        AND published_at IS NOT NULL AND published_at <= ?`,
    blogId,
    now
  );
  return num(row?.n);
}

/**
 * One page of published posts, newest first.
 * `offset` is clamped by the caller (the loader recomputes the page from the
 * real total), so a page past the end renders the real last page instead of an
 * empty screen with a "next" link that leads nowhere.
 */
export async function listPublishedPostCards(
  blogId: number,
  now: string,
  limit: number,
  offset: number
): Promise<PublicPostCard[]> {
  const rows = await all<Record<string, unknown>>(
    `SELECT p.id, p.title, p.slug, p.excerpt, p.content, p.published_at,
            m.id AS media_id, m.alt_text AS media_alt, m.file_name AS media_name
       FROM posts p
       LEFT JOIN media m ON m.id = p.featured_media_id AND m.blog_id = p.blog_id
      WHERE p.blog_id = ? AND p.status = 'published'
        AND p.published_at IS NOT NULL AND p.published_at <= ?
      ORDER BY p.published_at DESC, p.id DESC
      LIMIT ? OFFSET ?`,
    blogId,
    now,
    limit,
    offset
  );
  return rows.map((r) => {
    const parsed = parseBlocks(str(r.content));
    const featured =
      r.media_id != null
        ? safeImage(mediaPublicPath(num(r.media_id)), str(r.media_alt) || str(r.media_name))
        : null;
    const excerpt = str(r.excerpt).trim() || suggestExcerpt(parsed.blocks);
    return {
      id: num(r.id),
      title: str(r.title),
      slug: str(r.slug),
      excerpt,
      publishedAt: str(r.published_at),
      image: featured ?? firstImageInBlocks(parsed.blocks),
    };
  });
}

/** The whole blog home payload for one page number (1-based). */
export async function getPublicBlogHome(
  slug: string,
  requestedPage: number,
  now: string
): Promise<PublicBlogHome | null> {
  const blog = await getPublicBlog(slug);
  if (!blog) return null;
  const total = await countPublishedPosts(blog.id, now);
  const totalPages = Math.max(1, Math.ceil(total / PUBLIC_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), totalPages);
  const posts = await listPublishedPostCards(
    blog.id,
    now,
    PUBLIC_PAGE_SIZE,
    (page - 1) * PUBLIC_PAGE_SIZE
  );
  return { blog, posts, total, page, pageSize: PUBLIC_PAGE_SIZE, totalPages };
}

// ---- Single post / page ----------------------------------------------------

/**
 * Resolve `/<blog-slug>/<slug>` to published content.
 *
 * Deterministic resolution: a PUBLISHED POST wins over a published page with
 * the same slug (posts and pages live in separate tables, so the same slug can
 * exist in both; the post is the primary content type of a blog). A page is
 * only considered when no published post has that slug. Anything not published
 * — in either table — resolves to null, i.e. a real 404.
 */
export async function getPublicContent(
  blogSlug: string,
  contentSlug: string,
  now: string
): Promise<PublicContent | null> {
  const blog = await getPublicBlog(blogSlug);
  if (!blog) return null;
  const slug = (contentSlug ?? "").trim().toLowerCase();
  if (!slug) return null;

  const post = await get<Record<string, unknown>>(
    `SELECT p.id, p.title, p.slug, p.content, p.excerpt, p.published_at, p.updated_at,
            a.display_name AS author_name,
            m.id AS media_id, m.alt_text AS media_alt, m.file_name AS media_name
       FROM posts p
       LEFT JOIN authors a ON a.id = p.author_id AND a.blog_id = p.blog_id
       LEFT JOIN media m ON m.id = p.featured_media_id AND m.blog_id = p.blog_id
      WHERE p.blog_id = ? AND p.slug = ? AND p.status = 'published'
        AND p.published_at IS NOT NULL AND p.published_at <= ?`,
    blog.id,
    slug,
    now
  );
  if (post) {
    const parsed = parseBlocks(str(post.content));
    const featured =
      post.media_id != null
        ? safeImage(mediaPublicPath(num(post.media_id)), str(post.media_alt) || str(post.media_name))
        : null;
    return {
      kind: "post",
      blog,
      id: num(post.id),
      title: str(post.title),
      slug: str(post.slug),
      blocks: parsed.blocks,
      excerpt: str(post.excerpt).trim() || suggestExcerpt(parsed.blocks),
      publishedAt: str(post.published_at),
      updatedAt: str(post.updated_at) || str(post.published_at),
      authorName: str(post.author_name).trim() || blog.ownerName || blog.name,
      image: featured ?? firstImageInBlocks(parsed.blocks),
    };
  }

  const page = await get<Record<string, unknown>>(
    `SELECT id, title, slug, content, published_at, updated_at
       FROM pages
      WHERE blog_id = ? AND slug = ? AND status = 'published'
        AND published_at IS NOT NULL AND published_at <= ?`,
    blog.id,
    slug,
    now
  );
  if (!page) return null;
  const parsed = parseBlocks(str(page.content));
  return {
    kind: "page",
    blog,
    id: num(page.id),
    title: str(page.title),
    slug: str(page.slug),
    blocks: parsed.blocks,
    excerpt: (parsed.meta.excerpt ?? "").trim() || suggestExcerpt(parsed.blocks),
    publishedAt: str(page.published_at),
    updatedAt: str(page.updated_at) || str(page.published_at),
    authorName: blog.ownerName || blog.name,
    image: firstImageInBlocks(parsed.blocks),
  };
}

// ---- Sitemap / feed / robots data (Phase 5d) --------------------------------

/** One absolute-URL-ready entry: the path under the blog plus its real lastmod. */
export interface SitemapEntry {
  path: string;
  lastmod: string;
}

export interface PublicSitemap {
  blog: PublicBlog;
  /** Blog home first, then published posts (newest first), then published pages. */
  entries: SitemapEntry[];
}

/**
 * Everything `/<blog-slug>/sitemap.xml` may list — and nothing else.
 *
 * The SAME visibility rule as the public pages is applied in SQL (active blog,
 * `status = 'published'`, a real non-future `published_at`), so drafts,
 * scheduled, trashed and future-dated rows cannot reach a search engine through
 * the sitemap even though they never render. `lastmod` is the row's real
 * `updated_at`.
 */
export async function getPublicSitemap(slug: string, now: string): Promise<PublicSitemap | null> {
  const blog = await getPublicBlog(slug);
  if (!blog) return null;

  const blogRow = await get<{ updated_at: unknown }>(
    "SELECT updated_at FROM blogs WHERE id = ?",
    blog.id
  );

  const posts = await all<Record<string, unknown>>(
    `SELECT slug, updated_at, published_at FROM posts
      WHERE blog_id = ? AND status = 'published'
        AND published_at IS NOT NULL AND published_at <= ?
      ORDER BY published_at DESC, id DESC`,
    blog.id,
    now
  );
  const pages = await all<Record<string, unknown>>(
    `SELECT slug, updated_at, published_at FROM pages
      WHERE blog_id = ? AND status = 'published'
        AND published_at IS NOT NULL AND published_at <= ?
      ORDER BY published_at DESC, id DESC`,
    blog.id,
    now
  );

  const postEntries: SitemapEntry[] = posts.map((r) => ({
    path: `/${blog.slug}/${str(r.slug)}`,
    lastmod: str(r.updated_at) || str(r.published_at),
  }));
  const pageEntries: SitemapEntry[] = pages.map((r) => ({
    path: `/${blog.slug}/${str(r.slug)}`,
    lastmod: str(r.updated_at) || str(r.published_at),
  }));

  // The blog home changes whenever the blog or any of its published content
  // changes, so its lastmod is the newest of those real timestamps.
  const homeLastmod = [str(blogRow?.updated_at), ...postEntries.map((e) => e.lastmod), ...pageEntries.map((e) => e.lastmod)]
    .filter(Boolean)
    .sort()
    .pop();

  return {
    blog,
    entries: [{ path: `/${blog.slug}`, lastmod: homeLastmod ?? "" }, ...postEntries, ...pageEntries],
  };
}

export interface PublicFeedItem {
  title: string;
  path: string;
  publishedAt: string;
  updatedAt: string;
  excerpt: string;
  authorName: string;
}

export interface PublicFeed {
  blog: PublicBlog;
  items: PublicFeedItem[];
}

/**
 * The latest N published posts for `/<blog-slug>/feed.xml` — same SQL
 * visibility rule as the public pages. A blog with no published posts returns a
 * valid feed with zero items (the caller renders the empty channel).
 */
export async function getPublicFeed(slug: string, now: string, limit = 20): Promise<PublicFeed | null> {
  const blog = await getPublicBlog(slug);
  if (!blog) return null;
  const rows = await all<Record<string, unknown>>(
    `SELECT p.title, p.slug, p.excerpt, p.content, p.published_at, p.updated_at,
            a.display_name AS author_name
       FROM posts p
       LEFT JOIN authors a ON a.id = p.author_id AND a.blog_id = p.blog_id
      WHERE p.blog_id = ? AND p.status = 'published'
        AND p.published_at IS NOT NULL AND p.published_at <= ?
      ORDER BY p.published_at DESC, p.id DESC
      LIMIT ?`,
    blog.id,
    now,
    limit
  );
  return {
    blog,
    items: rows.map((r) => {
      const parsed = parseBlocks(str(r.content));
      return {
        title: str(r.title),
        path: `/${blog.slug}/${str(r.slug)}`,
        publishedAt: str(r.published_at),
        updatedAt: str(r.updated_at) || str(r.published_at),
        excerpt: str(r.excerpt).trim() || suggestExcerpt(parsed.blocks),
        authorName: str(r.author_name).trim() || blog.ownerName || blog.name,
      };
    }),
  };
}

/** Slugs of every publicly visible (active) blog — for the root sitemap index. */
export async function listActiveBlogSlugs(): Promise<string[]> {
  const rows = await all<{ slug: unknown }>(
    "SELECT slug FROM blogs WHERE status = 'active' ORDER BY slug ASC"
  );
  return rows.map((r) => str(r.slug)).filter(Boolean);
}
