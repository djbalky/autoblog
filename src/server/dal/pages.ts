/**
 * Autonoblog — DAL: pages + page revisions (Phase 4b).
 *
 * Pages are the sibling entity of posts: same membership scoping rules, same
 * "every save appends a revision" rule, same lifecycle (draft / scheduled /
 * published / trashed). Every read and write in the member-scoped layer joins
 * `blog_members`, so a user who is not a member of a blog can never list, read,
 * edit, publish or duplicate its pages — the SQL returns nothing and the caller
 * reports a real 403 / not-found.
 *
 * `pages.content` holds the very same block JSON envelope the post editor uses
 * (see components/blocks/types.ts). Since the `pages` table has no excerpt
 * column, the page excerpt lives in that envelope as `excerpt`.
 */

import { get, run, all, nowIso } from "../store";
import { slugify } from "./blogs";
import { getBlogMembership } from "./posts";

export type PageStatus = "draft" | "published" | "scheduled" | "trashed";

export interface PageRow {
  id: number;
  blog_id: number;
  title: string;
  slug: string;
  content: string;
  status: PageStatus;
  published_at: string | null;
  scheduled_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One row of the pages list view. */
export interface PageListItem {
  id: number;
  title: string;
  slug: string;
  status: PageStatus;
  updated_at: string;
  published_at: string | null;
  scheduled_at: string | null;
}

export interface PageRevisionRow {
  id: number;
  page_id: number;
  revision_number: number;
  title: string;
  content: string;
  created_at: string;
  author_id: number | null;
  author_name: string | null;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function asStatus(v: unknown): PageStatus {
  const s = String(v ?? "draft");
  return s === "published" || s === "scheduled" || s === "trashed" ? s : "draft";
}

// ---- Raw helpers -----------------------------------------------------------

export async function createPage(input: {
  blogId: number;
  title: string;
  content?: string;
  slug?: string;
  status?: PageStatus;
  authorId?: number | null;
}): Promise<PageRow> {
  const now = nowIso();
  const baseSlug = slugify(input.slug ?? input.title) || "page";
  let slug = baseSlug;
  // `pages` has UNIQUE(blog_id, slug): never let a second row collide silently.
  if (
    await get<{ id: number }>("SELECT id FROM pages WHERE blog_id = ? AND slug = ?", input.blogId, slug)
  ) {
    slug = `${baseSlug}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const status = input.status ?? "draft";
  const info = await run(
    `INSERT INTO pages (blog_id, title, slug, content, status, published_at, scheduled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.blogId,
    input.title,
    slug,
    input.content ?? "",
    status,
    status === "published" ? now : null,
    null,
    now,
    now
  );
  await insertRevision(info.lastInsertRowid, input.title, input.content ?? "", input.authorId ?? null);
  return (await get<PageRow>("SELECT * FROM pages WHERE id = ?", info.lastInsertRowid))!;
}

export async function getPage(id: number): Promise<PageRow | undefined> {
  return get<PageRow>("SELECT * FROM pages WHERE id = ?", id);
}

export async function listPagesForBlog(blogId: number): Promise<PageRow[]> {
  return all<PageRow>("SELECT * FROM pages WHERE blog_id = ? ORDER BY created_at DESC", blogId);
}

export async function countPagesForBlog(blogId: number): Promise<number> {
  const row = await get<{ n: number }>("SELECT COUNT(*) AS n FROM pages WHERE blog_id = ?", blogId);
  return num(row?.n);
}

async function nextRevisionNumber(pageId: number): Promise<number> {
  const row = await get<{ n: number }>(
    "SELECT COALESCE(MAX(revision_number), 0) AS n FROM page_revisions WHERE page_id = ?",
    pageId
  );
  return num(row?.n) + 1;
}

async function insertRevision(
  pageId: number,
  title: string,
  content: string,
  authorId: number | null
): Promise<number> {
  const n = await nextRevisionNumber(pageId);
  await run(
    `INSERT INTO page_revisions (page_id, revision_number, title, content, created_at, author_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    pageId,
    n,
    title,
    content,
    nowIso(),
    authorId
  );
  return n;
}

// ---- Membership-scoped API (everything the Phase-4b UI calls) --------------

/** Pages of a blog the caller is a member of (empty array otherwise). */
export async function listPagesForMember(
  blogId: number,
  userId: number
): Promise<PageListItem[]> {
  const rows = await all<Record<string, unknown>>(
    `SELECT p.id, p.title, p.slug, p.status, p.updated_at, p.published_at, p.scheduled_at
     FROM pages p
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
    status: asStatus(r.status),
    updated_at: String(r.updated_at ?? ""),
    published_at: r.published_at == null ? null : String(r.published_at),
    scheduled_at: r.scheduled_at == null ? null : String(r.scheduled_at),
  }));
}

/** Counts per status for a blog, membership-scoped. */
export async function pageStatusCounts(
  blogId: number,
  userId: number
): Promise<Record<string, number>> {
  const rows = await all<{ status: string; n: unknown }>(
    `SELECT p.status, COUNT(*) AS n
     FROM pages p
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

/** A single page, only if the caller is a member of its blog. */
export async function getPageForMember(
  pageId: number,
  userId: number
): Promise<PageRow | null> {
  const row = await get<Record<string, unknown>>(
    `SELECT p.*
     FROM pages p
     JOIN blog_members bm ON bm.blog_id = p.blog_id AND bm.user_id = ?
     WHERE p.id = ?`,
    userId,
    pageId
  );
  if (!row) return null;
  return {
    id: num(row.id),
    blog_id: num(row.blog_id),
    title: String(row.title ?? ""),
    slug: String(row.slug ?? ""),
    content: String(row.content ?? ""),
    status: asStatus(row.status),
    published_at: row.published_at == null ? null : String(row.published_at),
    scheduled_at: row.scheduled_at == null ? null : String(row.scheduled_at),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

export async function listPageRevisionsForMember(
  pageId: number,
  userId: number
): Promise<PageRevisionRow[]> {
  const rows = await all<Record<string, unknown>>(
    `SELECT r.*, u.display_name AS author_name
     FROM page_revisions r
     JOIN pages p ON p.id = r.page_id
     JOIN blog_members bm ON bm.blog_id = p.blog_id AND bm.user_id = ?
     LEFT JOIN users u ON u.id = r.author_id
     WHERE r.page_id = ?
     ORDER BY r.revision_number DESC`,
    userId,
    pageId
  );
  return rows.map((r) => ({
    id: num(r.id),
    page_id: num(r.page_id),
    revision_number: num(r.revision_number),
    title: String(r.title ?? ""),
    content: String(r.content ?? ""),
    created_at: String(r.created_at ?? ""),
    author_id: r.author_id == null ? null : num(r.author_id),
    author_name: r.author_name == null ? null : String(r.author_name),
  }));
}

/** Create a page in a blog the caller belongs to. Returns null when not a member. */
export async function createPageForMember(
  blogId: number,
  userId: number,
  input: { title: string; content?: string; slug?: string; status?: PageStatus }
): Promise<PageRow | null> {
  if (!(await getBlogMembership(blogId, userId))) return null;
  return createPage({
    blogId,
    title: input.title,
    content: input.content ?? "",
    slug: input.slug,
    status: input.status ?? "draft",
    authorId: userId,
  });
}

export interface SavePageInput {
  title?: string;
  content?: string;
  slug?: string;
  status?: PageStatus;
  scheduledAt?: string | null;
}

/**
 * Update a page the caller is a member of and write a NEW `page_revisions` row.
 * Returns null when the page does not exist or the caller is not a member.
 * `revisionNumber` (when returned) is the revision this save created.
 */
export async function savePageForMember(
  pageId: number,
  userId: number,
  patch: SavePageInput
): Promise<{ page: PageRow; revisionNumber: number } | null> {
  const current = await getPageForMember(pageId, userId);
  if (!current) return null;
  const now = nowIso();
  const status: PageStatus = patch.status ?? current.status;

  // Slug: keep the existing one unless an explicit, different slug is supplied.
  let slug = current.slug;
  if (patch.slug !== undefined) {
    const wanted = slugify(patch.slug) || current.slug;
    if (wanted !== current.slug) {
      const taken = await get<{ id: number }>(
        "SELECT id FROM pages WHERE blog_id = ? AND slug = ? AND id <> ?",
        current.blog_id,
        wanted,
        pageId
      );
      slug = taken ? `${wanted}-${Math.random().toString(36).slice(2, 6)}` : wanted;
    }
  }

  // published_at is set ONCE on publish and cleared when the page leaves
  // "published"; scheduling never touches it.
  const publishedAt =
    status === "published"
      ? (current.published_at ?? now)
      : status === "draft" || status === "trashed"
        ? null
        : current.published_at;
  const scheduledAt =
    patch.scheduledAt !== undefined
      ? patch.scheduledAt
      : status === "scheduled"
        ? current.scheduled_at
        : null;

  const next = {
    title: patch.title ?? current.title,
    content: patch.content ?? current.content,
  };

  const res = await run(
    `UPDATE pages
        SET title = ?, slug = ?, content = ?, status = ?, published_at = ?, scheduled_at = ?, updated_at = ?
      WHERE id = ? AND blog_id IN (SELECT blog_id FROM blog_members WHERE user_id = ?)`,
    next.title,
    slug,
    next.content,
    status,
    publishedAt,
    scheduledAt,
    now,
    pageId,
    userId
  );
  if (res.changes === 0) return null;

  const revisionNumber = await insertRevision(pageId, next.title, next.content, userId);
  const page = await getPageForMember(pageId, userId);
  return page ? { page, revisionNumber } : null;
}

/** Change only the lifecycle status (publish / unpublish / schedule / trash). */
export async function setPageStatusForMember(
  pageId: number,
  userId: number,
  status: PageStatus,
  scheduledAt?: string | null
): Promise<{ page: PageRow; revisionNumber: number } | null> {
  return savePageForMember(pageId, userId, { status, scheduledAt });
}

/** Duplicate a page into a new draft with a slug guaranteed unique in the blog. */
export async function duplicatePageForMember(
  pageId: number,
  userId: number
): Promise<PageRow | null> {
  const src = await getPageForMember(pageId, userId);
  if (!src) return null;
  return createPageForMember(src.blog_id, userId, {
    title: `${src.title} (copy)`,
    content: src.content,
  });
}

/** Permanently delete a page (cascades to its revisions). Member-scoped. */
export async function deletePageForMember(
  pageId: number,
  userId: number
): Promise<boolean> {
  const res = await run(
    `DELETE FROM pages
      WHERE id = ? AND blog_id IN (SELECT blog_id FROM blog_members WHERE user_id = ?)`,
    pageId,
    userId
  );
  return res.changes > 0;
}
