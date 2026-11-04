/**
 * Phase 5b smoke test — runs against the LIVE database (DATABASE_URL).
 *
 * Proves, with real rows and real bytes:
 *   block schema  — an image block carrying `mediaId` round-trips through
 *                   serializeBlocks → parseBlocks; content saved before 5b (no
 *                   `mediaId`) still parses; junk ids are dropped.
 *   picker source — the list the editor's picker renders is the blog's real
 *                   media rows (url, dimensions, size, upload date).
 *   references    — a media row embedded in one post and one page of the same
 *                   blog reports exactly post_count 1 / page_count 1 / total 2,
 *                   with the right titles.
 *   tenant scope  — the same media id queried from another blog, or by a
 *                   non-member, returns null; and a post in a DIFFERENT blog
 *                   that embeds the id does not count as a reference.
 *   delete guard  — deleting a referenced row is refused with the real counts
 *                   and the row survives; after the references are removed the
 *                   same delete succeeds and the file is gone from disk.
 *
 * Every test row and file it creates is deleted at the end (also on failure).
 * Prints a compact JSON summary; never prints the connection URL.
 */
import { deflateSync } from "node:zlib";
import { existsSync } from "node:fs";
import { all, get, migrate, run, usingPostgres } from "../src/server/store";
import {
  createMediaForMember,
  deleteMediaForMember,
  deleteMediaForMemberGuarded,
  getMediaForMember,
  listMediaForMember,
  mediaReferencesForMember,
  resolveMediaFile,
} from "../src/server/dal/media";
import {
  createBlock,
  mediaIdFrom,
  mediaIdsInBlocks,
  parseBlocks,
  serializeBlocks,
  type Block,
} from "../src/components/blocks/types";
import { createPostForMember, savePostForMember } from "../src/server/dal/posts";
import { createPageForMember, savePageForMember } from "../src/server/dal/pages";

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
function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) {
      raw[p++] = 30;
      raw[p++] = 110;
      raw[p++] = 200;
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

const png = makePng(9, 6);
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

await migrate();
out.storage = usingPostgres() ? "postgres" : "sqlite";

// ---- A) Block schema: mediaId round-trip + backward compatibility ---------
{
  const imageBlock = createBlock("image");
  check("createBlock('image') starts with no mediaId", imageBlock.type === "image" && !("mediaId" in imageBlock.data));

  const withMedia: Block = {
    id: "b-smoke-1",
    type: "image",
    data: { url: "/media/4242", alt: "A teal square", caption: "Captioned", mediaId: 4242 },
  };
  const roundTrip = parseBlocks(serializeBlocks([withMedia]));
  const back = roundTrip.blocks[0];
  check("mediaId survives serialize → parse", back?.type === "image" && back.data.mediaId === 4242, back);
  check("url survives serialize → parse", back?.type === "image" && back.data.url === "/media/4242");
  check("alt survives serialize → parse", back?.type === "image" && back.data.alt === "A teal square");
  check("caption survives serialize → parse", back?.type === "image" && back.data.caption === "Captioned");
  out.blockRoundTrip = back;

  // Content written before Phase 5b has no mediaId at all.
  const legacy =
    '{"version":1,"blocks":[{"id":"b1","type":"image","data":{"url":"https://x/y.jpg","alt":"old"}}]}';
  const legacyParsed = parseBlocks(legacy).blocks[0];
  check(
    "pre-5b image content still parses (no mediaId)",
    legacyParsed?.type === "image" && legacyParsed.data.url === "https://x/y.jpg" && legacyParsed.data.mediaId === undefined,
    legacyParsed
  );

  // Junk ids must never become references.
  const junk =
    '{"version":1,"blocks":[{"id":"b1","type":"image","data":{"url":"/media/1","alt":"a","mediaId":"not-a-number"}}]}';
  const junkParsed = parseBlocks(junk).blocks[0];
  check("non-numeric mediaId is dropped", junkParsed?.type === "image" && junkParsed.data.mediaId === undefined);
  out.mediaIdFrom = {
    positiveInt: mediaIdFrom(7),
    numericString: mediaIdFrom("7"),
    zero: mediaIdFrom(0),
    negative: mediaIdFrom(-3),
    float: mediaIdFrom(1.5),
    junk: mediaIdFrom("abc"),
    empty: mediaIdFrom(""),
    nullish: mediaIdFrom(null),
  };
  check("mediaIdFrom accepts 7 and '7'", mediaIdFrom(7) === 7 && mediaIdFrom("7") === 7);
  check(
    "mediaIdFrom rejects 0, negatives, floats, junk, empty, null",
    mediaIdFrom(0) === null &&
      mediaIdFrom(-3) === null &&
      mediaIdFrom(1.5) === null &&
      mediaIdFrom("abc") === null &&
      mediaIdFrom("") === null &&
      mediaIdFrom(null) === null
  );
}

// ---- Identities + blogs ---------------------------------------------------
const admin = await get<{ id: number }>("SELECT id FROM users WHERE email = ?", "admin@autonoblog.local");
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
check("another user's blog found (for cross-blog checks)", !!otherBlog);
const adminBlogId = Number(adminBlog!.id);
const otherBlogId = Number(otherBlog!.id);
out.adminId = admin?.id;
out.otherUserId = other?.id;
out.adminBlogId = adminBlogId;
out.otherBlogId = otherBlogId;

// ---- Everything this run creates, so cleanup can always find it -----------
const ts = Date.now();
const createdMediaIds: number[] = [];
const createdPostIds: number[] = [];
const createdPageIds: number[] = [];
const createdForeignPostIds: number[] = [];

async function cleanup() {
  for (const id of createdPostIds) {
    await run("DELETE FROM posts WHERE id = ?", id);
  }
  for (const id of createdForeignPostIds) {
    await run("DELETE FROM posts WHERE id = ?", id);
  }
  for (const id of createdPageIds) {
    await run("DELETE FROM pages WHERE id = ?", id);
  }
  for (const id of createdMediaIds) {
    const row = await get<{ file_path: string }>("SELECT file_path FROM media WHERE id = ?", id);
    if (row) {
      // force: true — the smoke owns these rows and is removing them on purpose.
      await deleteMediaForMemberGuarded(adminBlogId, id, admin!.id, { force: true });
      const p = resolveMediaFile({ file_path: row.file_path });
      if (p.exists) {
        try {
          const { unlinkSync } = await import("node:fs");
          unlinkSync(p.path);
        } catch {
          /* best effort */
        }
      }
    }
  }
}

try {
  // ---- B) Upload the media row under test --------------------------------
  const mediaName = `phase5b-smoke-${ts}.png`;
  const media = await createMediaForMember(adminBlogId, admin!.id, {
    base64: dataUrl,
    fileName: mediaName,
    altText: "Phase 5b smoke image (teal)",
  });
  check("media upload created a row", !!media);
  createdMediaIds.push(Number(media!.id));
  out.media = {
    id: Number(media!.id),
    file_name: media!.file_name,
    width: media!.width,
    height: media!.height,
    size_bytes: media!.size_bytes,
    alt_text: media!.alt_text,
  };
  check("media has real dimensions", Number(media!.width) === 9 && Number(media!.height) === 6);
  check("media has a stored alt text", media!.alt_text.includes("Phase 5b"));

  // ---- C) The picker's data source really contains it --------------------
  const pickerRows = await listMediaForMember(adminBlogId, admin!.id);
  const picked = pickerRows.find((r) => r.id === Number(media!.id));
  out.picker = picked
    ? { id: picked.id, url: picked.url, width: picked.width, height: picked.height, size: picked.size_bytes }
    : null;
  check("picker list contains the new row", !!picked);
  check("picker row exposes the served url", picked?.url === `/media/${Number(media!.id)}`);
  check("picker row exposes dimensions", picked?.width === 9 && picked?.height === 6);
  check("picker row exposes a byte size", (picked?.size_bytes ?? 0) > 0);
  check("picker row exposes an upload date", !!picked?.created_at);
  check("picker list is member-scoped (non-member sees nothing)", (await listMediaForMember(adminBlogId, other!.id)).length === 0);

  // ---- D) Embed it in a post AND a page of the same blog -----------------
  const mediaUrl = `/media/${Number(media!.id)}`;
  const postBlock: Block = {
    id: "b-smoke-post",
    type: "image",
    data: { url: mediaUrl, alt: "Teal square in a post", caption: "post caption", mediaId: Number(media!.id) },
  };
  const post = await createPostForMember(adminBlogId, admin!.id, {
    title: `Phase 5b smoke post ${ts}`,
    content: serializeBlocks([postBlock]),
    slug: `phase5b-smoke-post-${ts}`,
  });
  check("post created", !!post);
  createdPostIds.push(Number(post!.id));

  const pageBlock: Block = {
    id: "b-smoke-page",
    type: "image",
    data: { url: mediaUrl, alt: "Teal square on a page", caption: "page caption", mediaId: Number(media!.id) },
  };
  const page = await createPageForMember(adminBlogId, admin!.id, {
    title: `Phase 5b smoke page ${ts}`,
    content: serializeBlocks([pageBlock]),
    slug: `phase5b-smoke-page-${ts}`,
  });
  check("page created", !!page);
  createdPageIds.push(Number(page!.id));

  // The block really is stored with its mediaId (read it back from the DB).
  const storedPost = await get<{ content: string }>("SELECT content FROM posts WHERE id = ?", Number(post!.id));
  const storedPage = await get<{ content: string }>("SELECT content FROM pages WHERE id = ?", Number(page!.id));
  out.storedMediaIds = {
    post: mediaIdsInBlocks(parseBlocks(storedPost!.content).blocks),
    page: mediaIdsInBlocks(parseBlocks(storedPage!.content).blocks),
  };
  check("post content stores the mediaId", (out.storedMediaIds as { post: number[] }).post.includes(Number(media!.id)));
  check("page content stores the mediaId", (out.storedMediaIds as { page: number[] }).page.includes(Number(media!.id)));

  // ---- E) The reference count is exactly right ---------------------------
  const refs = await mediaReferencesForMember(adminBlogId, Number(media!.id), admin!.id);
  out.references = refs;
  check("reference audit returned a summary", !!refs);
  check("post_count is 1", refs?.post_count === 1, { post_count: refs?.post_count });
  check("page_count is 1", refs?.page_count === 1, { page_count: refs?.page_count });
  check("total is 2", refs?.total === 2, { total: refs?.total });
  check(
    "the post reference is the post we created",
    refs?.references.some((r) => r.entity_type === "post" && r.entity_id === Number(post!.id)) === true,
    refs?.references
  );
  check(
    "the page reference is the page we created",
    refs?.references.some((r) => r.entity_type === "page" && r.entity_id === Number(page!.id)) === true,
    refs?.references
  );
  check("reference titles are real titles", refs?.references.some((r) => r.title.includes("Phase 5b smoke post")) === true);

  // ---- F) Tenant scoping: cross-blog must never count or block ----------
  const crossBlog = await mediaReferencesForMember(otherBlogId, Number(media!.id), admin!.id);
  out.crossBlogQuery = crossBlog;
  check("a media id queried under another blog returns null", crossBlog === null);

  const asNonMember = await mediaReferencesForMember(adminBlogId, Number(media!.id), other!.id);
  out.asNonMemberQuery = asNonMember;
  check("a non-member gets null (never a count)", asNonMember === null);

  // A row in ANOTHER blog that embeds this media id must not be counted: the
  // query is filtered by blog_id, so content in another tenant is never read.
  const foreign = await get<{ id: number }>(
    "SELECT id FROM blogs WHERE id <> ? ORDER BY id LIMIT 1",
    adminBlogId
  );
  if (foreign) {
    const foreignPost = await createPostForMember(Number(foreign.id), other!.id, {
      title: `Phase 5b cross-blog ${ts}`,
      content: serializeBlocks([
        { id: "b-x", type: "image", data: { url: mediaUrl, alt: "cross", mediaId: Number(media!.id) } },
      ]),
      slug: `phase5b-cross-${ts}`,
    });
    // createPostForMember needs membership; fall back to a direct row if the
    // chosen user is not a member of that blog.
    let foreignPostId = foreignPost ? Number(foreignPost.id) : null;
    if (foreignPostId === null) {
      const nowIsoStr = new Date().toISOString();
      const ins = await run(
        `INSERT INTO posts (blog_id, title, slug, content, excerpt, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', 'draft', ?, ?)`,
        Number(foreign.id),
        `Phase 5b cross-blog ${ts}`,
        `phase5b-cross-${ts}`,
        serializeBlocks([
          { id: "b-x", type: "image", data: { url: mediaUrl, alt: "cross", mediaId: Number(media!.id) } },
        ]),
        nowIsoStr,
        nowIsoStr
      );
      foreignPostId = Number(ins.lastInsertRowid);
    }
    createdForeignPostIds.push(foreignPostId);
    const refsAfterForeign = await mediaReferencesForMember(adminBlogId, Number(media!.id), admin!.id);
    out.afterForeignInsert = { foreignBlogId: Number(foreign.id), foreignPostId, total: refsAfterForeign?.total };
    check(
      "a reference in another blog does not change this blog's count",
      refsAfterForeign?.total === 2,
      { total: refsAfterForeign?.total }
    );
  } else {
    out.afterForeignInsert = "skipped — no second blog exists";
  }

  // ---- G) Delete is refused while referenced, and the row survives ------
  const blocked = await deleteMediaForMemberGuarded(adminBlogId, Number(media!.id), admin!.id);
  out.blockedDelete = blocked;
  check("delete without force is refused", blocked.ok === false);
  check("refusal reason is 'referenced'", blocked.ok === false && blocked.reason === "referenced");
  check(
    "refusal message states the real counts",
    blocked.ok === false && blocked.error.includes("1 post") && blocked.error.includes("1 page"),
    blocked.ok === false ? blocked.error : null
  );
  check(
    "refusal carries the reference summary",
    blocked.ok === false && blocked.references?.total === 2,
    blocked.ok === false ? blocked.references : null
  );
  check("the row still exists after a refused delete", !!(await getMediaForMember(Number(media!.id), admin!.id)));
  check("the file still exists after a refused delete", resolveMediaFile(media!).exists);

  // ---- H) Removing one reference keeps it blocked (page still uses it) --
  await run("DELETE FROM posts WHERE id = ?", Number(post!.id));
  const refsAfterPostGone = await mediaReferencesForMember(adminBlogId, Number(media!.id), admin!.id);
  out.afterPostDeleted = refsAfterPostGone;
  check("post_count drops to 0", refsAfterPostGone?.post_count === 0);
  check("page_count is still 1", refsAfterPostGone?.page_count === 1);
  const stillBlocked = await deleteMediaForMemberGuarded(adminBlogId, Number(media!.id), admin!.id);
  check("still refused while the page references it", stillBlocked.ok === false && stillBlocked.reason === "referenced");

  // ---- I) Last reference gone → the same delete now succeeds ------------
  await run("DELETE FROM pages WHERE id = ?", Number(page!.id));
  const refsEmpty = await mediaReferencesForMember(adminBlogId, Number(media!.id), admin!.id);
  out.afterPageDeleted = refsEmpty;
  check("reference total is 0 once every reference is gone", refsEmpty?.total === 0);
  const allowed = await deleteMediaForMemberGuarded(adminBlogId, Number(media!.id), admin!.id);
  out.allowedDelete = allowed;
  check("delete without force now succeeds", allowed.ok === true);
  check("the row is gone", (await getMediaForMember(Number(media!.id), admin!.id)) === null);
  check("the file is gone from disk", resolveMediaFile(media!).exists === false);
  // It is already deleted; drop it from the cleanup list so nothing re-runs.
  createdMediaIds.length = 0;

  // ---- J) Force still cannot bypass the tenant check --------------------
  const second = await createMediaForMember(adminBlogId, admin!.id, {
    base64: dataUrl,
    fileName: `phase5b-smoke-force-${ts}.png`,
    altText: "force test",
  });
  check("second media row created", !!second);
  const forceCrossTenant = await deleteMediaForMemberGuarded(
    otherBlogId,
    Number(second!.id),
    admin!.id,
    { force: true }
  );
  out.forceCrossTenant = forceCrossTenant;
  check(
    "force cannot delete another blog's media",
    forceCrossTenant.ok === false && forceCrossTenant.reason === "not_found"
  );
  check("that row survived the cross-tenant force attempt", !!(await getMediaForMember(Number(second!.id), admin!.id)));

  // Unreferenced rows delete without any confirmation prompt at all.
  const unreferenced = await mediaReferencesForMember(adminBlogId, Number(second!.id), admin!.id);
  check("an unreferenced row reports total 0", unreferenced?.total === 0);
  const plainDelete = await deleteMediaForMemberGuarded(adminBlogId, Number(second!.id), admin!.id);
  check("an unreferenced row deletes without force", plainDelete.ok === true);
  check("its file was removed", plainDelete.ok === true && plainDelete.file_removed === true);

  // ---- K) The legacy delete API still behaves (used by older code) ------
  const third = await createMediaForMember(adminBlogId, admin!.id, {
    base64: dataUrl,
    fileName: `phase5b-smoke-legacy-${ts}.png`,
  });
  createdMediaIds.push(Number(third!.id));
  const legacyDelete = await deleteMediaForMember(Number(third!.id), admin!.id);
  check("deleteMediaForMember still deletes an unreferenced row", legacyDelete === true);
  check("its file is gone", resolveMediaFile(third!).exists === false);
  createdMediaIds.length = 0;
} finally {
  await cleanup();
}

// ---- Cleanup proof --------------------------------------------------------
const leftovers = await all<{ id: unknown }>(
  `SELECT id FROM media WHERE blog_id = ? AND file_name LIKE 'phase5b-smoke-%'`,
  adminBlogId
);
out.leftoverMediaRows = leftovers.map((r) => Number(r.id));
const leftoverPosts = await all<{ id: unknown }>(
  "SELECT id FROM posts WHERE blog_id = ? AND slug LIKE 'phase5b-%'",
  adminBlogId
);
const leftoverPages = await all<{ id: unknown }>(
  "SELECT id FROM pages WHERE blog_id = ? AND slug LIKE 'phase5b-%'",
  adminBlogId
);
out.leftoverPosts = leftoverPosts.map((r) => Number(r.id));
out.leftoverPages = leftoverPages.map((r) => Number(r.id));
check("no smoke media rows left behind", out.leftoverMediaRows.length === 0, out.leftoverMediaRows);
check("no smoke posts left behind", out.leftoverPosts.length === 0, out.leftoverPosts);
check("no smoke pages left behind", out.leftoverPages.length === 0, out.leftoverPages);

out.failed = failures;
console.log(JSON.stringify(out, null, 2));
if (failures.length > 0) {
  console.error(`\nSMOKE FAILED (${failures.length})`);
  process.exit(1);
}
console.log("\nSMOKE OK — all Phase 5b media-picker assertions passed.");
