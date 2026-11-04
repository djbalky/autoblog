/**
 * Autonoblog — Phase 5a media library (client component).
 *
 * Renders the real rows of the `media` table for one blog. Uploads go through
 * `mediaUploadAction` (which re-validates the bytes server-side and writes a
 * real row + file); deletes go through `mediaDeleteAction` (row + file). Every
 * failure surfaces the server's actual message — there is no optimistic fake
 * success and no placeholder tile.
 */
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  mediaDeleteAction,
  mediaReferencesAction,
  mediaUploadAction,
} from "../../server/rpc/media";
import type { MediaListItem, MediaReferenceSummary, MediaUsage } from "../../server/dal/media";

export interface MediaLibraryProps {
  blog: { id: number; name: string; slug: string; status: string };
  role: string;
  initialMedia: MediaListItem[];
  usage: MediaUsage;
  canUpload: boolean;
  canDelete: boolean;
  limits: { maxBytes: number; mimeTypes: string[]; label: string };
}

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours()
  )}:${p(d.getUTCMinutes())} UTC`;
}

/** Read a File as a data URL (what the upload RPC takes). */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(`Could not read "${file.name}" from disk.`));
    reader.readAsDataURL(file);
  });
}

export function MediaLibrary({
  blog,
  role,
  initialMedia,
  usage,
  canUpload,
  canDelete,
  limits,
}: MediaLibraryProps) {
  const [rows, setRows] = useState<MediaListItem[]>(initialMedia);
  const [busy, setBusy] = useState(false);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  // Phase 5b: the real reference count for the row being confirmed, loaded from
  // the database before the delete is offered — never a guessed number.
  const [refs, setRefs] = useState<MediaReferenceSummary | null>(null);
  const [refsLoading, setRefsLoading] = useState(false);
  const [refsError, setRefsError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const usedBytes = rows.reduce((sum, r) => sum + r.size_bytes, 0);
  const storageLimit = usage.storageLimitBytes;

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setErrors([]);
    setNotice(null);
    const failures: string[] = [];
    const added: MediaListItem[] = [];
    setBusy(true);
    for (const file of Array.from(fileList)) {
      // Client-side pre-checks give an instant, honest message; the server
      // re-checks the same limits against the real bytes.
      if (!limits.mimeTypes.includes(file.type)) {
        failures.push(
          `"${file.name}": ${file.type || "unknown type"} is not accepted — ${limits.label}.`
        );
        continue;
      }
      if (file.size > limits.maxBytes) {
        failures.push(
          `"${file.name}" is ${humanBytes(file.size)} — the per-file limit is ${humanBytes(
            limits.maxBytes
          )}.`
        );
        continue;
      }
      setUploadingName(file.name);
      try {
        const base64 = await readAsDataUrl(file);
        const res = await mediaUploadAction({
          data: { blogId: blog.id, base64, fileName: file.name },
        });
        if (!res.ok || !res.data) {
          failures.push(res.error ?? `"${file.name}" could not be uploaded.`);
          continue;
        }
        added.push(res.data.media);
      } catch (err) {
        failures.push((err as Error).message);
      }
    }
    setUploadingName(null);
    setBusy(false);
    if (added.length > 0) {
      setRows((prev) => [...added, ...prev]);
      setNotice(
        `${added.length} file${added.length === 1 ? "" : "s"} uploaded to the ${blog.name} media library.`
      );
    }
    if (failures.length > 0) setErrors(failures);
    if (inputRef.current) inputRef.current.value = "";
  }

  /**
   * Phase 5b: before offering the delete, load the REAL per-blog reference
   * count. The count comes from `mediaReferencesForMember`, which parses the
   * current content of this blog's posts and pages. A failure here is shown as
   * a failure — the delete is not offered on a guess.
   */
  async function askDelete(row: MediaListItem) {
    setConfirmId(row.id);
    setRefs(null);
    setRefsError(null);
    setRefsLoading(true);
    setErrors([]);
    setNotice(null);
    try {
      const res = await mediaReferencesAction({
        data: { blogId: blog.id, mediaId: row.id },
      });
      if (!res.ok || !res.data) {
        setRefsError(res.error ?? "The reference count could not be read.");
        return;
      }
      setRefs(res.data.references);
    } catch (err) {
      setRefsError((err as Error).message);
    } finally {
      setRefsLoading(false);
    }
  }

  function cancelDelete() {
    setConfirmId(null);
    setRefs(null);
    setRefsError(null);
    setRefsLoading(false);
  }

  async function remove(row: MediaListItem, force: boolean) {
    setBusy(true);
    setErrors([]);
    setNotice(null);
    const res = await mediaDeleteAction({
      data: { blogId: blog.id, mediaId: row.id, force },
    });
    setBusy(false);
    if (!res.ok) {
      // A `blocked` answer means the server found live references this client
      // did not know about (e.g. someone else just embedded the image). Show the
      // server's real count and keep the row.
      if (res.blocked && res.references) {
        setRefs(res.references);
        setErrors([res.error ?? "This image is still in use."]);
        return;
      }
      setErrors([res.error ?? "That media item could not be deleted."]);
      cancelDelete();
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    cancelDelete();
    const refCount = res.data?.references.total ?? 0;
    setNotice(
      `Deleted "${row.file_name}" from this blog` +
        (refCount > 0
          ? ` — ${refCount} post/page reference${refCount === 1 ? "" : "s"} now point at a missing image.`
          : " (no post or page referenced it).")
    );
  }

  async function copyUrl(row: MediaListItem) {
    const absolute = `${window.location.origin}${row.url}`;
    try {
      await navigator.clipboard.writeText(absolute);
      setNotice(`Copied ${absolute}`);
    } catch {
      setNotice(`Copy blocked by the browser — the URL is ${absolute}`);
    }
  }

  return (
    <main className="min-h-dvh bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">Media</p>
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
            <Link
              to="/blogs/$blogId/pages"
              params={{ blogId: String(blog.id) }}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-700 hover:bg-neutral-50"
            >
              Pages
            </Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-neutral-900">Media library</h2>
            <p className="mt-1 text-sm text-neutral-500">
              {rows.length} file{rows.length === 1 ? "" : "s"} · {humanBytes(usedBytes)} stored
              {storageLimit !== null ? (
                <> of {humanBytes(storageLimit)} plan allowance</>
              ) : usage.storageUnlimited ? (
                <> — your plan has no storage cap</>
              ) : (
                <> — no plan subscription, so only the per-file limit applies</>
              )}
              . You are signed in as <b className="capitalize">{role}</b> of this blog.
            </p>
          </div>

          {canUpload ? (
            <div className="flex flex-col items-end gap-1">
              <input
                ref={inputRef}
                type="file"
                accept={limits.mimeTypes.join(",")}
                multiple
                onChange={(e) => void handleFiles(e.target.files)}
                disabled={busy}
                className="block w-72 max-w-full cursor-pointer rounded-md border border-neutral-300 bg-white p-1.5 text-sm text-neutral-700 file:mr-2 file:rounded file:border-0 file:bg-neutral-900 file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-white disabled:opacity-60"
              />
              <p className="text-xs text-neutral-500">
                {busy && uploadingName ? `Uploading ${uploadingName}…` : limits.label}
              </p>
            </div>
          ) : (
            <p className="max-w-xs rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Your role (<b>{role}</b>) cannot upload media. Uploading needs{" "}
              <code>media.upload</code> or <code>media.manage</code>.
            </p>
          )}
        </div>

        {notice && (
          <p className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {notice}
          </p>
        )}
        {errors.length > 0 && (
          <ul className="mt-4 space-y-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}

        {busy && uploadingName && (
          <p className="mt-4 animate-pulse text-sm text-neutral-500">
            Uploading “{uploadingName}” — writing the file, then the database row…
          </p>
        )}

        {rows.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-neutral-300 bg-white p-10 text-center">
            <p className="text-sm font-medium text-neutral-700">No media yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-neutral-500">
              This blog has zero rows in the <code className="rounded bg-neutral-100 px-1">media</code>{" "}
              table. Upload an image — the file is written to disk and a real row is inserted
              immediately.
            </p>
            {canUpload && (
              <button
                onClick={() => inputRef.current?.click()}
                disabled={busy}
                className="mt-4 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60"
              >
                Choose an image…
              </button>
            )}
          </div>
        ) : (
          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((row) => (
              <li
                key={row.id}
                className="overflow-hidden rounded-lg border border-neutral-200 bg-white"
              >
                <div className="flex h-40 items-center justify-center border-b border-neutral-100 bg-[repeating-conic-gradient(#f5f5f5_0%_25%,#ffffff_0%_50%)] bg-[length:16px_16px]">
                  <img
                    src={row.url}
                    alt={row.alt_text || row.file_name}
                    loading="lazy"
                    className="max-h-40 max-w-full object-contain"
                  />
                </div>
                <div className="space-y-1 p-3">
                  <p className="truncate text-sm font-medium text-neutral-900" title={row.file_name}>
                    {row.file_name}
                  </p>
                  <p className="text-xs text-neutral-500">
                    {row.mime_type} · {humanBytes(row.size_bytes)}
                    {row.width && row.height ? ` · ${row.width}×${row.height}px` : ""}
                  </p>
                  <p className="text-xs text-neutral-400">
                    #{row.id} · {fmt(row.created_at)}
                    {row.uploader_name ? ` · ${row.uploader_name}` : ""}
                  </p>
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <button
                      onClick={() => void copyUrl(row)}
                      className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100"
                    >
                      Copy URL
                    </button>
                    {canDelete ? (
                      <button
                        onClick={() => void askDelete(row)}
                        disabled={busy}
                        className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-60"
                      >
                        Delete
                      </button>
                    ) : (
                      <span className="text-[11px] text-neutral-400">delete needs media.manage</span>
                    )}
                  </div>

                  {canDelete && confirmId === row.id && (
                    <div className="mt-2 rounded-md border border-neutral-300 bg-neutral-50 p-2 text-[11px] leading-4 text-neutral-700">
                      {refsLoading ? (
                        <p className="flex items-center gap-1.5 text-neutral-600">
                          <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700" />
                          Checking whether any post or page in this blog uses this image…
                        </p>
                      ) : refsError ? (
                        <>
                          <p className="text-red-700">
                            The reference count could not be read, so the delete is not offered:{" "}
                            {refsError}
                          </p>
                          <div className="mt-2 flex gap-1">
                            <button
                              onClick={() => void askDelete(row)}
                              className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100"
                            >
                              Retry
                            </button>
                            <button
                              onClick={cancelDelete}
                              className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100"
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : refs && refs.total > 0 ? (
                        <>
                          <p className="font-medium text-red-800">
                            Used by{" "}
                            {[
                              refs.post_count > 0
                                ? `${refs.post_count} post${refs.post_count === 1 ? "" : "s"}`
                                : null,
                              refs.page_count > 0
                                ? `${refs.page_count} page${refs.page_count === 1 ? "" : "s"}`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" and ")}{" "}
                            in this blog.
                          </p>
                          <ul className="mt-1 space-y-0.5">
                            {refs.references.map((ref) => (
                              <li key={`${ref.entity_type}-${ref.entity_id}`} className="truncate">
                                <span className="rounded bg-neutral-200 px-1 text-[10px] uppercase tracking-wide">
                                  {ref.entity_type}
                                </span>{" "}
                                {ref.title || "(untitled)"}{" "}
                                <span className="text-neutral-500">({ref.status})</span>
                              </li>
                            ))}
                          </ul>
                          {refs.truncated && (
                            <p className="mt-1 text-neutral-500">
                              …and {refs.total - refs.references.length} more.
                            </p>
                          )}
                          <p className="mt-1 text-neutral-500">
                            Counts cover the current content of posts and pages in this blog, not
                            old revisions.
                          </p>
                          <div className="mt-2 flex flex-wrap gap-1">
                            <button
                              onClick={() => void remove(row, true)}
                              disabled={busy}
                              className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-60"
                            >
                              {busy ? "Deleting…" : "Delete anyway"}
                            </button>
                            <button
                              onClick={cancelDelete}
                              className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100"
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <p>
                            No post or page in this blog references this file. Deleting removes the
                            database row and the file on disk.
                          </p>
                          <div className="mt-2 flex gap-1">
                            <button
                              onClick={() => void remove(row, false)}
                              disabled={busy}
                              className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-60"
                            >
                              {busy ? "Deleting…" : "Confirm delete"}
                            </button>
                            <button
                              onClick={cancelDelete}
                              className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100"
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-8 text-xs text-neutral-400">
          Files are served from <code className="rounded bg-neutral-100 px-1">/media/&lt;id&gt;</code>{" "}
          with their real content type and a long-lived cache header. Deletes remove the database
          row and the file on disk.
        </p>
      </div>
    </main>
  );
}
