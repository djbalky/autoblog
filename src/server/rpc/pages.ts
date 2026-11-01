/**
 * Autonoblog — server RPCs for Phase 4b: pages + page builder + revisions.
 *
 * Same shape as the Phase-4a post RPCs: resolve the session user, then go
 * through the membership-scoped page DAL. A non-member gets
 * `{ ok: false, forbidden: true }` and the route renders a real 403/not-found.
 * Nothing here reports success it did not write.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireUser } from "../auth-context";
import { ensureInitialized } from "../init";
import { getBlog, type BlogRow } from "../dal/blogs";
import { getBlogMembership } from "../dal/posts";
import {
  listPagesForMember,
  pageStatusCounts,
  getPageForMember,
  listPageRevisionsForMember,
  createPageForMember,
  savePageForMember,
  setPageStatusForMember,
  duplicatePageForMember,
  type PageListItem,
  type PageRevisionRow,
  type PageRow,
  type PageStatus,
} from "../dal/pages";

export interface ActionResult<T = unknown> {
  ok: boolean;
  error?: string;
  forbidden?: boolean;
  notFound?: boolean;
  data?: T;
}

const NOT_MEMBER = "You are not a member of this blog.";
const ALLOWED: PageStatus[] = ["draft", "published", "scheduled", "trashed"];

// ---- Pages list -----------------------------------------------------------

interface BlogIdInput {
  blogId: number;
}
const asBlogId = (d: unknown) => d as BlogIdInput;

export interface PagesIndexData {
  forbidden: boolean;
  blog: Pick<BlogRow, "id" | "name" | "slug" | "status"> | null;
  role: string | null;
  pages: PageListItem[];
  counts: Record<string, number>;
}

export const pagesIndexAction = createServerFn()
  .validator(asBlogId)
  .handler(async ({ data }): Promise<PagesIndexData> => {
    await ensureInitialized();
    const user = await requireUser();
    const blogId = Number(data.blogId);
    const empty: PagesIndexData = {
      forbidden: true,
      blog: null,
      role: null,
      pages: [],
      counts: {},
    };
    if (!Number.isFinite(blogId)) return empty;
    const blog = await getBlog(blogId);
    if (!blog) return empty;
    const membership = await getBlogMembership(blogId, user.id);
    if (!membership) return empty;
    const [pages, counts] = await Promise.all([
      listPagesForMember(blogId, user.id),
      pageStatusCounts(blogId, user.id),
    ]);
    return {
      forbidden: false,
      blog: { id: blog.id, name: blog.name, slug: blog.slug, status: blog.status },
      role: membership.role,
      pages,
      counts,
    };
  });

// ---- Builder load ---------------------------------------------------------

interface BuilderInput {
  blogId: number;
  pageId: number | null;
}
const asBuilder = (d: unknown) => d as BuilderInput;

export interface PageEditorData {
  forbidden: boolean;
  blog: Pick<BlogRow, "id" | "name" | "slug"> | null;
  role: string | null;
  page: PageRow | null;
  revisions: PageRevisionRow[];
}

export const pageEditorLoadAction = createServerFn()
  .validator(asBuilder)
  .handler(async ({ data }): Promise<PageEditorData> => {
    await ensureInitialized();
    const user = await requireUser();
    const blogId = Number(data.blogId);
    const empty: PageEditorData = {
      forbidden: true,
      blog: null,
      role: null,
      page: null,
      revisions: [],
    };
    if (!Number.isFinite(blogId)) return empty;
    const blog = await getBlog(blogId);
    if (!blog) return empty;
    const membership = await getBlogMembership(blogId, user.id);
    if (!membership) return empty;
    const blogRef = { id: blog.id, name: blog.name, slug: blog.slug };

    if (data.pageId == null) {
      return { forbidden: false, blog: blogRef, role: membership.role, page: null, revisions: [] };
    }
    const page = await getPageForMember(Number(data.pageId), user.id);
    // Page in another blog, or the caller is not a member: real not-found.
    if (!page || Number(page.blog_id) !== blogId) {
      return { forbidden: false, blog: blogRef, role: membership.role, page: null, revisions: [] };
    }
    const revisions = await listPageRevisionsForMember(page.id, user.id);
    return { forbidden: false, blog: blogRef, role: membership.role, page, revisions };
  });

// ---- Create ---------------------------------------------------------------

interface CreateInput {
  blogId: number;
  title: string;
}
const asCreate = (d: unknown) => d as CreateInput;

export const createNewPageAction = createServerFn({ method: "POST" })
  .validator(asCreate)
  .handler(async ({ data }): Promise<ActionResult<PageRow>> => {
    await ensureInitialized();
    const user = await requireUser();
    const title = (data.title ?? "").trim() || "Untitled page";
    const page = await createPageForMember(Number(data.blogId), user.id, { title });
    if (!page) return { ok: false, forbidden: true, error: NOT_MEMBER };
    return { ok: true, data: page };
  });

// ---- Save (draft / published / scheduled / trashed) -----------------------

interface SaveInput {
  blogId: number;
  pageId: number;
  title: string;
  content: string;
  slug?: string;
  status?: PageStatus;
  scheduledAt?: string | null;
}
const asSave = (d: unknown) => d as SaveInput;

/** Validate a schedule request; returns an error string or the ISO instant. */
function resolveSchedule(
  status: PageStatus | undefined,
  raw: string | null | undefined
): { error: string } | { scheduledAt: string | null } {
  if (status !== "scheduled") return { scheduledAt: null };
  const value = (raw ?? "").trim();
  const when = value ? new Date(value) : null;
  if (!when || Number.isNaN(when.getTime())) {
    return { error: "Pick a date and time to schedule this page." };
  }
  return { scheduledAt: when.toISOString() };
}

