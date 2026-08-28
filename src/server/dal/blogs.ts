/**
 * Autonoblog — DAL: blogs + blog settings + membership.
 */

import { all, get, run, nowIso } from "../store";

export interface BlogRow {
  id: number;
  owner_id: number;
  name: string;
  slug: string;
  tagline: string;
  description: string;
  status: "draft" | "active" | "archived";
  created_at: string;
  updated_at: string;
}

export interface BlogWithCount extends BlogRow {
  post_count: number;
}

export interface BlogSettingsRow {
  id: number;
  blog_id: number;
  language: string;
  timezone: string;
  posts_per_day: number;
  auto_publish: number;
  allow_comments: number;
  monetization_active: number;
  seo_title_template: string;
  updated_at: string;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function uniqueSlug(base: string): Promise<string> {
  const slug = slugify(base) || "blog";
  // If the slug is taken, append a short random suffix.
  const exists = await get<{ id: number }>(
    "SELECT id FROM blogs WHERE slug = ?",
    slug
  );
  if (!exists) return slug;
  return `${slug}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createBlog(input: {
  ownerId: number;
  name: string;
  tagline?: string;
  description?: string;
  language?: string;
  timezone?: string;
}): Promise<BlogRow> {
  const now = nowIso();
  const slug = await uniqueSlug(input.name);
  const info = await run(
    `INSERT INTO blogs
       (owner_id, name, slug, tagline, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
    input.ownerId,
    input.name,
    slug,
    input.tagline ?? "",
    input.description ?? "",
    now,
    now
  );
  // Default settings row (1:1 with blog), created lazily here.
  await run(
    `INSERT OR IGNORE INTO blog_settings
       (blog_id, language, timezone, posts_per_day, auto_publish, allow_comments, monetization_active, seo_title_template, updated_at)
     VALUES (?, ?, ?, 2, 0, 1, 0, '', ?)`,
    info.lastInsertRowid,
    input.language ?? "en",
    input.timezone ?? "UTC",
    now
  );
  // Owner becomes the blog's owner-member for permission checks.
  await run(
    `INSERT OR IGNORE INTO blog_members (blog_id, user_id, role, created_at)
     VALUES (?, ?, 'owner', ?)`,
    info.lastInsertRowid,
    input.ownerId,
    now
  );
  return (await get<BlogRow>(
    "SELECT * FROM blogs WHERE id = ?",
    info.lastInsertRowid
  ))!;
}

export async function getBlog(id: number): Promise<BlogRow | undefined> {
  return get<BlogRow>("SELECT * FROM blogs WHERE id = ?", id);
}

export async function getBlogBySlug(
  slug: string
): Promise<BlogRow | undefined> {
  return get<BlogRow>("SELECT * FROM blogs WHERE slug = ?", slug);
}

export async function getBlogSettings(
  blogId: number
): Promise<BlogSettingsRow | undefined> {
  return get<BlogSettingsRow>(
    "SELECT * FROM blog_settings WHERE blog_id = ?",
    blogId
  );
}

export async function listBlogsForUser(userId: number): Promise<BlogWithCount[]> {
  return all<BlogWithCount>(
    `SELECT b.*, (SELECT COUNT(*) FROM posts p WHERE p.blog_id = b.id) AS post_count
     FROM blogs b
     JOIN blog_members bm ON bm.blog_id = b.id
     WHERE bm.user_id = ?
     ORDER BY b.created_at DESC`,
    userId
  );
}

export async function countBlogsForUser(userId: number): Promise<number> {
  const row = await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM blog_members WHERE user_id = ?`,
    userId
  );
  return row?.n ?? 0;
}

export async function countBlogsTotal(): Promise<number> {
  const row = await get<{ n: number }>("SELECT COUNT(*) AS n FROM blogs");
  return row?.n ?? 0;
}

export async function updateBlog(
  id: number,
  patch: Partial<BlogRow>
): Promise<void> {
  const current = await getBlog(id);
  if (!current) return;
  const now = nowIso();
  await run(
    "UPDATE blogs SET name = ?, tagline = ?, description = ?, status = ?, updated_at = ? WHERE id = ?",
    patch.name ?? current.name,
    patch.tagline ?? current.tagline,
    patch.description ?? current.description,
    patch.status ?? current.status,
    now,
    id
  );
}
