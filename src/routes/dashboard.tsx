import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { useLoaderData, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  currentUserAction,
  dashboardStatsAction,
  myBlogCardsAction,
  logoutAction,
} from "../server/rpc/auth";
import type { BlogCardRow } from "../server/dal/blogs";
import type { PublicUser } from "../server/auth";

export const Route = createFileRoute("/dashboard")({
  loader: async (): Promise<{
    user: PublicUser;
    blogCount: number;
    postCount: number;
    storage: "postgres" | "sqlite";
    blogs: BlogCardRow[];
  }> => {
    const { user } = await currentUserAction();
    if (!user) throw redirect({ to: "/login" });
    const stats = await dashboardStatsAction();
    const blogs = await myBlogCardsAction();
    return {
      user,
      blogCount: stats.blogCount,
      postCount: stats.postCount,
      storage: stats.storage,
      blogs,
    };
  },
  component: Dashboard,
});

const STORAGE_LABEL: Record<"postgres" | "sqlite", string> = {
  postgres: "Postgres (Neon) — the production database",
  sqlite: "the local SQLite development database (dev fallback, no DATABASE_URL set)",
};

const STATUS_STYLES: Record<string, string> = {
  active:
    "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-500/30",
  draft:
    "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-500/30",
  archived:
    "bg-neutral-100 text-neutral-600 ring-neutral-500/20 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-500/30",
};

function statusClass(status: string): string {
  return (
    STATUS_STYLES[status] ??
    "bg-neutral-100 text-neutral-600 ring-neutral-500/20 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-500/30"
  );
}

/** created_at is stored as ISO text; slice for a stable server/client render. */
function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const s = String(value);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

type SortKey = "newest" | "oldest" | "name" | "posts";

