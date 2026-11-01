/**
 * Autonoblog — Phase 5b image block editor (shared by the post editor and the
 * page builder, so the two editors cannot drift apart).
 *
 * The block's `data` is the single source of truth:
 *   { url, alt, caption?, mediaId? }
 *
 *  - "Choose from library" opens `MediaPicker`, which lists this blog's real
 *    media rows; picking one writes `url` = the served `/media/<id>` path,
 *    `alt` = the row's alt text (when it has one), `caption` = its file name,
 *    and `mediaId` = the row id, which is what makes the media library's
 *    "still referenced by N posts" guard exact.
 *  - The URL, alt and caption stay fully editable afterwards. Editing the URL
 *    by hand drops `mediaId` — the block no longer provably points at that row,
 *    so the media library must not keep counting it.
 *  - Missing alt text is a non-blocking accessibility warning, never a save
 *    blocker: the author is told, and the image still renders.
 */
import { useState } from "react";
import { MediaPicker } from "../media/MediaPicker";
import type { MediaListItem } from "../../server/dal/media";
import type { ImageBlock } from "./types";

export interface ImageBlockEditorProps {
  blogId: number;
  data: ImageBlock["data"];
  onChange: (next: ImageBlock["data"]) => void;
  /** Optional class overrides so each editor keeps its own input styling. */
  inputClassName?: string;
}

export function ImageBlockEditor({
  blogId,
  data,
  onChange,
  inputClassName,
}: ImageBlockEditorProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputCls =
    inputClassName ??
    "rounded-md border border-neutral-200 px-2 py-1 text-xs focus:border-emerald-500 focus:outline-none";

  const url = data.url.trim();
  const hasUrl = url !== "";
  const missingAlt = hasUrl && data.alt.trim() === "";

  function applyPicked(item: MediaListItem) {
    onChange({
      url: item.url,
      // Default the alt from the media record; never invent text for a file
      // that has no stored alt (the warning below then shows, honestly).
      alt: item.alt_text || "",
      caption: data.caption && data.caption.trim() !== "" ? data.caption : item.file_name,
      mediaId: item.id,
    });
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setPickerOpen(true)}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700"
        >
          Choose from library
        </button>
        {data.mediaId ? (
          <span className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800 ring-1 ring-inset ring-emerald-600/20">
            media #{data.mediaId}
            <button
              onClick={() => onChange({ ...data, mediaId: undefined })}
              title="Unlink from the library row (keeps the URL)"
              className="text-emerald-700 underline"
            >
              unlink
            </button>
          </span>
        ) : (
          <span className="text-[11px] text-neutral-500">
            or paste an external URL below
          </span>
        )}
      </div>

      <div className="sm:col-span-2">
        <input
          value={data.url}
          onChange={(e) =>
            // Hand-editing the URL unlinks the block from the media row.
            onChange({ ...data, url: e.target.value, mediaId: undefined })
          }
          placeholder="https://example.com/image.jpg — or pick from the library"
          className={
            "w-full rounded-md border border-neutral-200 px-2 py-1.5 font-mono text-xs focus:border-emerald-500 focus:outline-none"
          }
        />
      </div>

      <input
        value={data.alt}
        onChange={(e) => onChange({ ...data, alt: e.target.value })}
        placeholder="Alt text (required for accessibility)"
        className={inputCls}
      />
      <input
        value={data.caption ?? ""}
        onChange={(e) => onChange({ ...data, caption: e.target.value })}
        placeholder="Caption (optional)"
        className={inputCls}
      />

      {!hasUrl && (
        <p className="sm:col-span-2 text-[11px] text-amber-700">
          No image yet — choose one from the library or paste a URL. Until then the preview and
          public page show this block as missing rather than inventing an image.
        </p>
      )}

      {missingAlt && (
        <p
          role="status"
          className="sm:col-span-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800"
        >
          <b>Accessibility:</b> this image has no alt text, so screen readers will announce the
          file name instead of what the picture shows. You can still save and publish — this is a
          warning, not a blocker.
        </p>
      )}

      {hasUrl && (
        <div className="sm:col-span-2 flex items-start gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-2">
          <img
            src={data.url}
            alt={data.alt || ""}
            className="h-16 w-16 shrink-0 rounded border border-neutral-200 bg-white object-contain"
            loading="lazy"
          />
          <div className="min-w-0 text-[11px] text-neutral-600">
            <p className="truncate font-mono">{data.url}</p>
            <p className="mt-0.5">
              {data.mediaId
                ? "Linked to this blog's media library."
                : "External or hand-pasted URL (not tracked by the media library)."}
            </p>
          </div>
        </div>
      )}

      <MediaPicker
        blogId={blogId}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={applyPicked}
        selectedMediaId={data.mediaId ?? null}
      />
    </div>
  );
}

export default ImageBlockEditor;
