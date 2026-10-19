/**
 * Autonoblog — Phase 4b pages list (client component).
 *
 * Renders the real rows of the `pages` table for one blog. Counts, badges and
 * dates all come from the loader's SQL; an empty blog shows an honest empty
 * state. Nothing here is mocked.
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState, useTransition } from "react";
import {
  createNewPageAction,
  duplicatePageAction,
} from "../../server/rpc/pages";
import type { PageListItem, PageStatus } from "../../server/dal/pages";

const STATUS_BADGE: Record<string, string> = {
  published: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  draft: "bg-amber-50 text-amber-700 ring-amber-600/20",
  scheduled: "bg-sky-50 text-sky-700 ring-sky-600/20",
  trashed: "bg-neutral-100 text-neutral-500 ring-neutral-400/30",
};

function badgeClass(status: string): string {
  return STATUS_BADGE[status] ?? "bg-neutral-100 text-neutral-600 ring-neutral-400/30";
}

/** Timestamps are stored as ISO text — show date + HH:MM in UTC. */
function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours()
  )}:${p(d.getUTCMinutes())} UTC`;
}

export interface PagesListProps {
  blog: { id: number; name: string; slug: string; status: string };
  role: string;
  pages: PageListItem[];
  counts: Record<string, number>;
}

export function PagesList({ blog, role, pages, counts }: PagesListProps) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<"all" | PageStatus>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const visible = useMemo(
    () => (filter === "all" ? pages : pages.filter((p) => p.status === filter)),
    [pages, filter]
  );

  const totalPages = pages.filter((p) => p.status !== "trashed").length;

  async function createPage() {
    setBusy(true);
    setError(null);
    const res = await createNewPageAction({ data: { blogId: blog.id, title: "Untitled page" } });
    setBusy(false);
    if (!res.ok || !res.data) {
      setError(res.error ?? "The page could not be created.");
      return;
    }
    startTransition(() => {
      navigate({
        to: "/blogs/$blogId/pages/$pageId",
        params: { blogId: String(blog.id), pageId: String(res.data!.id) },
      });
    });
  }

  async function duplicate(page: PageListItem) {
    setBusy(true);
    setError(null);
    const res = await duplicatePageAction({ data: { blogId: blog.id, pageId: page.id } });
    setBusy(false);
    if (!res.ok || !res.data) {
      setError(res.error ?? "The page could not be duplicated.");
      return;
    }
    startTransition(() => {
      navigate({
        to: "/blogs/$blogId/pages/$pageId",
        params: { blogId: String(blog.id), pageId: String(res.data!.id) },
      });
    });
  }

  return (
    <main className="min-h-dvh bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">Pages</p>
            <h1 className="truncate text-lg font-bold text-neutral-900">{blog.name}</h1>
            <p className="truncate font-mono text-xs text-neutral-500">/{blog.slug}</p>
          </div>
          <nav className="flex flex-wrap items-center gap-2 text-sm">
            <Link
              to="/blogs/$blogId"
              params={{ blogId: String(blog.id) }}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-700 hover:bg-neutral-50"
            >
              ← Blog overview
            </Link>
            <Link
              to="/blogs/$blogId/posts"
              params={{ blogId: String(blog.id) }}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-700 hover:bg-neutral-50"
            >
              Posts
            </Link>
            <button
              onClick={createPage}
              disabled={busy}
              className="rounded-md bg-neutral-900 px-3 py-1.5 font-medium text-white hover:bg-neutral-700 disabled:opacity-60"
            >
              {busy ? "Working…" : "+ New page"}
            </button>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-neutral-900">All pages</h2>
            <p className="mt-1 text-sm text-neutral-500">
              {totalPages} page{totalPages === 1 ? "" : "s"} in this blog (excluding trash). You are
              signed in as <b className="capitalize">{role}</b> of this blog.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1 rounded-md border border-neutral-300 bg-white p-0.5">
            {(["all", "draft", "scheduled", "published", "trashed"] as const).map((s) => {
              const n = s === "all" ? pages.length : counts[s] ?? 0;
              const active = filter === s;
              return (
                <button
                  key={s}
                  onClick={() => setFilter(s)}
                  className={
                    "rounded px-2.5 py-1 text-xs font-medium capitalize " +
                    (active ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100")
                  }
                >
                  {s} <span className={active ? "text-neutral-300" : "text-neutral-400"}>{n}</span>
                </button>
              );
            })}
          </div>
        </div>

        {error && (
          <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        {pages.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-neutral-300 bg-white p-10 text-center">
            <p className="text-sm font-medium text-neutral-700">No pages yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-neutral-500">
              This blog has zero rows in the{" "}
              <code className="rounded bg-neutral-100 px-1">pages</code> table. Build one with the
              page builder — it saves to the database immediately.
            </p>
            <button
              onClick={createPage}
              disabled={busy}
              className="mt-4 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60"
            >
              {busy ? "Creating…" : "Build the first page"}
            </button>
          </div>
        ) : (
          <div className="mt-5 overflow-hidden rounded-lg border border-neutral-200 bg-white">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <th className="px-4 py-2.5 font-medium">Title</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Updated</th>
                  <th className="px-4 py-2.5 font-medium">Published</th>
                  <th className="px-4 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-neutral-500">
                      No page in this blog has status “{filter}”.
                    </td>
                  </tr>
                ) : (
                  visible.map((page) => (
                    <tr
                      key={page.id}
                      className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50/70"
                    >
                      <td className="px-4 py-3">
                        <Link
                          to="/blogs/$blogId/pages/$pageId"
                          params={{ blogId: String(blog.id), pageId: String(page.id) }}
                          className="font-medium text-neutral-900 hover:text-emerald-700 hover:underline"
                        >
                          {page.title || "(untitled)"}
                        </Link>
                        <p className="mt-0.5 truncate font-mono text-xs text-neutral-400">
                          /{blog.slug}/{page.slug}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={
                            "rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset " +
                            badgeClass(page.status)
                          }
                        >
                          {page.status}
                        </span>
                        {page.status === "scheduled" && page.scheduled_at ? (
                          <p className="mt-1 text-[11px] text-neutral-500">
                            for {fmt(page.scheduled_at)}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-neutral-600">{fmt(page.updated_at)}</td>
                      <td className="px-4 py-3 text-neutral-600">{fmt(page.published_at)}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <Link
                            to="/blogs/$blogId/pages/$pageId"
                            params={{ blogId: String(blog.id), pageId: String(page.id) }}
                            className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100"
                          >
                            Edit
                          </Link>
                          <button
                            onClick={() => duplicate(page)}
                            disabled={busy}
                            className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-60"
                          >
                            Duplicate
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
