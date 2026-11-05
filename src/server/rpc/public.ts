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

export type PublicBlogHomeResult = { found: false } | { found: true; home: PublicBlogHome };
export type PublicContentResult = { found: false } | { found: true; content: PublicContent };

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
