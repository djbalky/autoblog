/**
 * Autonoblog — server RPCs for Phase 5a: the per-blog media library.
 *
 * Same shape as the post/page RPCs: resolve the session user, then go through
 * the membership-scoped media DAL. A non-member gets `{ ok: false, forbidden:
 * true }` (or an empty list + `forbidden: true` on the index) and the route
 * renders a real 403 panel. Uploads re-validate the bytes on the server; every
 * rejection returns the actual reason, never a fake success.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireUser } from "../auth-context";
import { ensureInitialized } from "../init";
import { getBlog, type BlogRow } from "../dal/blogs";
import { getBlogMembership } from "../dal/posts";
import {
  MEDIA_LIMITS,
  canDeleteMedia,
  canUploadMedia,
  createMediaForMember,
  deleteMediaForMember,
  listMediaForMember,
  mediaPublicPath,
  mediaUsage,
  type MediaListItem,
  type MediaUsage,
} from "../dal/media";

export interface ActionResult<T = unknown> {
  ok: boolean;
  error?: string;
  forbidden?: boolean;
  notFound?: boolean;
  data?: T;
}

const NOT_MEMBER = "You are not a member of this blog.";

// ---- Library index --------------------------------------------------------

interface BlogIdInput {
  blogId: number;
}
const asBlogId = (d: unknown) => d as BlogIdInput;

export interface MediaIndexData {
  forbidden: boolean;
  blog: Pick<BlogRow, "id" | "name" | "slug" | "status"> | null;
  role: string | null;
  media: MediaListItem[];
  usage: MediaUsage;
  canUpload: boolean;
  canDelete: boolean;
  limits: { maxBytes: number; mimeTypes: string[]; label: string };
}

export const mediaIndexAction = createServerFn()
  .validator(asBlogId)
  .handler(async ({ data }): Promise<MediaIndexData> => {
    await ensureInitialized();
    const user = await requireUser();
    const blogId = Number(data.blogId);
    const empty: MediaIndexData = {
      forbidden: true,
      blog: null,
      role: null,
      media: [],
      usage: {
        count: 0,
        bytes: 0,
        fileLimitBytes: MEDIA_LIMITS.maxBytes,
        storageLimitBytes: null,
        storageUnlimited: false,
        planKey: null,
      },
      canUpload: false,
      canDelete: false,
      limits: {
        maxBytes: MEDIA_LIMITS.maxBytes,
        mimeTypes: MEDIA_LIMITS.mimeTypes,
        label: MEDIA_LIMITS.label,
      },
    };
    if (!Number.isFinite(blogId)) return empty;
    const blog = await getBlog(blogId);
    if (!blog) return empty;
    const membership = await getBlogMembership(blogId, user.id);
    if (!membership) return empty;
    const [media, usage] = await Promise.all([
      listMediaForMember(blogId, user.id),
      mediaUsage(blogId, user.id),
    ]);
    return {
      forbidden: false,
      blog: { id: blog.id, name: blog.name, slug: blog.slug, status: blog.status },
      role: membership.role,
      media,
      usage,
      canUpload: canUploadMedia(membership.role),
      canDelete: canDeleteMedia(membership.role),
      limits: empty.limits,
    };
  });

// ---- Upload ---------------------------------------------------------------

interface UploadInput {
  blogId: number;
  /** Browser data URL (data:image/png;base64,...) or bare base64. */
  base64: string;
  fileName: string;
  altText?: string;
}
const asUpload = (d: unknown) => d as UploadInput;

export const mediaUploadAction = createServerFn({ method: "POST" })
  .validator(asUpload)
  .handler(async ({ data }): Promise<ActionResult<{ media: MediaListItem }>> => {
    await ensureInitialized();
    const user = await requireUser();
    const blogId = Number(data.blogId);
    if (!Number.isFinite(blogId)) return { ok: false, error: "Unknown blog." };
    const blog = await getBlog(blogId);
    if (!blog) return { ok: false, notFound: true, error: "That blog does not exist." };
    const membership = await getBlogMembership(blogId, user.id);
    if (!membership) return { ok: false, forbidden: true, error: NOT_MEMBER };
    if (!canUploadMedia(membership.role)) {
      return {
        ok: false,
        forbidden: true,
        error: `Your role (${membership.role}) cannot upload media to this blog.`,
      };
    }
    try {
      const row = await createMediaForMember(blogId, user.id, {
        base64: data.base64,
        fileName: data.fileName,
        altText: data.altText,
      });
      if (!row) return { ok: false, forbidden: true, error: NOT_MEMBER };
      return {
        ok: true,
        data: {
          media: {
            id: Number(row.id),
            file_name: row.file_name,
            mime_type: row.mime_type,
            size_bytes: Number(row.size_bytes),
            width: row.width === null ? null : Number(row.width),
            height: row.height === null ? null : Number(row.height),
            alt_text: row.alt_text,
            created_at: row.created_at,
            uploader_id: row.uploader_id === null ? null : Number(row.uploader_id),
            uploader_name: user.displayName ?? null,
            url: mediaPublicPath(Number(row.id)),
          },
        },
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

// ---- Delete ---------------------------------------------------------------

interface DeleteInput {
  blogId: number;
  mediaId: number;
}
const asDelete = (d: unknown) => d as DeleteInput;

export const mediaDeleteAction = createServerFn({ method: "POST" })
  .validator(asDelete)
  .handler(async ({ data }): Promise<ActionResult<{ id: number }>> => {
    await ensureInitialized();
    const user = await requireUser();
    const blogId = Number(data.blogId);
    const mediaId = Number(data.mediaId);
    if (!Number.isFinite(blogId) || !Number.isFinite(mediaId)) {
      return { ok: false, error: "Unknown media item." };
    }
    const membership = await getBlogMembership(blogId, user.id);
    if (!membership) return { ok: false, forbidden: true, error: NOT_MEMBER };
    if (!canDeleteMedia(membership.role)) {
      return {
        ok: false,
        forbidden: true,
        error: `Your role (${membership.role}) cannot delete media from this blog.`,
      };
    }
    // Scoped by membership inside the DAL — a media id from another blog
    // resolves to nothing and reports not-found instead of deleting it.
    const deleted = await deleteMediaForMember(mediaId, user.id);
    if (!deleted) {
      return { ok: false, notFound: true, error: "That media item no longer exists in this blog." };
    }
    return { ok: true, data: { id: mediaId } };
  });
