/**
 * Phase 5a smoke test — runs against the LIVE database (DATABASE_URL).
 *
 * Proves, with real bytes and real SQL:
 *   schema      — the `media` table and every column the library writes exist
 *                 on the live database (information_schema on Postgres), and
 *                 the boot-time extension statements apply cleanly.
 *   round trip  — a generated PNG is uploaded through the real DAL, the file on
 *                 disk matches the input byte-for-byte, and the row carries the
 *                 right blog, mime, size and pixel dimensions.
 *   reads       — list (newest first) + get work for a member.
 *   serving     — /media/<id> path parsing + serveMedia() return the same bytes
 *                 with image/png and a cache header; junk ids 404.
 *   validation  — non-image bytes and oversized files are rejected with the
 *                 real reason (no silent acceptance).
 *   isolation   — a non-member can neither see, read, upload to, nor delete
 *                 from another user's blog.
 *   delete      — removes the row AND the file from disk.
 *
 * One uploaded image is left behind in blog 3 as evidence
 * (`phase5a-smoke-<ts>.png`); every temporary row/file is deleted.
 * Prints a compact JSON summary; never prints the connection URL.
 */
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { all, get, migrate, usingPostgres } from "../src/server/store";
import {
  MEDIA_LIMITS,
  createMediaForMember,
  deleteMediaForMember,
  detectImageType,
  getMediaForMember,
  listMediaForMember,
  mediaUsage,
  resolveMediaFile,
} from "../src/server/dal/media";
import { mediaIdFromPath, serveMedia } from "../src/server/mediaServe";
import { getBlogMembership } from "../src/server/dal/posts";

const out: Record<string, unknown> = {};
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures.push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
  return ok;
}

// ---- A real PNG, built here so the bytes are known exactly ----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
/** Minimal valid 8-bit RGBA PNG of the requested size (solid teal). */
function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(height * (1 + width * 4));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      raw[p++] = 20;
      raw[p++] = 140;
      raw[p++] = 120;
      raw[p++] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG_W = 7;
const PNG_H = 5;
const png = makePng(PNG_W, PNG_H);
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
out.png = { bytes: png.length, width: PNG_W, height: PNG_H };
out.detect = detectImageType(png);

await migrate();
out.storage = usingPostgres() ? "postgres" : "sqlite";

