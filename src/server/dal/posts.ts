/**
 * Autonoblog — DAL: posts + revisions.
 *
 * Two layers live here:
 *  - the raw CRUD helpers (createPost/updatePost/…) used by seeds and shells;
 *  - the *membership-scoped* helpers used by every Phase-4 route. Every read or
 *    write in the second layer is filtered through `blog_members`, so a user who
 *    is not a member of a blog can never list, read, edit or publish its posts —
 *    the SQL returns nothing and the caller reports a real 403/not-found.
 */

import { get, run, all, nowIso } from "../store";
import { slugify } from "./blogs";

export type PostStatus = "draft" | "pending" | "published" | "scheduled" | "trashed";

export interface PostRow {
  id: number;
  blog_id: number;
  author_id: number | null;
  title: string;
  slug: string;
  content: string;
  excerpt: string;
  status: PostStatus;
  featured_media_id: number | null;
  published_at: string | null;
  scheduled_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One row of the posts table (list view). */
export interface PostListItem {
  id: number;
  title: string;
  slug: string;
  excerpt: string;
  status: PostStatus;
  updated_at: string;
  published_at: string | null;
  scheduled_at: string | null;
}

export interface PostRevisionRow {
  id: number;
  post_id: number;
  revision: number;
  title: string;
  content: string;
  excerpt: string;
  created_by: number | null;
  created_at: string;
  author_name: string | null;
}

export interface BlogMembership {
  blog_id: number;
  role: string;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---- Raw helpers -----------------------------------------------------------

export async function createPost(input: {
  blogId: number;
  authorId?: number | null;
  title: string;
  content?: string;
  excerpt?: string;
  status?: PostStatus;
  slug?: string;
  createdByUserId?: number | null;
}): Promise<PostRow> {
  const now = nowIso();
  const baseSlug = slugify(input.slug ?? input.title) || "post";
  let slug = baseSlug;
  // Ensure uniqueness within the blog.
  if (
    await get<{ id: number }>(
      "SELECT id FROM posts WHERE blog_id = ? AND slug = ?",
      input.blogId,
      slug
    )
  ) {
    slug = `${baseSlug}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const status = input.status ?? "draft";
  const info = await run(
    `INSERT INTO posts
       (blog_id, author_id, title, slug, content, excerpt, status, published_at, scheduled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.blogId,
    input.authorId ?? null,
    input.title,
    slug,
    input.content ?? "",
    input.excerpt ?? "",
    status,
    status === "published" ? now : null,
    null,
    now,
    now
  );
  // Create an initial revision.
  await run(
    `INSERT INTO post_revisions (post_id, revision, title, content, excerpt, created_by, created_at)
     VALUES (?, 1, ?, ?, ?, ?, ?)`,
    info.lastInsertRowid,
    input.title,
    input.content ?? "",
    input.excerpt ?? "",
    input.createdByUserId ?? input.authorId ?? null,
    now
  );
  return (await get<PostRow>("SELECT * FROM posts WHERE id = ?", info.lastInsertRowid))!;
}

export async function getPost(id: number): Promise<PostRow | undefined> {
  return get<PostRow>("SELECT * FROM posts WHERE id = ?", id);
}

export async function listPostsForBlog(blogId: number): Promise<PostRow[]> {
  return all<PostRow>(
    "SELECT * FROM posts WHERE blog_id = ? ORDER BY created_at DESC",
    blogId
  );
}

export async function countPostsForBlog(blogId: number): Promise<number> {
  const row = await get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM posts WHERE blog_id = ?",
    blogId
  );
  return num(row?.n);
}

/** Save a new revision + update the post. */
export async function updatePost(
  id: number,
  patch: Partial<Omit<PostRow, "id" | "blog_id" | "created_at">>,
  revisionBy?: number
): Promise<PostRow | undefined> {
  const current = await getPost(id);
  if (!current) return undefined;
  const now = nowIso();
  const next = { ...current, ...patch, updated_at: now };
  await run(
    `UPDATE posts SET title = ?, content = ?, excerpt = ?, status = ?, published_at = ?, scheduled_at = ?, updated_at = ?
     WHERE id = ?`,
    next.title,
    next.content,
    next.excerpt,
    next.status,
    next.published_at,
    next.scheduled_at,
    now,
    id
  );
  await insertRevision(id, next.title, next.content, next.excerpt, revisionBy ?? current.author_id);
  return getPost(id);
}

async function nextRevisionNumber(postId: number): Promise<number> {
  const row = await get<{ n: number }>(
    "SELECT COALESCE(MAX(revision), 0) AS n FROM post_revisions WHERE post_id = ?",
    postId
  );
  return num(row?.n) + 1;
}

async function insertRevision(
  postId: number,
  title: string,
  content: string,
  excerpt: string,
  createdBy: number | null
): Promise<void> {
  const n = await nextRevisionNumber(postId);
  await run(
    `INSERT INTO post_revisions (post_id, revision, title, content, excerpt, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    postId,
    n,
    title,
    content,
    excerpt,
    createdBy,
    nowIso()
  );
}

// ---- Membership-scoped API (everything the Phase-4 UI calls) ---------------

/** The caller's membership of a blog, or null when they are not a member. */
export async function getBlogMembership(
  blogId: number,
  userId: number
): Promise<BlogMembership | null> {
  const row = await get<{ blog_id: number; role: string }>(
    "SELECT blog_id, role FROM blog_members WHERE blog_id = ? AND user_id = ?",
    blogId,
    userId
  );
  return row ? { blog_id: num(row.blog_id), role: String(row.role) } : null;
}

/** Posts of a blog the caller is a member of (empty array otherwise). */
export async function listPostsForMember(
  blogId: number,
  userId: number
): Promise<PostListItem[]> {
  const rows = await all<Record<string, unknown>>(
    `SELECT p.id, p.title, p.slug, p.excerpt, p.status, p.updated_at, p.published_at, p.scheduled_at
     FROM posts p
     JOIN blog_members bm ON bm.blog_id = p.blog_id AND bm.user_id = ?
     WHERE p.blog_id = ?
     ORDER BY COALESCE(p.updated_at, p.created_at) DESC, p.id DESC`,
    userId,
    blogId
  );
  return rows.map((r) => ({
    id: num(r.id),
    title: String(r.title ?? ""),
    slug: String(r.slug ?? ""),
    excerpt: String(r.excerpt ?? ""),
    status: String(r.status ?? "draft") as PostStatus,
    updated_at: String(r.updated_at ?? ""),
    published_at: r.published_at == null ? null : String(r.published_at),
    scheduled_at: r.scheduled_at == null ? null : String(r.scheduled_at),
  }));
}

/** Counts per status for a blog, membership-scoped. */
export async function postStatusCounts(
  blogId: number,
  userId: number
): Promise<Record<string, number>> {
  const rows = await all<{ status: string; n: unknown }>(
    `SELECT p.status, COUNT(*) AS n
     FROM posts p
     JOIN blog_members bm ON bm.blog_id = p.blog_id AND bm.user_id = ?
     WHERE p.blog_id = ?
     GROUP BY p.status`,
    userId,
    blogId
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.status)] = num(r.n);
  return out;
}

/** A single post, only if the caller is a member of its blog. */
export async function getPostForMember(
  postId: number,
  userId: number
): Promise<PostRow | null> {
  const row = await get<PostRow>(
    `SELECT p.*
     FROM posts p
     JOIN blog_members bm ON bm.blog_id = p.blog_id AND bm.user_id = ?
     WHERE p.id = ?`,
    userId,
    postId
  );
  return row ?? null;
}

export async function listRevisionsForMember(
  postId: number,
  userId: number
): Promise<PostRevisionRow[]> {
  const rows = await all<Record<string, unknown>>(
    `SELECT r.*, u.display_name AS author_name
     FROM post_revisions r
     JOIN posts p ON p.id = r.post_id
     JOIN blog_members bm ON bm.blog_id = p.blog_id AND bm.user_id = ?
     LEFT JOIN users u ON u.id = r.created_by
     WHERE r.post_id = ?
     ORDER BY r.revision DESC`,
    userId,
    postId
  );
  return rows.map((r) => ({
    id: num(r.id),
    post_id: num(r.post_id),
    revision: num(r.revision),
    title: String(r.title ?? ""),
    content: String(r.content ?? ""),
    excerpt: String(r.excerpt ?? ""),
    created_by: r.created_by == null ? null : num(r.created_by),
    created_at: String(r.created_at ?? ""),
    author_name: r.author_name == null ? null : String(r.author_name),
  }));
}

/** Create a post in a blog the caller belongs to. Returns null when not a member. */
export async function createPostForMember(
  blogId: number,
  userId: number,
  input: { title: string; content?: string; excerpt?: string; slug?: string }
): Promise<PostRow | null> {
  if (!(await getBlogMembership(blogId, userId))) return null;
  return createPost({
    blogId,
    title: input.title,
    content: input.content ?? "",
    excerpt: input.excerpt ?? "",
    status: "draft",
    slug: input.slug,
    createdByUserId: userId,
  });
}

export interface SavePostInput {
  title?: string;
  content?: string;
  excerpt?: string;
  slug?: string;
  status?: PostStatus;
  scheduledAt?: string | null;
  featuredMediaId?: number | null;
}

/**
 * Update a post the caller is a member of and write a NEW revision.
 * Returns null when the post does not exist or the caller is not a member.
 */
export async function savePostForMember(
  postId: number,
  userId: number,
  patch: SavePostInput
): Promise<PostRow | null> {
  const current = await getPostForMember(postId, userId);
  if (!current) return null;
  const now = nowIso();
  const status: PostStatus = patch.status ?? current.status;

  // Slug: keep the existing one unless an explicit, different slug is supplied.
  let slug = current.slug;
  if (patch.slug !== undefined) {
    const wanted = slugify(patch.slug) || current.slug;
    if (wanted !== current.slug) {
      const taken = await get<{ id: number }>(
        "SELECT id FROM posts WHERE blog_id = ? AND slug = ? AND id <> ?",
        current.blog_id,
        wanted,
        postId
      );
      slug = taken ? `${wanted}-${Math.random().toString(36).slice(2, 6)}` : wanted;
    }
  }

  const publishedAt =
    status === "published" ? (current.published_at ?? now) : status === "draft" ? null : current.published_at;
  const scheduledAt =
    patch.scheduledAt !== undefined
      ? patch.scheduledAt
      : status === "scheduled"
        ? current.scheduled_at
        : null;

  const next = {
    title: patch.title ?? current.title,
    content: patch.content ?? current.content,
    excerpt: patch.excerpt ?? current.excerpt,
  };

  const res = await run(
    `UPDATE posts
        SET title = ?, slug = ?, content = ?, excerpt = ?, status = ?,
            published_at = ?, scheduled_at = ?, featured_media_id = ?, updated_at = ?
      WHERE id = ? AND blog_id IN (SELECT blog_id FROM blog_members WHERE user_id = ?)`,
    next.title,
    slug,
    next.content,
    next.excerpt,
    status,
    publishedAt,
    scheduledAt,
    patch.featuredMediaId !== undefined ? patch.featuredMediaId : current.featured_media_id,
    now,
    postId,
    userId
  );
  if (res.changes === 0) return null;

  await insertRevision(postId, next.title, next.content, next.excerpt, userId);
  return getPostForMember(postId, userId);
}

/** Change only the lifecycle status (publish / unpublish / schedule / trash). */
export async function setPostStatusForMember(
  postId: number,
  userId: number,
  status: PostStatus,
  scheduledAt?: string | null
): Promise<PostRow | null> {
  return savePostForMember(postId, userId, { status, scheduledAt });
}

/** Duplicate a post into a new draft with a slug guaranteed unique in the blog. */
export async function duplicatePostForMember(
  postId: number,
  userId: number
): Promise<PostRow | null> {
  const src = await getPostForMember(postId, userId);
  if (!src) return null;
  return createPostForMember(src.blog_id, userId, {
    title: `${src.title} (copy)`,
    content: src.content,
    excerpt: src.excerpt,
  });
}
