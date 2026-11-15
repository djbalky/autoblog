/**
 * Autonoblog — DAL: URL history (Phase 5e).
 *
 * A published post or page whose slug changes keeps its old public URL working:
 * `/blog/old-slug` answers **301** to `/blog/new-slug` instead of 404ing. This
 * module owns both halves — recording the redirect when a slug changes, and
 * resolving one for a visitor.
 *
 * Rules, all enforced here:
 *  - Paths are stored root-relative AND include the blog slug (`/my-blog/hello`).
 *    A redirect therefore can never point at another blog's content.
 *  - One redirect per old path: `UNIQUE(blog_id, from_path)`, written with an
 *    upsert, so renaming a post twice updates the same row rather than growing
 *    a chain.
 *  - No chains: when B→C is recorded, every redirect that pointed at B is
 *    re-pointed at C in the same call (A→C). The resolver still follows at most
 *    a few hops, with a visited set, so a cycle can never loop.
 *  - A redirect never shadows live content: if a published post/page already
 *    occupies the old path, the redirect row is deleted instead of written.
 *  - A redirect to content that has since been unpublished or deleted does NOT
 *    redirect: `resolvePublicRedirect` only returns a target that resolves to
 *    real published content right now, so the old URL keeps answering a plain
 *    404 instead of bouncing the visitor into one.
 */
import { all, get, run, nowIso } from "../store";
import { getPublicBlog, getPublicContent } from "./publicSite";

/** How many redirect hops a single request will follow before giving up. */
const MAX_HOPS = 5;

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

/** "/Blog/Hello/" -> "/blog/hello" (slugs are lowercase, no trailing slash). */
export function normalizePath(path: string): string {
  const clean = str(path).trim();
  if (!clean) return "";
  const withSlash = clean.startsWith("/") ? clean : `/${clean}`;
  const trimmed = withSlash.replace(/\/+$/, "");
  return (trimmed || "/").toLowerCase();
}

/** The content slug of a `/<blog>/<slug>` path, or "" when it is not one. */
function slugOf(path: string): string {
  const parts = normalizePath(path).split("/").filter(Boolean);
  return parts.length === 2 ? parts[1] : "";
}

function blogSlugOf(path: string): string {
  const parts = normalizePath(path).split("/").filter(Boolean);
  return parts.length === 2 ? parts[0] : "";
}

/**
 * Is there published content at `/<blog>/<slug>` right now? Used to keep a
 * redirect from ever shadowing a real URL.
 */
async function publishedContentAt(blogId: number, slug: string, now: string): Promise<boolean> {
  if (!slug) return false;
  const post = await get<{ id: unknown }>(
    `SELECT id FROM posts
      WHERE blog_id = ? AND slug = ? AND status = 'published'
        AND published_at IS NOT NULL AND published_at <= ?`,
    blogId,
    slug,
    now
  );
  if (post) return true;
  const page = await get<{ id: unknown }>(
    `SELECT id FROM pages
      WHERE blog_id = ? AND slug = ? AND status = 'published'
        AND published_at IS NOT NULL AND published_at <= ?`,
    blogId,
    slug,
    now
  );
  return Boolean(page);
}

/** Remove a redirect row (used when live content takes the path back over). */
export async function deleteRedirect(blogId: number, fromPath: string): Promise<void> {
  const from = normalizePath(fromPath);
  if (!from) return;
  await run("DELETE FROM redirects WHERE blog_id = ? AND from_path = ?", blogId, from);
}

/**
 * Record that `/<blog>/<oldSlug>` must now point at `/<blog>/<newSlug>`.
 *
 * Called by the post/page save paths after a successful UPDATE, only when the
 * content has really been published (otherwise there is no public URL to keep
 * alive). Safe to call with unchanged paths — it does nothing then.
 */
export async function recordSlugRedirect(input: {
  blogId: number;
  blogSlug: string;
  oldSlug: string;
  newSlug: string;
}): Promise<void> {
  const blogSlug = normalizePath(`/${input.blogSlug}`).slice(1);
  const oldSlug = str(input.oldSlug).trim().toLowerCase();
  const newSlug = str(input.newSlug).trim().toLowerCase();
  if (!blogSlug || !oldSlug || !newSlug || oldSlug === newSlug) return;

  const from = `/${blogSlug}/${oldSlug}`;
  const to = `/${blogSlug}/${newSlug}`;
  const now = nowIso();

  // Never shadow content that is live at the old path.
  if (await publishedContentAt(input.blogId, oldSlug, now)) {
    await deleteRedirect(input.blogId, from);
    return;
  }

  await run(
    `INSERT INTO redirects (blog_id, from_path, to_path, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (blog_id, from_path) DO UPDATE SET to_path = excluded.to_path, created_at = excluded.created_at`,
    input.blogId,
    from,
    to,
    now
  );

  // Flatten: anything that pointed at the OLD path now points at the new one
  // (A→B followed by B→C becomes A→C). The `from_path <> to` guard keeps a
  // redirect from ever pointing at itself.
  await run(
    `UPDATE redirects SET to_path = ? WHERE blog_id = ? AND to_path = ? AND from_path <> ?`,
    to,
    input.blogId,
    from,
    to
  );
  // Drop a self-redirect if one was produced by the flatten above.
  await run("DELETE FROM redirects WHERE blog_id = ? AND from_path = to_path", input.blogId);
}

/** Every redirect of a blog (admin/debug view). */
export async function listRedirects(blogId: number): Promise<
  { from_path: string; to_path: string; created_at: string }[]
> {
  const rows = await all<Record<string, unknown>>(
    "SELECT from_path, to_path, created_at FROM redirects WHERE blog_id = ? ORDER BY created_at DESC",
    blogId
  );
  return rows.map((r) => ({
    from_path: str(r.from_path),
    to_path: str(r.to_path),
    created_at: str(r.created_at),
  }));
}

/**
 * Resolve `/<blogSlug>/<contentSlug>` to the path it now lives at, or null.
 *
 * Only returns a path that resolves to PUBLISHED content right now — a redirect
 * whose target has since been unpublished, trashed or deleted returns null, so
 * the caller answers a real 404 instead of a redirect into a 404. Chains are
 * followed (max MAX_HOPS) with a visited set, so A→B→C lands on C and a cycle
 * resolves to null rather than looping.
 */
export async function resolvePublicRedirect(
  blogSlug: string,
  contentSlug: string,
  now: string
): Promise<string | null> {
  const blog = await getPublicBlog(blogSlug);
  if (!blog) return null;

  let path = normalizePath(`/${blog.slug}/${str(contentSlug).trim().toLowerCase()}`);
  const visited = new Set<string>();

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (!path || visited.has(path)) return null;
    visited.add(path);

    // A live URL is never redirected over.
    if (hop > 0 && (await publishedContentAt(blog.id, slugOf(path), now))) return null;

    const row = await get<{ to_path: unknown }>(
      "SELECT to_path FROM redirects WHERE blog_id = ? AND from_path = ?",
      blog.id,
      path
    );
    if (!row) return null;

    const target = normalizePath(str(row.to_path));
    if (!target || target === path) return null;
    // Redirects never leave their own blog.
    if (blogSlugOf(target) !== normalizePath(`/${blog.slug}`).slice(1)) return null;

    const targetSlug = slugOf(target);
    if (!targetSlug) return null;
    if (await getPublicContent(blog.slug, targetSlug, now)) return target;

    // Target is not live (yet): follow it as the next hop — a chain that ends
    // on live content still lands, one that does not resolves to null.
    path = target;
  }
  return null;
}
