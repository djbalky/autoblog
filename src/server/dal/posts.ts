/**
 * Autonoblog — DAL: posts + revisions (foundation for the block editor phase).
 */

import { get, run, all, nowIso } from "../store";
import { slugify } from "./blogs";

export interface PostRow {
  id: number;
  blog_id: number;
  author_id: number | null;
  title: string;
  slug: string;
  content: string;
  excerpt: string;
  status: "draft" | "pending" | "published" | "scheduled" | "trashed";
  featured_media_id: number | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function createPost(input: {
  blogId: number;
  authorId?: number | null;
  title: string;
  content?: string;
  excerpt?: string;
  status?: PostRow["status"];
  slug?: string;
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
       (blog_id, author_id, title, slug, content, excerpt, status, published_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.blogId,
    input.authorId ?? null,
    input.title,
    slug,
    input.content ?? "",
    input.excerpt ?? "",
    status,
    status === "published" ? now : null,
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
    input.authorId ?? null,
    now
  );
  return (await get<PostRow>(
    "SELECT * FROM posts WHERE id = ?",
    info.lastInsertRowid
  ))!;
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
  return row?.n ?? 0;
}

/** Save a new revision + update the post (used by the future editor). */
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
    `UPDATE posts SET title = ?, content = ?, excerpt = ?, status = ?, published_at = ?, updated_at = ?
     WHERE id = ?`,
    next.title,
    next.content,
    next.excerpt,
    next.status,
    next.published_at,
    now,
    id
  );
  // Bump revision.
  const rev = await get<{ n: number }>(
    "SELECT MAX(revision) AS n FROM post_revisions WHERE post_id = ?",
    id
  );
  const revN = (rev?.n ?? 0) + 1;
  await run(
    `INSERT INTO post_revisions (post_id, revision, title, content, excerpt, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    revN,
    next.title,
    next.content,
    next.excerpt,
    revisionBy ?? current.author_id,
    now
  );
  return getPost(id);
}