// ---- Schema parity: the media table really exists on the live DB ----------
if (usingPostgres()) {
  const cols = await all<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'media' ORDER BY ordinal_position`
  );
  const names = cols.map((c) => c.column_name);
  out.mediaColumns = names;
  for (const need of [
    "id",
    "blog_id",
    "file_name",
    "file_path",
    "mime_type",
    "size_bytes",
    "width",
    "height",
    "alt_text",
    "uploader_id",
    "created_at",
  ]) {
    check(`live media.${need} exists`, names.includes(need));
  }
} else {
  const cols = await all<{ name: string }>("PRAGMA table_info(media)");
  out.mediaColumns = cols.map((c) => c.name);
}

// ---- Identities + blogs ---------------------------------------------------
const admin = await get<{ id: number }>(
  "SELECT id FROM users WHERE email = ?",
  "admin@autonoblog.local"
);
const other = await get<{ id: number }>(
  "SELECT id FROM users WHERE email <> ? ORDER BY id LIMIT 1",
  "admin@autonoblog.local"
);
check("admin user found", !!admin);
check("a second user exists for isolation", !!other);

const adminBlog =
  (await get<{ id: number }>(
    "SELECT b.id FROM blogs b JOIN blog_members bm ON bm.blog_id = b.id WHERE bm.user_id = ? AND b.id = 3",
    admin!.id
  )) ??
  (await get<{ id: number }>(
    "SELECT b.id FROM blogs b JOIN blog_members bm ON bm.blog_id = b.id WHERE bm.user_id = ? ORDER BY b.id LIMIT 1",
    admin!.id
  ));
const otherBlog = await get<{ id: number }>(
  "SELECT b.id FROM blogs b JOIN blog_members bm ON bm.blog_id = b.id WHERE bm.user_id = ? ORDER BY b.id LIMIT 1",
  other!.id
);
check("admin blog found", !!adminBlog);
check("other user's blog found", !!otherBlog);
out.adminId = admin?.id;
out.otherUserId = other?.id;
out.adminBlogId = adminBlog?.id;
out.otherBlogId = otherBlog?.id;
out.adminMembership = await getBlogMembership(adminBlog!.id, admin!.id);
out.adminInOtherBlog = await getBlogMembership(otherBlog!.id, admin!.id);

// ---- Upload #1: evidence file (kept) -------------------------------------
const ts = Date.now();
const evidenceName = `phase5a-smoke-${ts}.png`;
const evidence = await createMediaForMember(adminBlog!.id, admin!.id, {
  base64: dataUrl,
  fileName: evidenceName,
  altText: "Phase 5a smoke image",
});
check("evidence upload created a row", !!evidence);
out.upload = evidence && {
  id: evidence.id,
  blog_id: evidence.blog_id,
  file_name: evidence.file_name,
  mime_type: evidence.mime_type,
  size_bytes: evidence.size_bytes,
  width: evidence.width,
  height: evidence.height,
  file_path: evidence.file_path,
};
check("row belongs to the right blog", Number(evidence!.blog_id) === Number(adminBlog!.id));
check("mime is image/png", evidence!.mime_type === "image/png");
check("size_bytes equals the uploaded byte length", Number(evidence!.size_bytes) === png.length, {
  row: Number(evidence!.size_bytes),
  uploaded: png.length,
});
check("dimensions parsed from the bytes", Number(evidence!.width) === PNG_W && Number(evidence!.height) === PNG_H, {
  w: evidence!.width,
  h: evidence!.height,
});
check("uploader recorded", Number(evidence!.uploader_id) === Number(admin!.id));

// Bytes on disk must match exactly.
const onDisk = resolveMediaFile(evidence!);
out.disk = { path: onDisk.path, exists: onDisk.exists };
check("file written to disk", onDisk.exists);
const diskBytes = onDisk.exists ? readFileSync(onDisk.path) : Buffer.alloc(0);
check("bytes round-trip exactly", Buffer.compare(diskBytes, png) === 0, {
  disk: diskBytes.length,
  uploaded: png.length,
});

// ---- Reads ----------------------------------------------------------------
const list = await listMediaForMember(adminBlog!.id, admin!.id);
out.list = { count: list.length, firstId: list[0]?.id, newestFirst: list[0]?.id === evidence!.id };
check("new upload is listed first (newest first)", Number(list[0]?.id) === Number(evidence!.id), {
  firstId: list[0]?.id,
  newId: evidence!.id,
});
check("listed item carries its public url", list[0]?.url === `/media/${Number(evidence!.id)}`);
const got = await getMediaForMember(evidence!.id, admin!.id);
check("getMediaForMember returns the row", !!got && Number(got.id) === Number(evidence!.id));
out.usage = await mediaUsage(adminBlog!.id, admin!.id);

// ---- Serving (the same code path serve.ts uses) ---------------------------
out.pathParsing = {
  mediaPath: mediaIdFromPath(`/media/${evidence!.id}`),
  apiPath: mediaIdFromPath(`/api/media/${evidence!.id}`),
  traversal: mediaIdFromPath("/media/../../etc/passwd"),
  nested: mediaIdFromPath(`/media/${evidence!.id}/x`),
  notMedia: mediaIdFromPath("/blogs/3/media"),
};
check("serves /media/<id>", mediaIdFromPath(`/media/${evidence!.id}`) === Number(evidence!.id));
check("keeps the /api/media/<id> alias", mediaIdFromPath(`/api/media/${evidence!.id}`) === Number(evidence!.id));
check(
  "rejects traversal ids",
  (() => {
    const v = mediaIdFromPath("/media/../../etc/passwd");
    return v === -1 || v === null;
  })()
);
check("ignores nested paths", mediaIdFromPath(`/media/${evidence!.id}/x`) === null);
check("does not shadow /blogs/<id>/media", mediaIdFromPath("/blogs/3/media") === null);

const served = await serveMedia(Number(evidence!.id));
const servedBuf = served ? Buffer.from(await served.arrayBuffer()) : Buffer.alloc(0);
out.served = served
  ? {
      status: served.status,
      contentType: served.headers.get("content-type"),
      cacheControl: served.headers.get("cache-control"),
      bytes: servedBuf.length,
      identical: Buffer.compare(servedBuf, png) === 0,
    }
  : null;
check("serveMedia returns 200", served?.status === 200);
check("content-type is image/png", served?.headers.get("content-type") === "image/png");
check("cache header present", (served?.headers.get("cache-control") ?? "").includes("max-age"));
check("served bytes are identical", Buffer.compare(servedBuf, png) === 0);
const notFound = await serveMedia(999999);
check("unknown id is a real 404", notFound?.status === 404);

// ---- Validation is real (no silent acceptance) ----------------------------
let textRejected = "";
try {
  await createMediaForMember(adminBlog!.id, admin!.id, {
    base64: `data:image/png;base64,${Buffer.from("this is not an image at all").toString("base64")}`,
    fileName: "fake.png",
  });
} catch (err) {
  textRejected = (err as Error).message;
}
out.rejectedText = textRejected;
check("text bytes renamed .png are rejected", textRejected.includes("not a supported image"));

let oversizeRejected = "";
try {
  const big = Buffer.alloc(MEDIA_LIMITS.maxBytes + 1024, 0x41);
  await createMediaForMember(adminBlog!.id, admin!.id, {
    base64: big.toString("base64"),
    fileName: "too-big.png",
  });
} catch (err) {
  oversizeRejected = (err as Error).message;
}
out.rejectedOversize = oversizeRejected;
check("files over the per-file limit are rejected", oversizeRejected.includes("limit"));

// ---- Isolation: another user's identity touches nothing -------------------
out.isolation = {
  listForAdminBlogByOther: (await listMediaForMember(adminBlog!.id, other!.id)).length,
  getAsNonMember: await getMediaForMember(evidence!.id, other!.id),
  deleteAsNonMember: await deleteMediaForMember(evidence!.id, other!.id),
  uploadAsNonMember: await createMediaForMember(adminBlog!.id, other!.id, {
    base64: dataUrl,
    fileName: "hijack.png",
  }),
  adminUploadToOtherBlog: await createMediaForMember(otherBlog!.id, admin!.id, {
    base64: dataUrl,
    fileName: "hijack.png",
  }),
};
check("non-member lists nothing", (out.isolation as { listForAdminBlogByOther: number }).listForAdminBlogByOther === 0);
check("non-member gets null on get", (out.isolation as { getAsNonMember: unknown }).getAsNonMember === null);
check("non-member cannot delete", (out.isolation as { deleteAsNonMember: boolean }).deleteAsNonMember === false);
check("non-member cannot upload", (out.isolation as { uploadAsNonMember: unknown }).uploadAsNonMember === null);
check(
  "member of another blog cannot upload into this one",
  (out.isolation as { adminUploadToOtherBlog: unknown }).adminUploadToOtherBlog === null
);
// The evidence row must still be there after every cross-tenant attempt.
check("evidence row survived the isolation attempts", !!(await getMediaForMember(evidence!.id, admin!.id)));

// ---- Delete removes the row AND the file ---------------------------------
const temp = await createMediaForMember(adminBlog!.id, admin!.id, {
  base64: dataUrl,
  fileName: `phase5a-temp-${ts}.png`,
});
check("temp upload created", !!temp);
const tempFile = temp ? resolveMediaFile(temp) : { path: "", exists: false };
check("temp file exists before delete", tempFile.exists);
const deleted = await deleteMediaForMember(temp!.id, admin!.id);
out.delete = {
  returned: deleted,
  rowAfter: await getMediaForMember(temp!.id, admin!.id),
  fileAfter: resolveMediaFile(temp!).exists,
};
check("delete reported success", deleted === true);
check("row is gone", (await getMediaForMember(temp!.id, admin!.id)) === null);
check("file is gone from disk", resolveMediaFile(temp!).exists === false);

// A second delete of the same id must be honest about there being nothing left.
out.deleteTwice = await deleteMediaForMember(temp!.id, admin!.id);
check("second delete returns false", out.deleteTwice === false);

// ---- What is left ---------------------------------------------------------
out.leftInBlog = await all<{ id: unknown; file_name: string; size_bytes: unknown }>(
  "SELECT id, file_name, size_bytes FROM media WHERE blog_id = ? ORDER BY id",
  adminBlog!.id
);
out.evidence = {
  id: evidence!.id,
  file_name: evidenceName,
  url: `/media/${evidence!.id}`,
  bytes: png.length,
};
out.failed = failures;
console.log(JSON.stringify(out, null, 2));
if (failures.length > 0) {
  console.error(`\nSMOKE FAILED (${failures.length})`);
  process.exit(1);
}
console.log("\nSMOKE OK — all Phase 5a media assertions passed.");
