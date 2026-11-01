/**
 * Autonoblog — Phase 5b media picker (client component).
 *
 * The "Choose from library" dialog an image block opens in both the post editor
 * and the page builder. Everything it shows is real:
 *  - the grid is the blog's own `media` rows, fetched through
 *    `mediaPickerListAction` (member-scoped on the server — the blog id is a
 *    lookup key, never the authorisation);
 *  - uploading uses the SAME server path as the media library
 *    (`mediaUploadAction` → `createMediaForMember`), so there is exactly one
 *    upload implementation, one set of limits and one error vocabulary;
 *  - after a successful upload the new row is selected immediately;
 *  - failures are the server's actual messages. There is no placeholder tile,
 *    no fake "uploaded!" and no optimistic row that the database does not have.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  mediaPickerListAction,
  mediaUploadAction,
} from "../../server/rpc/media";
import type { MediaListItem } from "../../server/dal/media";

export interface MediaPickerProps {
  /** Blog whose library is being browsed — resolved to a membership server-side. */
  blogId: number;
  open: boolean;
  onClose: () => void;
  /** Called with the real row the user picked (or just uploaded). */
  onSelect: (item: MediaListItem) => void;
  /** Media id the block already uses, highlighted in the grid. */
  selectedMediaId?: number | null;
}

type LoadState = "loading" | "ready" | "error";

interface Limits {
  maxBytes: number;
  mimeTypes: string[];
  label: string;
}

const FALLBACK_LIMITS: Limits = {
  maxBytes: 5 * 1024 * 1024,
  mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
  label: "PNG, JPEG, GIF or WebP up to 5 MB",
};

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
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

