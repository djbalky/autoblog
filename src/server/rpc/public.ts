/**
 * Autonoblog — server functions for the PUBLIC site (Phase 5c).
 *
 * These are the only RPCs that do not require a session: they serve published
 * content to anonymous visitors. They cannot read drafts, trashed rows or
 * inactive blogs — that filtering happens in SQL inside `dal/publicSite.ts`,
 * so it holds for the SSR render and for client-side navigation alike.
 *
 * Return shape: `{ found: false }` means "this URL does not exist publicly" —
 * the route turns that into a real HTTP 404. Nothing here throws on a normal
 * miss, and nothing is cached across requests.
 */
import { createServerFn } from "@tanstack/react-start";
import { ensureInitialized } from "../init";
import { nowIso } from "../store";
import {
  getPublicBlogHome,
  getPublicContent,
  type PublicBlogHome,
  type PublicContent,
} from "../dal/publicSite";
import { resolvePublicRedirect } from "../dal/redirects";

export type PublicBlogHomeResult = { found: false } | { found: true; home: PublicBlogHome };
export type PublicContentResult = { found: false } | { found: true; content: PublicContent };

/**
 * Phase 5e: the path an old public URL now lives at, or null. Used for
 * client-side navigation; a full page load is answered with a real 301 by
 * `serve.ts` before the app even renders.
 */
export type PublicRedirectResult = { to: string | null };

interface BlogHomeInput {
  blogSlug: string;
  page?: number;
}
const asBlogHome = (d: unknown) => d as BlogHomeInput;

export const publicBlogHomeAction = createServerFn()
  .validator(asBlogHome)
  .handler(async ({ data }): Promise<PublicBlogHomeResult> => {
    await ensureInitialized();
    const home = await getPublicBlogHome(
      String(data.blogSlug ?? ""),
      Number(data.page ?? 1),
      nowIso()
    );
    return home ? { found: true, home } : { found: false };
  });

interface ContentInput {
  blogSlug: string;
  slug: string;
}
const asContent = (d: unknown) => d as ContentInput;

export const publicContentAction = createServerFn()
  .validator(asContent)
  .handler(async ({ data }): Promise<PublicContentResult> => {
    await ensureInitialized();
    const content = await getPublicContent(
      String(data.blogSlug ?? ""),
      String(data.slug ?? ""),
      nowIso()
    );
    return content ? { found: true, content } : { found: false };
  });

/**
 * Phase 5e — resolve an old public URL to where the content lives now.
 * Returns `{ to: null }` when there is no usable redirect (unknown path, a path
 * that is live again, or a target that is no longer published).
 */
export const publicRedirectAction = createServerFn()
  .validator(asContent)
  .handler(async ({ data }): Promise<PublicRedirectResult> => {
    await ensureInitialized();
    const to = await resolvePublicRedirect(
      String(data.blogSlug ?? ""),
      String(data.slug ?? ""),
      nowIso()
    );
    return { to };
  });
