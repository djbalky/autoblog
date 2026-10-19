/**
 * Autonoblog — post-create blog landing page (client component).
 *
 * Renders the real blog row the wizard just wrote: settings, seeded pages and
 * navigation backbone, all served through the route loader (createServerFn).
 * No server-only imports reach the client bundle.
 */
import { Link, useLoaderData } from "@tanstack/react-router";
import { AD_SLOT_LABELS } from "../../lib/adSlots";

export function BlogLanding() {
  const { user, blog } = useLoaderData({ from: "/blogs/$blogId" });
  const settings = blog.settings;
  const config = blog.config as Record<string, any> | null;
  const basic = config?.step1_basic as any;
  const logoUrl: string | null = basic?.logo_url ?? null;
  const monetization = config?.step8_monetization as any;
  const social = config?.step9_social as any;
  const enabledAdSlots: string[] =
    monetization?.ad_slots ?? [];

  return (
    <main className="min-h-dvh bg-neutral-50 dark:bg-neutral-950">
      <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-bold text-neutral-900 dark:text-white">
              Autonoblog
            </h1>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">Your blog</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-neutral-600 dark:text-neutral-300">
              {user.displayName}
            </span>
            <Link
              to="/blogs/$blogId/posts"
              params={{ blogId: String(blog.id) }}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              Posts
            </Link>
            <Link
              to="/blogs/$blogId/pages"
              params={{ blogId: String(blog.id) }}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              Pages
            </Link>
            <Link
              to="/dashboard"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              ← Dashboard
            </Link>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="rounded-xl border border-green-200 bg-green-50 p-5 dark:border-green-800 dark:bg-green-900/20">
          <div className="flex items-start gap-4">
            {/* The logo is served from the real `media` row written during
                create, through GET /api/media/<id> — if that route or the file
                is missing this image simply does not load (no fake placeholder
                image is substituted). */}
            {logoUrl && (
              <img
                src={logoUrl}
                alt={`${blog.name} logo`}
                className="h-14 w-14 shrink-0 rounded-md border border-green-200 bg-white object-contain p-1 dark:border-green-800"
              />
            )}
            <div>
              <h2 className="text-lg font-bold text-green-900 dark:text-green-200">
                ✓ Blog created
              </h2>
              <p className="mt-1 text-sm text-green-800 dark:text-green-300">
                <strong>{blog.name}</strong> is live in the database at{" "}
                <code className="rounded bg-green-100 px-1 dark:bg-green-900">
                  /{blog.slug}
                </code>
                . The dashboard, editor and agents arrive in the next phases.
              </p>
            </div>
          </div>
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Card k="Status" v={blog.status} />
          <Card k="Language" v={settings?.language ?? "en"} />
          <Card k="Timezone" v={settings?.timezone ?? "UTC"} />
          <Card k="Posts / day" v={String(settings?.posts_per_day ?? 2)} />
          <Card k="Auto-publish" v={settings?.auto_publish ? "ON" : "OFF"} />
          <Card k="Monetization" v={settings?.monetization_active ? "ON" : "OFF"} />
        </dl>

        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
            <div>
              <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">Posts</h3>
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                Write, publish, schedule and version posts with the block editor. Everything is
                stored in the <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">posts</code>{" "}
                and <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">post_revisions</code> tables.
              </p>
            </div>
            <div className="flex gap-2">
              <Link
                to="/blogs/$blogId/posts"
                params={{ blogId: String(blog.id) }}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                All posts →
              </Link>
              <Link
                to="/blogs/$blogId/posts/$postId"
                params={{ blogId: String(blog.id), postId: "new" }}
                className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900"
              >
                + New post
              </Link>
            </div>
          </div>
        </section>

        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
            <div>
              <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">Pages</h3>
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                Build About / Contact / landing pages with the page builder (hero, columns, CTA,
                spacer) and version them in the{" "}
                <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">pages</code> and{" "}
                <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">page_revisions</code>{" "}
                tables.
              </p>
            </div>
            <div className="flex gap-2">
              <Link
                to="/blogs/$blogId/pages"
                params={{ blogId: String(blog.id) }}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                All pages →
              </Link>
              <Link
                to="/blogs/$blogId/pages/$pageId"
                params={{ blogId: String(blog.id), pageId: "new" }}
                className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900"
              >
                + New page
              </Link>
            </div>
          </div>
        </section>

        <section className="mt-8">
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">
            Seeded content backbone
          </h3>
          <div className="mt-3 space-y-3">
            <div className="rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">Pages ({blog.pages.length})</p>
              <div className="mt-1 flex flex-wrap gap-2">
                {blog.pages.map((p) => (
                  <span
                    key={p.id}
                    className="rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                  >
                    /{p.slug}
                  </span>
                ))}
              </div>
            </div>
            <div className="rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">Navigation (primary menu)</p>
              <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
                Home · About · Contact · Privacy
              </p>
            </div>
            {enabledAdSlots.length > 0 && (
              <div className="rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
                <p className="text-xs text-neutral-500 dark:text-neutral-400">Ad slots enabled</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  {enabledAdSlots.map((s) => (
                    <span
                      key={s}
                      className="rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-200"
                    >
                      {AD_SLOT_LABELS[s] ?? s}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {social?.networks?.filter((n: any) => n.enabled).length > 0 && (
              <div className="rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
                <p className="text-xs text-neutral-500 dark:text-neutral-400">Auto-share on</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  {social.networks
                    .filter((n: any) => n.enabled)
                    .map((n: any) => (
                      <span
                        key={n.platform}
                        className="rounded-full bg-blue-100 px-3 py-1 text-xs text-blue-800 dark:bg-blue-900/30 dark:text-blue-200"
                      >
                        {n.platform} (NOT CONNECTED)
                      </span>
                    ))}
                </div>
              </div>
            )}
          </div>
        </section>

        <p className="mt-8">
          <Link
            to="/blogs/new"
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Create another blog
          </Link>
        </p>
      </div>
    </main>
  );
}

function Card({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <p className="text-xl font-bold text-neutral-900 dark:text-white">{v}</p>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{k}</p>
    </div>
  );
}
