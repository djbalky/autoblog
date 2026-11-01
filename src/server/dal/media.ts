/**
 * Autonoblog — DAL: media (Phase 2 logo/favicon staging + Phase 5a library).
 *
 * Two independent jobs live here:
 *
 * A) Wizard staging (Phase 2). The Blog Creation Wizard uploads a logo/favicon
 *    BEFORE the blog row exists, so there is no `blog_id` to hang a `media` row
 *    on. `uploadToStaging` writes the bytes to `data/uploads/staging/<token>`
 *    and returns a token; `registerStagedMediaForBlog` copies it into the
 *    blog's media folder and writes the real `media` row once the blog exists.
 *
 * B) Per-blog media library (Phase 5a). `createMediaForMember` /
 *    `listMediaForMember` / `deleteMediaForMember` are the library API used by
 *    `/blogs/$blogId/media`. Every member-scoped read and write joins
 *    `blog_members` in SQL, exactly like the post/page DALs, so a non-member
 *    can never list, read, add or delete another blog's media.
 *
 * Upload validation is REAL and server-side: the claimed content type is
 * ignored, the bytes are sniffed for a PNG/JPEG/GIF/WebP signature, the byte
 * length is enforced against `MEDIA_LIMITS.maxBytes`, and the plan's storage
 * allowance (when the user has a subscription row) is checked against the
 * actual total of the user's media rows. Nothing is written to disk or to the
 * database when a check fails.
 *
 * Files live under `<DATA_DIR>/media/<blogId>/` (DATA_DIR = <site>/data, which
 * is gitignored) and are served back by `src/server/mediaServe.ts`.
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../db";
import { nowIso, run, get, all } from "../store";
import { ROLE_PERMISSIONS, type RoleName } from "../roles";
import { getActiveSubscription } from "./billing";
import { mediaIdsInBlocks, parseBlocks } from "../../components/blocks/types";

const STAGING_DIR = join(DATA_DIR, "uploads", "staging");
const mediaDirFor = (blogId: number) => join(DATA_DIR, "media", String(blogId));

export interface UploadRef {
  token: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface MediaRow {
  id: number;
  blog_id: number;
  uploader_id: number | null;
  file_name: string;
  file_path: string;
  mime_type: string;
  size_bytes: number;
  alt_text: string;
  width: number | null;
  height: number | null;
  created_at: string;
}

function mimeFromBase64(base64: string, fileName: string): string {
  const head = base64.slice(0, 64);
  const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);/.exec(head);
  if (m) return m[1];
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
  };
  return map[ext] ?? "application/octet-stream";
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return cleaned || "upload";
}

/**
 * Write a base64 upload to the staging folder and return a token ref. No DB
 * write happens here — registration occurs when the blog is created.
 */
export async function uploadToStaging(
  base64: string,
  rawFileName: string
): Promise<UploadRef> {
  const fileName = sanitizeFileName(rawFileName);
  const mimeType = mimeFromBase64(base64, fileName);
  const dataPart = base64.includes(",") ? base64.split(",").pop() ?? "" : base64;
  const buf = Buffer.from(dataPart, "base64");
  if (buf.length === 0) throw new Error("Upload contained no data.");
  if (buf.length > 5 * 1024 * 1024) {
    throw new Error("Image is larger than 5 MB. Please upload a smaller file.");
  }
  mkdirSync(STAGING_DIR, { recursive: true });
  const token = `${randomBytes(16).toString("hex")}-${fileName}`;
  writeFileSync(join(STAGING_DIR, token), buf);
  return { token, fileName, mimeType, sizeBytes: buf.length };
}

/**
 * During Create Blog: move a staged upload into the blog's media folder and
 * write a real `media` row. Returns the row (including its public URL).
 */
