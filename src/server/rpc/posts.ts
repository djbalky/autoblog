/**
 * Autonoblog — server RPCs for Phase 4a: posts + block editor + revisions.
 *
 * Every handler resolves the session user first and then goes through the
 * membership-scoped DAL, so a non-member's request comes back as
 * `{ ok: false, forbidden: true }` and the route renders a real 403/not-found
 * screen. Nothing here invents content or reports success it did not write.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireUser } from "../auth-context";
import { ensureInitialized } from "../init";
import { getBlog, type BlogRow } from "../dal/blogs";
import {
  getBlogMembership,
  listPostsForMember,
  postStatusCounts,
  getPostForMember,
  listRevisionsForMember,
  createPostForMember,
  savePostForMember,
  setPostStatusForMember,
  duplicatePostForMember,
  type PostListItem,
  type PostRevisionRow,
  type PostRow,
  type PostStatus,
} from "../dal/posts";

export interface ActionResult<T = unknown> {
  ok: boolean;
  error?: string;
  forbidden?: boolean;
  notFound?: boolean;
  data?: T;
}

const NOT_MEMBER = "You are not a member of this blog.";
const ALLOWED: PostStatus[] = ["draft", "pending", "published", "scheduled", "trashed"];

// ---- Posts list -----------------------------------------------------------

interface BlogIdInput {
  blogId: number;
}
const asBlogId = (d: unknown) => d as BlogIdInput;

export interface PostsIndexData {
  forbidden: boolean;
  blog: Pick<BlogRow, "id" | "name" | "slug" | "status"> | null;
  role: string | null;
  posts: PostListItem[];
  counts: Record<string, number>;
}

export const postsIndexAction = createServerFn()
  .validator(asBlogId)
  .handler(async ({ data }): Promise<PostsIndexData> => {
    await ensureInitialized();
    const user = await requireUser();
    const blogId = Number(data.blogId);
    const empty: PostsIndexData = {
      forbidden: true,
      blog: null,
      role: null,
      posts: [],
      counts: {},
    };
    if (!Number.isFinite(blogId)) return empty;
    const blog = await getBlog(blogId);
    if (!blog) return empty;
    const membership = await getBlogMembership(blogId, user.id);
    if (!membership) return empty;
    const [posts, counts] = await Promise.all([
      listPostsForMember(blogId, user.id),
      postStatusCounts(blogId, user.id),
    ]);
    return {
      forbidden: false,
      blog: { id: blog.id, name: blog.name, slug: blog.slug, status: blog.status },
      role: membership.role,
      posts,
      counts,
    };
  });

// ---- Editor load ----------------------------------------------------------

interface EditorInput {
  blogId: number;
  postId: number | null;
}
const asEditor = (d: unknown) => d as EditorInput;

export interface EditorData {
  forbidden: boolean;
  blog: Pick<BlogRow, "id" | "name" | "slug"> | null;
  role: string | null;
  post: PostRow | null;
  revisions: PostRevisionRow[];
}

export const editorLoadAction = createServerFn()
  .validator(asEditor)
  .handler(async ({ data }): Promise<EditorData> => {
    await ensureInitialized();
    const user = await requireUser();
    const blogId = Number(data.blogId);
    const empty: EditorData = {
      forbidden: true,
      blog: null,
      role: null,
      post: null,
      revisions: [],
    };
    if (!Number.isFinite(blogId)) return empty;
    const blog = await getBlog(blogId);
    if (!blog) return empty;
    const membership = await getBlogMembership(blogId, user.id);
    if (!membership) return empty;
    const blogRef = { id: blog.id, name: blog.name, slug: blog.slug };

    if (data.postId == null) {
      return { forbidden: false, blog: blogRef, role: membership.role, post: null, revisions: [] };
    }
    const post = await getPostForMember(Number(data.postId), user.id);
    // Post is in another blog or the caller is not a member: real not-found.
    if (!post || Number(post.blog_id) !== blogId) {
      return { forbidden: false, blog: blogRef, role: membership.role, post: null, revisions: [] };
    }
    const revisions = await listRevisionsForMember(post.id, user.id);
    return { forbidden: false, blog: blogRef, role: membership.role, post, revisions };
  });

// ---- Create ---------------------------------------------------------------

interface CreateInput {
  blogId: number;
  title: string;
}
const asCreate = (d: unknown) => d as CreateInput;

export const createNewPostAction = createServerFn({ method: "POST" })
  .validator(asCreate)
  .handler(async ({ data }): Promise<ActionResult<PostRow>> => {
    await ensureInitialized();
    const user = await requireUser();
    const title = (data.title ?? "").trim() || "Untitled post";
    const post = await createPostForMember(Number(data.blogId), user.id, { title });
    if (!post) return { ok: false, forbidden: true, error: NOT_MEMBER };
    return { ok: true, data: post };
  });

// ---- Save (draft / published) ---------------------------------------------

interface SaveInput {
  blogId: number;
  postId: number;
  title: string;
  content: string;
  excerpt: string;
  slug?: string;
  /** Optional lifecycle change performed atomically with the save. */
  status?: PostStatus;
  scheduledAt?: string | null;
}
const asSave = (d: unknown) => d as SaveInput;