export function MediaPicker({
  blogId,
  open,
  onClose,
  onSelect,
  selectedMediaId = null,
}: MediaPickerProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [rows, setRows] = useState<MediaListItem[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [canUpload, setCanUpload] = useState(false);
  const [limits, setLimits] = useState<Limits>(FALLBACK_LIMITS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [uploadStage, setUploadStage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    setLoadError(null);
    try {
      const res = await mediaPickerListAction({ data: { blogId } });
      if (res.forbidden) {
        setForbidden(true);
        setRows([]);
        setCanUpload(false);
        setState("ready");
        return;
      }
      setForbidden(false);
      setRows(res.media);
      setCanUpload(res.canUpload);
      setLimits(res.limits ?? FALLBACK_LIMITS);
      setState("ready");
    } catch (err) {
      setLoadError((err as Error).message);
      setState("error");
    }
  }, [blogId]);

  // Load on open (and reload if the blog changes while open). Nothing is
  // fetched while the dialog is closed.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setUploadErrors([]);
    setUploadStage(null);
    void load();
  }, [open, load]);

  // Escape closes — the dialog is keyboard-dismissable.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? rows.filter((r) => r.file_name.toLowerCase().includes(needle))
    : rows;

  async function handleFile(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) return;
    setUploadErrors([]);
    setUploadStage(null);

    // Instant, honest client-side pre-check; the server re-checks the same
    // limits against the real bytes and is the authority.
    if (!limits.mimeTypes.includes(file.type)) {
      setUploadErrors([
        `"${file.name}": ${file.type || "unknown type"} is not accepted — ${limits.label}.`,
      ]);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    if (file.size > limits.maxBytes) {
      setUploadErrors([
        `"${file.name}" is ${humanBytes(file.size)} — the per-file limit is ${humanBytes(
          limits.maxBytes
        )}.`,
      ]);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    try {
      setUploadStage(`Reading “${file.name}” (${humanBytes(file.size)})…`);
      const base64 = await readAsDataUrl(file);
      setUploadStage(`Uploading “${file.name}” to this blog's library…`);
      const res = await mediaUploadAction({
        data: { blogId, base64, fileName: file.name },
      });
      if (!res.ok || !res.data) {
        setUploadStage(null);
        setUploadErrors([res.error ?? `"${file.name}" could not be uploaded.`]);
        if (inputRef.current) inputRef.current.value = "";
        return;
      }
      const item = res.data.media;
      setRows((prev) => [item, ...prev]);
      setUploadStage(null);
      if (inputRef.current) inputRef.current.value = "";
      // Successful upload → select it straight away, exactly like picking it.
      onSelect(item);
      onClose();
    } catch (err) {
      setUploadStage(null);
      setUploadErrors([(err as Error).message]);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-neutral-900/50 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Choose an image from the media library"
      onMouseDown={(e) => {
        // Click on the backdrop (not the panel) closes the dialog.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-4xl rounded-xl border border-neutral-200 bg-white shadow-xl">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-200 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-neutral-900">Media library</h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              Images in this blog only. Picking one fills the block&apos;s URL, alt text and
              caption.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void load()}
              disabled={state === "loading"}
              className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
            >
              {state === "loading" ? "Loading…" : "Refresh"}
            </button>
            <button
              onClick={onClose}
              className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50"
            >
              Close
            </button>
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-3 border-b border-neutral-100 px-5 py-3">
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by file name…"
            className="w-64 max-w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm focus:border-emerald-500 focus:outline-none"
          />
          <span className="text-xs text-neutral-500">
            {state === "ready"
              ? `${visible.length} of ${rows.length} file${rows.length === 1 ? "" : "s"}`
              : ""}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {canUpload ? (
              <>
                <input
                  ref={inputRef}
                  type="file"
                  accept={limits.mimeTypes.join(",")}
                  onChange={(e) => void handleFile(e.target.files)}
                  disabled={uploadStage !== null}
                  className="block w-64 max-w-full cursor-pointer rounded-md border border-neutral-300 bg-white p-1 text-xs text-neutral-700 file:mr-2 file:rounded file:border-0 file:bg-neutral-900 file:px-2 file:py-1 file:text-[11px] file:font-medium file:text-white disabled:opacity-60"
                />
                <span className="hidden text-[11px] text-neutral-500 sm:inline">
                  {limits.label}
                </span>
              </>
            ) : (
              <span className="text-[11px] text-neutral-500">
                Your role cannot upload to this blog.
              </span>
            )}
          </div>
        </div>

        {uploadStage && (
          <p className="animate-pulse border-b border-neutral-100 bg-sky-50 px-5 py-2 text-xs text-sky-800">
            {uploadStage}
          </p>
        )}
        {uploadErrors.length > 0 && (
          <ul className="space-y-1 border-b border-red-100 bg-red-50 px-5 py-2 text-xs text-red-700">
            {uploadErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}

        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          {state === "loading" && (
            <div className="flex items-center justify-center py-16 text-sm text-neutral-500">
              <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700" />
              Loading this blog&apos;s media from the database…
            </div>
          )}

          {state === "error" && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-6 text-center">
              <p className="text-sm font-medium text-red-800">
                The media library could not be loaded.
              </p>
              <p className="mt-1 text-xs text-red-700">{loadError}</p>
              <button
                onClick={() => void load()}
                className="mt-3 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
              >
                Try again
              </button>
            </div>
          )}

          {state === "ready" && forbidden && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-6 text-center">
              <p className="text-sm font-medium text-amber-900">
                You are not a member of this blog.
              </p>
              <p className="mt-1 text-xs text-amber-800">
                Media is scoped per blog, so there is nothing to show here.
              </p>
            </div>
          )}

          {state === "ready" && !forbidden && rows.length === 0 && (
            <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-4 py-12 text-center">
              <p className="text-sm font-medium text-neutral-700">
                No media in this blog yet — upload your first file
              </p>
              <p className="mx-auto mt-1 max-w-md text-xs text-neutral-500">
                {canUpload
                  ? `Use the file picker above. Accepted: ${limits.label}. The upload goes through the same server path as the media library, so it appears there too.`
                  : "An owner, administrator, editor or author of this blog can upload the first image."}
              </p>
              {canUpload && (
                <button
                  onClick={() => inputRef.current?.click()}
                  disabled={uploadStage !== null}
                  className="mt-4 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60"
                >
                  Choose an image…
                </button>
              )}
            </div>
          )}

          {state === "ready" && !forbidden && rows.length > 0 && visible.length === 0 && (
            <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-4 py-10 text-center">
              <p className="text-sm font-medium text-neutral-700">
                No file name matches “{query}”.
              </p>
              <button
                onClick={() => setQuery("")}
                className="mt-2 text-xs text-emerald-700 underline"
              >
                Clear the filter
              </button>
            </div>
          )}

          {state === "ready" && !forbidden && visible.length > 0 && (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((row) => {
                const isSelected = selectedMediaId === row.id;
                return (
                  <li key={row.id}>
                    <button
                      onClick={() => {
                        onSelect(row);
                        onClose();
                      }}
                      className={
                        "group w-full overflow-hidden rounded-lg border text-left transition " +
                        (isSelected
                          ? "border-emerald-500 ring-2 ring-emerald-200"
                          : "border-neutral-200 hover:border-emerald-400 hover:shadow-sm")
                      }
                    >
                      <div className="flex h-32 items-center justify-center border-b border-neutral-100 bg-[repeating-conic-gradient(#f5f5f5_0%_25%,#ffffff_0%_50%)] bg-[length:16px_16px]">
                        <img
                          src={row.url}
                          alt={row.alt_text || row.file_name}
                          loading="lazy"
                          className="max-h-32 max-w-full object-contain"
                        />
                      </div>
                      <div className="space-y-0.5 p-2.5">
                        <p
                          className="truncate text-sm font-medium text-neutral-900"
                          title={row.file_name}
                        >
                          {row.file_name}
                        </p>
                        <p className="text-[11px] text-neutral-500">
                          {row.width && row.height
                            ? `${row.width}×${row.height}px · `
                            : ""}
                          {humanBytes(row.size_bytes)}
                        </p>
                        <p className="text-[11px] text-neutral-400">
                          #{row.id} · uploaded {fmtDate(row.created_at)}
                          {row.uploader_name ? ` by ${row.uploader_name}` : ""}
                        </p>
                        {row.alt_text ? (
                          <p className="truncate text-[11px] text-neutral-500" title={row.alt_text}>
                            alt: {row.alt_text}
                          </p>
                        ) : (
                          <p className="text-[11px] text-amber-700">
                            no alt text stored on this file
                          </p>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 px-5 py-3 text-[11px] text-neutral-500">
          <span>
            Files are served from{" "}
            <code className="rounded bg-neutral-100 px-1">/media/&lt;id&gt;</code> — picking one
            stores that path in the block.
          </span>
          <button
            onClick={onClose}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50"
          >
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}

export default MediaPicker;
