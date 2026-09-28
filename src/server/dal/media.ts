/**
 * Autonoblog — DAL: media upload + registration (Phase 2).
 *
 * The Blog Creation Wizard lets the user upload a logo and favicon. Real media
 * rows require a `blog_id` that references an existing blog, but uploads happen
 * BEFORE the blog row exists. So we split it in two honest stages:
 *
 *   1. `uploadToStaging` — the wizard uploads a file, which is written to a
 *      staging folder on disk (`data/uploads/staging/<token>`). The client
 *      keeps the returned token in form state. No DB row yet.
 *   2. `registerStagedMediaForBlog` — during "Create Blog", after the blog row
 *      exists, the staged file is copied into the blog's media folder, a REAL
 *      `media` row is written, and we return the row (with its public URL).
 *
 * The file is served back to the browser by the API route `api/media.$id`.
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../db";
import { nowIso, run, get } from "../store";

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
