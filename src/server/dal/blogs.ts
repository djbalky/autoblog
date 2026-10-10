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

/**
 * Gallery card row for the dashboard: one blog the user is a member of, with
 * real counters and the real blog_settings summary attached.
 *
 * Every number here comes from the database (0 is a real, honest 0).
 * Counts arrive as bigint from Postgres, so they are coerced to numbers.
 */
export interface BlogCardRow extends BlogRow {
  post_count: number;
  published_count: number;
  page_count: number;
  member_role: string;
  posts_per_day: number | null;
  auto_publish: number | null;
  language: string | null;
  timezone: string | null;
  monetization_active: number | null;
  settings_updated_at: string | null;
}

export async function listBlogCardsForUser(
  userId: number
): Promise<BlogCardRow[]> {
  const rows = await all<Record<string, unknown>>(
    `SELECT b.*,
            bm.role AS member_role,
            (SELECT COUNT(*) FROM posts p WHERE p.blog_id = b.id) AS post_count,
            (SELECT COUNT(*) FROM posts p WHERE p.blog_id = b.id AND p.status = 'published') AS published_count,
            (SELECT COUNT(*) FROM pages pg WHERE pg.blog_id = b.id) AS page_count,
            s.posts_per_day       AS posts_per_day,
            s.auto_publish        AS auto_publish,
            s.language            AS language,
            s.timezone            AS timezone,
            s.monetization_active AS monetization_active,
            s.updated_at          AS settings_updated_at
     FROM blogs b
     JOIN blog_members bm ON bm.blog_id = b.id
     LEFT JOIN blog_settings s ON s.blog_id = b.id
     WHERE bm.user_id = ?
     ORDER BY b.created_at DESC, b.id DESC`,
    userId
  );
  return rows.map((r) => ({
    ...(r as unknown as BlogRow),
    post_count: num(r.post_count),
    published_count: num(r.published_count),
    page_count: num(r.page_count),
    member_role: String(r.member_role ?? "member"),
    posts_per_day: r.posts_per_day == null ? null : num(r.posts_per_day),
    auto_publish: r.auto_publish == null ? null : num(r.auto_publish),
    language: r.language == null ? null : String(r.language),
    timezone: r.timezone == null ? null : String(r.timezone),
    monetization_active:
      r.monetization_active == null ? null : num(r.monetization_active),
    settings_updated_at:
      r.settings_updated_at == null ? null : String(r.settings_updated_at),
  }));
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function countBlogsForUser(userId: number): Promise<number> {
  const row = await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM blog_members WHERE user_id = ?`,
    userId
  );
  // Postgres returns COUNT(*) as bigint (a string) — coerce to a real number.
  return Number(row?.n ?? 0) || 0;
}

export async function countBlogsTotal(): Promise<number> {
  const row = await get<{ n: number }>("SELECT COUNT(*) AS n FROM blogs");
  return Number(row?.n ?? 0) || 0;
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