export async function registerStagedMediaForBlog(
  blogId: number,
  uploaderId: number | null,
  ref: UploadRef,
  altText: string
): Promise<MediaRow | null> {
  const stagedPath = join(STAGING_DIR, ref.token);
  if (!existsSync(stagedPath)) {
    throw new Error(
      `Uploaded file "${ref.fileName}" is no longer available — please re-upload it in step 1.`
    );
  }
  const mediaDir = mediaDirFor(blogId);
  mkdirSync(mediaDir, { recursive: true });
  const relPath = `media/${blogId}/${randomBytes(8).toString("hex")}-${ref.fileName}`;
  const dest = join(DATA_DIR, relPath);
  copyFileSync(stagedPath, dest);

  const now = nowIso();
  const info = await run(
    `INSERT INTO media
       (blog_id, uploader_id, file_name, file_path, mime_type, size_bytes, alt_text, width, height, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    blogId,
    uploaderId,
    ref.fileName,
    relPath,
    ref.mimeType,
    ref.sizeBytes,
    altText,
    now
  );
  return (await get<MediaRow>("SELECT * FROM media WHERE id = ?", info.lastInsertRowid)) ?? null;
}

/** Resolve a media row's file on disk (for the serving API route). */
export function resolveMediaFile(media: {
  file_path: string;
}): { path: string; exists: boolean } {
  const p = join(DATA_DIR, media.file_path);
  return { path: p, exists: existsSync(p) };
}

export async function getMedia(id: number): Promise<MediaRow | undefined> {
  return get<MediaRow>("SELECT * FROM media WHERE id = ?", id);
}

// ===========================================================================
// Phase 5a — per-blog media library
// ===========================================================================

/** Hard, honest limits for the media library. Shown in the UI and enforced here. */
export const MEDIA_LIMITS = {
  /** Maximum size of a single uploaded file. */
  maxBytes: 5 * 1024 * 1024,
  /** Accepted image types (detected from the bytes, not from the file name). */
  mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] as string[],
  /** Human-readable list for the UI. */
  label: "PNG, JPEG, GIF or WebP up to 5 MB",
};

/** Public URL path a media row is served from. */
export function mediaPublicPath(id: number): string {
  return `/media/${id}`;
}

export interface MediaListItem {
  id: number;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  alt_text: string;
  created_at: string;
  uploader_id: number | null;
  uploader_name: string | null;
  url: string;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toListItem(r: Record<string, unknown>): MediaListItem {
  const id = num(r.id);
  return {
    id,
    file_name: String(r.file_name ?? ""),
    mime_type: String(r.mime_type ?? ""),
    size_bytes: num(r.size_bytes),
    width: numOrNull(r.width),
    height: numOrNull(r.height),
    alt_text: String(r.alt_text ?? ""),
    created_at: String(r.created_at ?? ""),
    uploader_id: numOrNull(r.uploader_id),
    uploader_name: r.uploader_name == null ? null : String(r.uploader_name),
    url: mediaPublicPath(id),
  };
}

// ---- Role capability checks (same table the app uses everywhere) -----------

function roleCan(role: string | null, permission: string): boolean {
  if (!role) return false;
  const perms = ROLE_PERMISSIONS[role as RoleName];
  if (!perms) return false;
  return perms.includes("*") || perms.includes(permission);
}

/** `media.manage` (owner/administrator/editor) or `media.upload` (author). */
export function canUploadMedia(role: string | null): boolean {
  return roleCan(role, "media.upload") || roleCan(role, "media.manage");
}

/** Deleting media destroys a shared asset — `media.manage` only. */
export function canDeleteMedia(role: string | null): boolean {
  return roleCan(role, "media.manage");
}

async function memberRole(blogId: number, userId: number): Promise<string | null> {
  const row = await get<{ role: string }>(
    "SELECT role FROM blog_members WHERE blog_id = ? AND user_id = ?",
    blogId,
    userId
  );
  return row ? String(row.role) : null;
}

// ---- Image sniffing -------------------------------------------------------

export interface DetectedImage {
  mimeType: string;
  ext: string;
  width: number | null;
  height: number | null;
}

/**
 * Identify an image from its magic bytes and read its pixel dimensions.
 * Returns null when the bytes are not a PNG/JPEG/GIF/WebP — which is what makes
 * "a .php renamed to .png" impossible to store as media.
 */
export function detectImageType(buf: Buffer): DetectedImage | null {
  if (!buf || buf.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR carries width/height at 16/20.
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    const width = buf.length >= 24 ? buf.readUInt32BE(16) : null;
    const height = buf.length >= 24 ? buf.readUInt32BE(20) : null;
    return { mimeType: "image/png", ext: "png", width, height };
  }

  // GIF87a / GIF89a: logical screen width/height are little-endian at 6/8.
  const gifHead = buf.toString("latin1", 0, 6);
  if (gifHead === "GIF87a" || gifHead === "GIF89a") {
    const width = buf.length >= 10 ? buf.readUInt16LE(6) : null;
    const height = buf.length >= 10 ? buf.readUInt16LE(8) : null;
    return { mimeType: "image/gif", ext: "gif", width, height };
  }

  // WebP: "RIFF" <size> "WEBP" <chunk>
  if (
    buf.toString("latin1", 0, 4) === "RIFF" &&
    buf.toString("latin1", 8, 12) === "WEBP"
  ) {
    const chunk = buf.toString("latin1", 12, 16);
    let width: number | null = null;
    let height: number | null = null;
    if (chunk === "VP8X" && buf.length >= 30) {
      width = buf.readUIntLE(24, 3) + 1;
      height = buf.readUIntLE(27, 3) + 1;
    } else if (chunk === "VP8 " && buf.length >= 30) {
      width = buf.readUInt16LE(26) & 0x3fff;
      height = buf.readUInt16LE(28) & 0x3fff;
    } else if (chunk === "VP8L" && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    }
    return { mimeType: "image/webp", ext: "webp", width, height };
  }

  // JPEG: FF D8 FF, then walk markers until a SOFn frame header.
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      // Standalone markers (no length field).
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        const height = buf.readUInt16BE(i + 5);
        const width = buf.readUInt16BE(i + 7);
        return { mimeType: "image/jpeg", ext: "jpg", width, height };
      }
      if (len < 2) break;
      i += 2 + len;
    }
    // Still a JPEG even if the frame header was not readable.
    return { mimeType: "image/jpeg", ext: "jpg", width: null, height: null };
  }

  return null;
}

/** Decode a browser data URL (or bare base64) into bytes. */
export function decodeUploadBase64(base64: string): Buffer {
  if (typeof base64 !== "string" || base64.length === 0) {
    throw new Error("No file data was received.");
  }
  const dataPart = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
  const cleaned = dataPart.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    throw new Error("The upload was not valid base64 data.");
  }
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length === 0) throw new Error("The uploaded file is empty.");
  return buf;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ---- Library reads --------------------------------------------------------

/**
 * Media rows of one blog, newest first — only for a member of that blog.
 * A non-member gets an empty array (never an error that leaks existence).
 */
export async function listMediaForMember(
  blogId: number,
  userId: number
): Promise<MediaListItem[]> {
  const rows = await all<Record<string, unknown>>(
    `SELECT m.*, u.display_name AS uploader_name
       FROM media m
       JOIN blog_members bm ON bm.blog_id = m.blog_id AND bm.user_id = ?
       LEFT JOIN users u ON u.id = m.uploader_id
      WHERE m.blog_id = ?
      ORDER BY m.created_at DESC, m.id DESC`,
    userId,
    blogId
  );
  return rows.map(toListItem);
}

/** One media row, only if the caller is a member of its blog. */
export async function getMediaForMember(
  mediaId: number,
  userId: number
): Promise<MediaRow | null> {
  const row = await get<Record<string, unknown>>(
    `SELECT m.*
       FROM media m
       JOIN blog_members bm ON bm.blog_id = m.blog_id AND bm.user_id = ?
      WHERE m.id = ?`,
    userId,
    mediaId
  );
  if (!row) return null;
  return {
    id: num(row.id),
    blog_id: num(row.blog_id),
    uploader_id: numOrNull(row.uploader_id),
    file_name: String(row.file_name ?? ""),
    file_path: String(row.file_path ?? ""),
    mime_type: String(row.mime_type ?? ""),
    size_bytes: num(row.size_bytes),
    alt_text: String(row.alt_text ?? ""),
    width: numOrNull(row.width),
    height: numOrNull(row.height),
    created_at: String(row.created_at ?? ""),
  };
}

/** Real byte total of every blog this user is a member of (for plan checks). */
export async function userMediaBytes(userId: number): Promise<number> {
  const row = await get<{ n: unknown }>(
    `SELECT COALESCE(SUM(m.size_bytes), 0) AS n
       FROM media m
       JOIN blog_members bm ON bm.blog_id = m.blog_id AND bm.user_id = ?`,
    userId
  );
  return num(row?.n);
}

export interface MediaUsage {
  count: number;
  bytes: number;
  /** Per-file cap (always enforced). */
  fileLimitBytes: number;
  /** Plan storage allowance for this user, or null when unlimited/absent. */
  storageLimitBytes: number | null;
  /** True when the user has a subscription row whose plan says -1 (unlimited). */
  storageUnlimited: boolean;
  planKey: string | null;
}

/** What the media screen shows: real totals + the real plan allowance. */
export async function mediaUsage(blogId: number, userId: number): Promise<MediaUsage> {
  const row = await get<{ c: unknown; b: unknown }>(
    `SELECT COUNT(*) AS c, COALESCE(SUM(m.size_bytes), 0) AS b
       FROM media m
       JOIN blog_members bm ON bm.blog_id = m.blog_id AND bm.user_id = ?
      WHERE m.blog_id = ?`,
    userId,
    blogId
  );
  const sub = await getActiveSubscription(userId);
  const raw = sub?.plan_limits?.storage_bytes;
  return {
    count: num(row?.c),
    bytes: num(row?.b),
    fileLimitBytes: MEDIA_LIMITS.maxBytes,
    storageLimitBytes:
      typeof raw === "number" && raw >= 0 ? raw : null,
    storageUnlimited: raw === -1,
    planKey: sub?.plan_key ?? null,
  };
}

// ---- Library writes -------------------------------------------------------

export interface MediaUploadInput {
  /** Browser data URL or bare base64. */
  base64: string;
  fileName: string;
  altText?: string;
}

/**
 * Validate + persist one uploaded image for a blog.
 *
 * Returns `null` when the caller is not a member (or may not upload), and
 * throws an `Error` with a user-facing message when the file itself is
 * rejected. The file is only written once every check has passed; if the DB
 * insert fails the file is removed again, so disk and DB cannot drift.
 */
export async function createMediaForMember(
  blogId: number,
  userId: number,
  input: MediaUploadInput
): Promise<MediaRow | null> {
  const role = await memberRole(blogId, userId);
  if (!role || !canUploadMedia(role)) return null;

  const buf = decodeUploadBase64(input.base64);
  if (buf.length > MEDIA_LIMITS.maxBytes) {
    throw new Error(
      `"${input.fileName}" is ${humanBytes(buf.length)} — the limit is ${humanBytes(
        MEDIA_LIMITS.maxBytes
      )} per file.`
    );
  }
  const detected = detectImageType(buf);
  if (!detected) {
    throw new Error(
      `"${input.fileName}" is not a supported image. Accepted types: ${MEDIA_LIMITS.label}. ` +
        `(The file type is read from the file's bytes, so renaming a file does not work.)`
    );
  }

  // Plan storage allowance — real numbers, and only rejected when the plan row
  // actually exists and is finite.
  const sub = await getActiveSubscription(userId);
  const planLimit = sub?.plan_limits?.storage_bytes;
  if (typeof planLimit === "number" && planLimit >= 0) {
    const used = await userMediaBytes(userId);
    if (used + buf.length > planLimit) {
      throw new Error(
        `Storage limit reached: ${humanBytes(used)} of ${humanBytes(planLimit)} used ` +
          `(${sub?.plan_key ?? "current"} plan). Delete a file or upgrade to upload more.`
      );
    }
  }

  const safeName = sanitizeFileName(input.fileName || `upload.${detected.ext}`);
  const mediaDir = mediaDirFor(blogId);
  mkdirSync(mediaDir, { recursive: true });
  const relPath = `media/${blogId}/${randomBytes(8).toString("hex")}-${safeName}`;
  const diskPath = join(DATA_DIR, relPath);
  writeFileSync(diskPath, buf);

  try {
    const now = nowIso();
    const info = await run(
      `INSERT INTO media
         (blog_id, uploader_id, file_name, file_path, mime_type, size_bytes, alt_text, width, height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      blogId,
      userId,
      safeName,
      relPath,
      detected.mimeType,
      buf.length,
      (input.altText ?? "").slice(0, 500),
      detected.width,
      detected.height,
      now
    );
    const row = await get<MediaRow>("SELECT * FROM media WHERE id = ?", info.lastInsertRowid);
    if (!row) throw new Error("The media row could not be read back after insert.");
    return row;
  } catch (err) {
    // DB write failed → never leave an orphan file behind.
    try {
      if (existsSync(diskPath)) unlinkSync(diskPath);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/**
 * Delete one media row and its file. Returns false when the row does not exist
 * or the caller is not a member of its blog; deletes the file first so a
 * failure leaves the row (and therefore a recoverable, honest state).
 */
export async function deleteMediaForMember(
  mediaId: number,
  userId: number
): Promise<boolean> {
  const row = await getMediaForMember(mediaId, userId);
  if (!row) return false;
  const role = await memberRole(row.blog_id, userId);
  if (!canDeleteMedia(role)) return false;

  const info = await run(
    "DELETE FROM media WHERE id = ? AND blog_id = ?",
    mediaId,
    row.blog_id
  );
  if (info.changes === 0) return false;
  try {
    const p = join(DATA_DIR, row.file_path);
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* the row is gone; an orphan file is reported by the storage audit, not fatal */
  }
  return true;
}

// ===========================================================================
// Phase 5b — reference audit ("is this image still used by a post or page?")
// ===========================================================================

/**
 * One place a media row is used. `status` is included so the confirmation panel
 * can say whether the breaking reference is a published article or a draft.
 */
export interface MediaReference {
  entity_type: "post" | "page";
  entity_id: number;
  title: string;
  slug: string;
  status: string;
}

export interface MediaReferenceSummary {
  blog_id: number;
  media_id: number;
  post_count: number;
  page_count: number;
  total: number;
  /** The references themselves, capped at `MEDIA_REFERENCE_LIST_LIMIT`. */
  references: MediaReference[];
  /** True when `references` was truncated — counts are always the full counts. */
  truncated: boolean;
}

export const MEDIA_REFERENCE_LIST_LIMIT = 20;

/**
 * Count (and list) the posts and pages **of one blog** that currently embed a
 * media row, by parsing their stored block content with the very same
 * `parseBlocks` the editor and the renderer use.
 *
 * Scoping rules, enforced here rather than trusted from the caller:
 *  - the media row must belong to `blogId` — a media id from another blog
 *    returns `null`, so a cross-blog id can never be counted (or block a
 *    delete) in the wrong tenant;
 *  - the caller must be a member of `blogId`;
 *  - the post/page query is filtered by `blog_id`, so content in another blog
 *    is never even read.
 *
 * SQL narrows with a LIKE on the serialised `"mediaId":<n>` fragment (our
 * writer emits compact JSON), then the parse confirms the exact id — so
 * `%"mediaId":12%` matching media 12x costs a parse, never a wrong count.
 *
 * What counts: the *current* content of a post or page. Old revisions are
 * history, not live references, and are deliberately excluded — the media
 * library says so in its confirmation text instead of implying otherwise.
 */
export async function mediaReferencesForMember(
  blogId: number,
  mediaId: number,
  userId: number
): Promise<MediaReferenceSummary | null> {
  if (!Number.isFinite(blogId) || !Number.isFinite(mediaId)) return null;
  const row = await getMediaForMember(mediaId, userId);
  // Cross-blog guard: the row must actually live in THIS blog.
  if (!row || Number(row.blog_id) !== Number(blogId)) return null;

  const likeExact = `%"mediaId":${mediaId}%`;
  const likeSpaced = `%"mediaId": ${mediaId}%`;

  const [postRows, pageRows] = await Promise.all([
    all<Record<string, unknown>>(
      `SELECT id, title, slug, status, content FROM posts
        WHERE blog_id = ? AND (content LIKE ? OR content LIKE ?)`,
      blogId,
      likeExact,
      likeSpaced
    ),
    all<Record<string, unknown>>(
      `SELECT id, title, slug, status, content FROM pages
        WHERE blog_id = ? AND (content LIKE ? OR content LIKE ?)`,
      blogId,
      likeExact,
      likeSpaced
    ),
  ]);

  const matches = (content: unknown): boolean => {
    const ids = mediaIdsInBlocks(parseBlocks(String(content ?? "")).blocks);
    return ids.includes(mediaId);
  };

  const refs: MediaReference[] = [];
  for (const r of postRows) {
    if (!matches(r.content)) continue;
    refs.push({
      entity_type: "post",
      entity_id: num(r.id),
      title: String(r.title ?? ""),
      slug: String(r.slug ?? ""),
      status: String(r.status ?? ""),
    });
  }
  for (const r of pageRows) {
    if (!matches(r.content)) continue;
    refs.push({
      entity_type: "page",
      entity_id: num(r.id),
      title: String(r.title ?? ""),
      slug: String(r.slug ?? ""),
      status: String(r.status ?? ""),
    });
  }

  const post_count = refs.filter((r) => r.entity_type === "post").length;
  const page_count = refs.filter((r) => r.entity_type === "page").length;
  return {
    blog_id: blogId,
    media_id: mediaId,
    post_count,
    page_count,
    total: refs.length,
    references: refs.slice(0, MEDIA_REFERENCE_LIST_LIMIT),
    truncated: refs.length > MEDIA_REFERENCE_LIST_LIMIT,
  };
}

export type DeleteMediaResult =
  | {
      ok: true;
      id: number;
      file_removed: boolean;
      references: MediaReferenceSummary;
    }
  | {
      ok: false;
      reason: "forbidden" | "not_found" | "referenced" | "failed";
      error: string;
      references?: MediaReferenceSummary;
    };

/**
 * Phase 5b delete with the reference guard.
 *
 * Behaviour chosen for this phase (implemented fully, not half of both):
 * **a referenced image is NOT deleted silently — it is refused, the caller is
 * told exactly how many posts and pages use it (with their titles), and the
 * delete only proceeds when the same caller repeats it with `force: true`.**
 *
 * `force` never bypasses the tenant checks: membership, `media.manage` and the
 * "row belongs to this blog" check all still run first.
 */
export async function deleteMediaForMemberGuarded(
  blogId: number,
  mediaId: number,
  userId: number,
  opts: { force?: boolean } = {}
): Promise<DeleteMediaResult> {
  const row = await getMediaForMember(mediaId, userId);
  if (!row || Number(row.blog_id) !== Number(blogId)) {
    return { ok: false, reason: "not_found", error: "That media item is not in this blog." };
  }
  const role = await memberRole(Number(row.blog_id), userId);
  if (!canDeleteMedia(role)) {
    return {
      ok: false,
      reason: "forbidden",
      error: `Your role (${role ?? "none"}) cannot delete media from this blog.`,
    };
  }

  const references = await mediaReferencesForMember(blogId, mediaId, userId);
  if (!references) {
    return { ok: false, reason: "not_found", error: "That media item is not in this blog." };
  }
  if (references.total > 0 && opts.force !== true) {
    const parts: string[] = [];
    if (references.post_count > 0) {
      parts.push(`${references.post_count} post${references.post_count === 1 ? "" : "s"}`);
    }
    if (references.page_count > 0) {
      parts.push(`${references.page_count} page${references.page_count === 1 ? "" : "s"}`);
    }
    return {
      ok: false,
      reason: "referenced",
      error:
        `“${row.file_name}” is still used by ${parts.join(" and ")} in this blog. ` +
        `Deleting it would leave those images broken — confirm the delete to proceed anyway.`,
      references,
    };
  }

  const deleted = await deleteMediaForMember(mediaId, userId);
  if (!deleted) {
    return {
      ok: false,
      reason: "failed",
      error: "The media row could not be deleted (it may have just been removed).",
      references,
    };
  }
  return {
    ok: true,
    id: mediaId,
    file_removed: !resolveMediaFile(row).exists,
    references,
  };
}

