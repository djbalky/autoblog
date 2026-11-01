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
  deleteMediaForMemberGuarded,
  listMediaForMember,
  mediaPublicPath,
  mediaReferencesForMember,
  mediaUsage,
  type MediaListItem,
  type MediaReferenceSummary,
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
  /**
   * Phase 5b: a delete of an image that posts/pages still embed is refused the
   * first time (with the real reference count). The UI shows that count and,
   * only after the user confirms, repeats the call with `force: true`.
   */
  force?: boolean;
}
const asDelete = (d: unknown) => d as DeleteInput;

export const mediaDeleteAction = createServerFn({ method: "POST" })
  .validator(asDelete)
  .handler(
    async ({
      data,
    }): Promise<
      ActionResult<{
        id: number;
        fileRemoved: boolean;
        references: MediaReferenceSummary;
      }> & { blocked?: boolean; references?: MediaReferenceSummary }
    > => {
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
      // Every check below is re-run server-side and scoped to this blog: a media
      // id from another blog resolves to not-found instead of being deleted, and
      // `force` can never skip membership/role/tenant checks.
      const result = await deleteMediaForMemberGuarded(blogId, mediaId, user.id, {
        force: data.force === true,
      });
      if (result.ok) {
        return {
          ok: true,
          data: {
            id: result.id,
            fileRemoved: result.file_removed,
            references: result.references,
          },
        };
      }
      if (result.reason === "referenced") {
        return {
          ok: false,
          blocked: true,
          references: result.references,
          error: result.error,
        };
      }
      if (result.reason === "not_found") {
        return { ok: false, notFound: true, error: result.error };
      }
      if (result.reason === "forbidden") {
        return { ok: false, forbidden: true, error: result.error };
      }
      return { ok: false, error: result.error };
    }
  );

// ===========================================================================
// Phase 5b — media picker + reference audit
// ===========================================================================

/**
 * What the editor's media picker needs, and nothing more: the blog's real media
 * rows (member-scoped), whether this role may upload, and the real limits.
 * A non-member gets `forbidden: true` and an empty list — never another blog's
 * media, and never a made-up placeholder tile.
 */
export interface MediaPickerData {
  forbidden: boolean;
  media: MediaListItem[];
  canUpload: boolean;
  limits: { maxBytes: number; mimeTypes: string[]; label: string };
}

export const mediaPickerListAction = createServerFn({ method: "POST" })
  .validator(asBlogId)
  .handler(async ({ data }): Promise<MediaPickerData> => {
    await ensureInitialized();
    const user = await requireUser();
    const blogId = Number(data.blogId);
    const empty: MediaPickerData = {
      forbidden: true,
      media: [],
      canUpload: false,
      limits: {
        maxBytes: MEDIA_LIMITS.maxBytes,
        mimeTypes: MEDIA_LIMITS.mimeTypes,
        label: MEDIA_LIMITS.label,
      },
    };
    if (!Number.isFinite(blogId)) return empty;
    const membership = await getBlogMembership(blogId, user.id);
    if (!membership) return empty;
    const media = await listMediaForMember(blogId, user.id);
    return {
      forbidden: false,
      media,
      canUpload: canUploadMedia(membership.role),
      limits: empty.limits,
    };
  });

interface ReferencesInput {
  blogId: number;
  mediaId: number;
}
const asReferences = (d: unknown) => d as ReferencesInput;

/**
 * Real per-blog reference count for one media row. `null` data means "not a
 * member of this blog, or that media does not belong to it" — the UI shows that
 * honestly instead of rendering a zero that would imply "safe to delete".
 */
export const mediaReferencesAction = createServerFn({ method: "POST" })
  .validator(asReferences)
  .handler(
    async ({
      data,
    }): Promise<ActionResult<{ references: MediaReferenceSummary }>> => {
      await ensureInitialized();
      const user = await requireUser();
      const blogId = Number(data.blogId);
      const mediaId = Number(data.mediaId);
      if (!Number.isFinite(blogId) || !Number.isFinite(mediaId)) {
        return { ok: false, error: "Unknown media item." };
      }
      const membership = await getBlogMembership(blogId, user.id);
      if (!membership) return { ok: false, forbidden: true, error: NOT_MEMBER };
      const references = await mediaReferencesForMember(blogId, mediaId, user.id);
      if (!references) {
        return {
          ok: false,
          notFound: true,
          error: "That media item is not in this blog.",
        };
      }
      return { ok: true, data: { references } };
    });