/** Validate a schedule request; returns an error string or the ISO instant. */
function resolveSchedule(
  status: PostStatus | undefined,
  raw: string | null | undefined
): { error: string } | { scheduledAt: string | null } {
  if (status !== "scheduled") return { scheduledAt: null };
  const value = (raw ?? "").trim();
  const when = value ? new Date(value) : null;
  if (!when || Number.isNaN(when.getTime())) {
    return { error: "Pick a date and time to schedule this post." };
  }
  return { scheduledAt: when.toISOString() };
}

export const savePostAction = createServerFn({ method: "POST" })
  .validator(asSave)
  .handler(async ({ data }): Promise<ActionResult<{ post: PostRow; revisions: PostRevisionRow[] }>> => {
    await ensureInitialized();
    const user = await requireUser();
    const postId = Number(data.postId);
    const existing = await getPostForMember(postId, user.id);
    if (!existing) return { ok: false, forbidden: true, error: NOT_MEMBER };
    if (Number(existing.blog_id) !== Number(data.blogId)) {
      return { ok: false, forbidden: true, error: NOT_MEMBER };
    }
    if (data.status !== undefined && !ALLOWED.includes(data.status)) {
      return { ok: false, error: `Unknown post status: ${String(data.status)}` };
    }
    let scheduledAt: string | null | undefined = undefined;
    if (data.status !== undefined) {
      const sched = resolveSchedule(data.status, data.scheduledAt);
      if ("error" in sched) return { ok: false, error: sched.error };
      scheduledAt = sched.scheduledAt;
    }
    const title = (data.title ?? "").trim() || "Untitled post";
    const post = await savePostForMember(postId, user.id, {
      title,
      content: data.content ?? "",
      excerpt: data.excerpt ?? "",
      slug: data.slug,
      status: data.status,
      scheduledAt,
    });
    if (!post) return { ok: false, forbidden: true, error: NOT_MEMBER };
    const revisions = await listRevisionsForMember(postId, user.id);
    return { ok: true, data: { post, revisions } };
  });

// ---- Lifecycle: publish / unpublish / schedule / trash --------------------

interface StatusInput {
  blogId: number;
  postId: number;
  status: PostStatus;
  scheduledAt?: string | null;
}
const asStatus = (d: unknown) => d as StatusInput;


export const setPostStatusAction = createServerFn({ method: "POST" })
  .validator(asStatus)
  .handler(async ({ data }): Promise<ActionResult<{ post: PostRow; revisions: PostRevisionRow[] }>> => {
    await ensureInitialized();
    const user = await requireUser();
    if (!ALLOWED.includes(data.status)) {
      return { ok: false, error: `Unknown post status: ${String(data.status)}` };
    }
    const postId = Number(data.postId);
    const existing = await getPostForMember(postId, user.id);
    if (!existing) return { ok: false, forbidden: true, error: NOT_MEMBER };
    if (Number(existing.blog_id) !== Number(data.blogId)) {
      return { ok: false, forbidden: true, error: NOT_MEMBER };
    }

    const sched = resolveSchedule(data.status, data.scheduledAt);
    if ("error" in sched) return { ok: false, error: sched.error };
    const scheduledAt: string | null = sched.scheduledAt;

    const post = await setPostStatusForMember(postId, user.id, data.status, scheduledAt);
    if (!post) return { ok: false, forbidden: true, error: NOT_MEMBER };
    const revisions = await listRevisionsForMember(postId, user.id);
    return { ok: true, data: { post, revisions } };
  });

// ---- Duplicate ------------------------------------------------------------

interface DuplicateInput {
  blogId: number;
  postId: number;
}
const asDuplicate = (d: unknown) => d as DuplicateInput;

export const duplicatePostAction = createServerFn({ method: "POST" })
  .validator(asDuplicate)
  .handler(async ({ data }): Promise<ActionResult<PostRow>> => {
    await ensureInitialized();
    const user = await requireUser();
    const post = await duplicatePostForMember(Number(data.postId), user.id);
    if (!post) return { ok: false, forbidden: true, error: NOT_MEMBER };
    return { ok: true, data: post };
  });