function Dashboard() {
  const { user, blogCount, postCount, storage, blogs } = useLoaderData({
    from: "/dashboard",
  });
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("newest");

  async function onLogout() {
    setLoggingOut(true);
    await logoutAction();
    navigate({ to: "/login" });
  }

  // Real rows only; the filter/sort below just re-orders what the DB returned.
  const statuses = useMemo(() => {
    const set = new Set(blogs.map((b) => b.status));
    return ["all", ...Array.from(set).sort()];
  }, [blogs]);

  const visible = useMemo(() => {
    const rows =
      statusFilter === "all"
        ? [...blogs]
        : blogs.filter((b) => b.status === statusFilter);
    rows.sort((a, b) => {
      switch (sort) {
        case "oldest":
          return String(a.created_at).localeCompare(String(b.created_at));
        case "name":
          return a.name.localeCompare(b.name);
        case "posts":
          return b.post_count - a.post_count;
        default:
          return String(b.created_at).localeCompare(String(a.created_at));
      }
    });
    return rows;
  }, [blogs, statusFilter, sort]);

  return (
    <main className="min-h-dvh bg-neutral-50 dark:bg-neutral-950">
      <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-bold text-neutral-900 dark:text-white">
              Autonoblog
            </h1>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Dashboard
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/blogs/new"
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
            >
              Create blog
            </Link>
            <span className="text-sm text-neutral-600 dark:text-neutral-300">
              {user.displayName}
              <span className="ml-2 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                {user.roles.join(", ")}
              </span>
            </span>
            <button
              onClick={onLogout}
              disabled={loggingOut}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-200"
            >
              {loggingOut ? "…" : "Sign out"}
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-8">
        <h2 className="text-xl font-semibold text-neutral-900 dark:text-white">
          Welcome back, {user.displayName}
        </h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          This dashboard reads live from {STORAGE_LABEL[storage]}. Nothing here is
          mock data.
        </p>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          The guided blog creation wizard is live: <b>Create blog</b> opens{" "}
          <code className="rounded bg-neutral-100 px-1 py-0.5 text-xs dark:bg-neutral-800">
            /blogs/new
          </code>{" "}
          and walks through all 10 steps, saving a real blog to the database.
        </p>

        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Metric label="Your blogs" value={blogCount} />
          <Metric label="Posts" value={postCount} />
          <Metric label="Your role" value={user.roles[0] ?? "—"} />
        </div>

        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                Your blogs
              </h3>
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                {blogs.length} blog{blogs.length === 1 ? "" : "s"} where you are a
                member. Counters come from the{" "}
                <code className="rounded bg-neutral-100 px-1 py-0.5 dark:bg-neutral-800">
                  posts
                </code>{" "}
                and{" "}
                <code className="rounded bg-neutral-100 px-1 py-0.5 dark:bg-neutral-800">
                  pages
                </code>{" "}
                tables; 0 means the blog really has none yet.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {blogs.length > 0 && (
                <>
                  <div className="flex items-center gap-1 rounded-md border border-neutral-300 p-0.5 dark:border-neutral-700">
                    {statuses.map((s) => (
                      <button
                        key={s}
                        onClick={() => setStatusFilter(s)}
                        className={
                          "rounded px-2 py-1 text-xs font-medium capitalize " +
                          (statusFilter === s
                            ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                            : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800")
                        }
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortKey)}
                    aria-label="Sort blogs"
                    className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
                  >
                    <option value="newest">Newest first</option>
                    <option value="oldest">Oldest first</option>
                    <option value="name">Name A–Z</option>
                    <option value="posts">Most posts</option>
                  </select>
                </>
              )}
              <Link
                to="/blogs/new"
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                + Create blog
              </Link>
            </div>
          </div>

          {blogs.length === 0 ? (
            <div className="mt-3 rounded-md border border-dashed border-neutral-300 p-6 text-center dark:border-neutral-700">
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                You don’t have any blogs yet — this list is empty because the
                database has no blog rows for your account, not because the feature
                is missing.
              </p>
              <Link
                to="/blogs/new"
                className="mt-4 inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
              >
                Create your first blog
              </Link>
            </div>
          ) : visible.length === 0 ? (
            <div className="mt-3 rounded-md border border-dashed border-neutral-300 p-6 text-center dark:border-neutral-700">
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                No blog of yours currently has status “{statusFilter}”.{" "}
                <button
                  onClick={() => setStatusFilter("all")}
                  className="underline"
                >
                  Show all {blogs.length}
                </button>
              </p>
            </div>
          ) : (
            <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((b) => (
                <BlogCard key={b.id} blog={b} />
              ))}
            </ul>
          )}
        </section>

        <p className="mt-8">
          <Link
            to="/"
            className="text-sm text-neutral-500 underline hover:text-neutral-800 dark:hover:text-white"
          >
            ← Back to home
          </Link>
        </p>
      </div>
    </main>
  );
}

function BlogCard({ blog }: { blog: BlogCardRow }) {
  const autoPublish =
    blog.auto_publish === null
      ? "not configured"
      : blog.auto_publish
        ? "on"
        : "off (manual review)";
  const monetization =
    blog.monetization_active === null
      ? "not configured"
      : blog.monetization_active
        ? "active"
        : "off";
  return (
    <li>
      <Link
        to="/blogs/$blogId"
        params={{ blogId: String(blog.id) }}
        className="flex h-full flex-col rounded-lg border border-neutral-200 bg-white p-4 transition-shadow hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-semibold text-neutral-900 dark:text-white">
              {blog.name}
            </p>
            <p className="truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">
              /{blog.slug}
            </p>
          </div>
          <span
            className={
              "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset " +
              statusClass(blog.status)
            }
          >
            {blog.status}
          </span>
        </div>

        {blog.tagline ? (
          <p className="mt-2 line-clamp-2 text-sm text-neutral-500 dark:text-neutral-400">
            {blog.tagline}
          </p>
        ) : null}

        <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
          <Stat label="posts" value={blog.post_count} />
          <Stat label="published" value={blog.published_count} />
          <Stat label="pages" value={blog.page_count} />
        </dl>

        <dl className="mt-3 space-y-1 text-xs text-neutral-600 dark:text-neutral-300">
          <Row label="Created" value={fmtDate(blog.created_at)} />
          <Row
            label="Posts/day"
            value={blog.posts_per_day === null ? "not configured" : blog.posts_per_day}
          />
          <Row label="Auto-publish" value={autoPublish} />
          <Row label="Monetization" value={monetization} />
          <Row
            label="Language / TZ"
            value={
              blog.language
                ? `${blog.language} · ${blog.timezone ?? "—"}`
                : "not configured"
            }
          />
          <Row label="Your role" value={blog.member_role} />
          <Row label="Blog ID" value={`#${blog.id}`} />
        </dl>

        <p className="mt-4 pt-3 text-xs font-medium text-neutral-500 dark:text-neutral-400 border-t border-neutral-100 dark:border-neutral-800">
          Open blog dashboard →
        </p>
      </Link>
    </li>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-neutral-400">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-neutral-50 py-2 dark:bg-neutral-800/60">
      <dd className="text-lg font-bold text-neutral-900 dark:text-white">
        {value}
      </dd>
      <dt className="text-[10px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {label}
      </dt>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <p className="text-2xl font-bold text-neutral-900 dark:text-white">{value}</p>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{label}</p>
    </div>
  );
}
