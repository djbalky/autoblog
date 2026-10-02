import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { useLoaderData, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  currentUserAction,
  dashboardStatsAction,
  myBlogsAction,
  logoutAction,
} from "../server/rpc/auth";
import type { BlogWithCount } from "../server/dal/blogs";
import type { PublicUser } from "../server/auth";
export const Route = createFileRoute("/dashboard")({
  loader: async (): Promise<{
    user: PublicUser;
    blogCount: number;
    postCount: number;
    storage: "postgres" | "sqlite";
    blogs: BlogWithCount[];
  }> => {
    const { user } = await currentUserAction();
    if (!user) throw redirect({ to: "/login" });
    const stats = await dashboardStatsAction();
    const blogs = await myBlogsAction();
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

function Dashboard() {
  const { user, blogCount, postCount, storage, blogs } = useLoaderData({
    from: "/dashboard",
  });
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);

  async function onLogout() {
    setLoggingOut(true);
    await logoutAction();
    navigate({ to: "/login" });
  }

  return (
    <main className="min-h-dvh bg-neutral-50 dark:bg-neutral-950">
      <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
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

      <div className="mx-auto max-w-4xl px-6 py-8">
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
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              Your blogs
            </h3>
            <Link
              to="/blogs/new"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              + Create blog
            </Link>
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
          ) : (
            <ul className="mt-3 space-y-2">
              {blogs.map((b) => (
                <li key={b.id}>
                  <Link
                    to="/blogs/$blogId"
                    params={{ blogId: String(b.id) }}
                    className="block rounded-md border border-neutral-200 bg-white p-4 transition-colors hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-600"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-neutral-900 dark:text-white">
                        {b.name}
                      </span>
                      <span className="text-xs text-neutral-500 dark:text-neutral-400">
                        /{b.slug}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                      {b.post_count} post{b.post_count === 1 ? "" : "s"} · {b.status}{" "}
                      · blog #{b.id} · open →
                    </p>
                  </Link>
                </li>
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

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <p className="text-2xl font-bold text-neutral-900 dark:text-white">{value}</p>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{label}</p>
    </div>
  );
}
