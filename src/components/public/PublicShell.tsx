/**
 * Autonoblog — public site chrome + shared presentation pieces (Phase 5c).
 *
 * These components are rendered on the server for anonymous visitors. Links in
 * the public site are plain `<a href>` on purpose: the published blog is real
 * HTML that must work with JavaScript disabled, and it is not part of the
 * authenticated app shell. Client-side routing is used inside the dashboard.
 */
import type { ReactNode } from "react";
import type { PublicBlog, PublicImage, PublicPostCard } from "~/server/dal/publicSite";

/** Deterministic date rendering (no locale drift between server and client). */
export function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
}

export function PublicShell({ blog, children }: { blog: PublicBlog; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-white text-neutral-900">
      <header className="border-b border-neutral-200">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-6 py-4">
          <a
            href={`/${blog.slug}`}
            className="truncate text-sm font-semibold tracking-tight text-neutral-900 hover:text-emerald-700"
          >
            {blog.name}
          </a>
          <a
            href="/"
            className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-400 hover:text-neutral-700"
            title="Autonoblog — autonomous blog platform"
          >
            Autonoblog
          </a>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">{children}</main>
      <footer className="border-t border-neutral-200">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2 px-6 py-6 text-xs text-neutral-500">
          <span>
            © {new Date().getUTCFullYear()} {blog.name}
          </span>
          <span>
            Published with{" "}
            <a href="/" className="font-medium text-neutral-700 hover:text-emerald-700">
              Autonoblog
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}

export function PostCard({ blog, post }: { blog: PublicBlog; post: PublicPostCard }) {
  return (
    <article className="group grid gap-4 border-b border-neutral-200 pb-8 sm:grid-cols-[1fr_160px]">
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          {formatDate(post.publishedAt)}
        </p>
        <h2 className="mt-1 text-xl font-bold leading-snug tracking-tight">
          <a href={`/${blog.slug}/${post.slug}`} className="hover:text-emerald-700">
            {post.title}
          </a>
        </h2>
        {post.excerpt ? (
          <p className="mt-2 line-clamp-3 text-sm leading-6 text-neutral-600">{post.excerpt}</p>
        ) : null}
        <a
          href={`/${blog.slug}/${post.slug}`}
          className="mt-3 inline-block text-sm font-medium text-emerald-700 hover:text-emerald-800"
        >
          Read article →
        </a>
      </div>
      {post.image ? (
        <a href={`/${blog.slug}/${post.slug}`} className="order-first sm:order-none">
          <PostThumb image={post.image} />
        </a>
      ) : null}
    </article>
  );
}

function PostThumb({ image }: { image: PublicImage }) {
  return (
    <img
      src={image.url}
      alt={image.alt}
      loading="lazy"
      className="h-40 w-full rounded-lg border border-neutral-200 object-cover sm:h-24"
    />
  );
}