export const savePageAction = createServerFn({ method: "POST" })
  .validator(asSave)
  .handler(
    async ({
      data,
    }): Promise<
      ActionResult<{ page: PageRow; revisions: PageRevisionRow[]; revisionNumber: number }>
    > => {
      await ensureInitialized();
      const user = await requireUser();
      const pageId = Number(data.pageId);
      const existing = await getPageForMember(pageId, user.id);
      if (!existing) return { ok: false, forbidden: true, error: NOT_MEMBER };
      if (Number(existing.blog_id) !== Number(data.blogId)) {
        return { ok: false, forbidden: true, error: NOT_MEMBER };
      }
      if (data.status !== undefined && !ALLOWED.includes(data.status)) {
        return { ok: false, error: `Unknown page status: ${String(data.status)}` };
      }
      let scheduledAt: string | null | undefined = undefined;
      if (data.status !== undefined) {
        const sched = resolveSchedule(data.status, data.scheduledAt);
        if ("error" in sched) return { ok: false, error: sched.error };
        scheduledAt = sched.scheduledAt;
      }
      const title = (data.title ?? "").trim() || "Untitled page";
      const saved = await savePageForMember(pageId, user.id, {
        title,
        content: data.content ?? "",
        slug: data.slug,
        status: data.status,
        scheduledAt,
      });
      if (!saved) return { ok: false, forbidden: true, error: NOT_MEMBER };
      const revisions = await listPageRevisionsForMember(pageId, user.id);
      return {
        ok: true,
        data: { page: saved.page, revisions, revisionNumber: saved.revisionNumber },
      };
    }
  );

// ---- Lifecycle: publish / unpublish / schedule / trash --------------------

interface StatusInput {
  blogId: number;
  pageId: number;
  status: PageStatus;
  scheduledAt?: string | null;
}
const asStatus = (d: unknown) => d as StatusInput;

export const setPageStatusAction = createServerFn({ method: "POST" })
  .validator(asStatus)
  .handler(
    async ({
      data,
    }): Promise<
      ActionResult<{ page: PageRow; revisions: PageRevisionRow[]; revisionNumber: number }>
    > => {
      await ensureInitialized();
      const user = await requireUser();
      if (!ALLOWED.includes(data.status)) {
        return { ok: false, error: `Unknown page status: ${String(data.status)}` };
      }
      const pageId = Number(data.pageId);
      const existing = await getPageForMember(pageId, user.id);
      if (!existing) return { ok: false, forbidden: true, error: NOT_MEMBER };
      if (Number(existing.blog_id) !== Number(data.blogId)) {
        return { ok: false, forbidden: true, error: NOT_MEMBER };
      }

      const sched = resolveSchedule(data.status, data.scheduledAt);
      if ("error" in sched) return { ok: false, error: sched.error };

      const saved = await setPageStatusForMember(pageId, user.id, data.status, sched.scheduledAt);
      if (!saved) return { ok: false, forbidden: true, error: NOT_MEMBER };
      const revisions = await listPageRevisionsForMember(pageId, user.id);
      return {
        ok: true,
        data: { page: saved.page, revisions, revisionNumber: saved.revisionNumber },
      };
    }
  );

// ---- Duplicate ------------------------------------------------------------

interface DuplicateInput {
  blogId: number;
  pageId: number;
}
const asDuplicate = (d: unknown) => d as DuplicateInput;

export const duplicatePageAction = createServerFn({ method: "POST" })
  .validator(asDuplicate)
  .handler(async ({ data }): Promise<ActionResult<PageRow>> => {
    await ensureInitialized();
    const user = await requireUser();
    const page = await duplicatePageForMember(Number(data.pageId), user.id);
    if (!page) return { ok: false, forbidden: true, error: NOT_MEMBER };
    return { ok: true, data: page };
  });
