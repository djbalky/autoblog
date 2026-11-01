/**
 * Autonoblog — Phase 4b page builder (client component).
 *
 * The page sibling of the post editor. It writes the real `pages` row and
 * appends a real `page_revisions` row on every save:
 *  - blocks are stored in `pages.content` using the SAME envelope as posts
 *    (components/blocks/types.ts) and rendered by the SAME component
 *    (components/blocks/renderBlocks.tsx), so Phase 5's public renderer serves
 *    posts and pages alike;
 *  - page-builder-only blocks (hero / two-column / CTA / spacer) are ordinary
 *    blocks in that envelope;
 *  - publish / unpublish / schedule / trash write the status columns
 *    (published_at is set once, cleared on unpublish), and the notice bar only
 *    ever repeats what the database returned;
 *  - loading a revision fills the editor in memory — nothing is written until
 *    the author saves again.
 */
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  createBlock,
  parseBlocks,
  serializeBlocks,
  suggestExcerpt,
  type Block,
  type PageBlockType,
} from "../blocks/types";
import { RenderBlocks } from "../blocks/renderBlocks";
import {
  createNewPageAction,
  savePageAction,
  setPageStatusAction,
} from "../../server/rpc/pages";
import type { PageRevisionRow, PageRow, PageStatus } from "../../server/dal/pages";

const BLOCK_LABELS: Record<PageBlockType, string> = {
  paragraph: "Paragraph",
  heading: "Heading",
  list: "List",
  quote: "Quote",
  image: "Image",
  hero: "Hero",
  "two-column": "Two columns",
  cta: "CTA",
  spacer: "Spacer",
};

const BLOCK_BUTTONS: { type: PageBlockType; hint: string }[] = [
  { type: "hero", hint: "Big headline + subtext band — the top of a landing page" },
  { type: "heading", hint: "H2 or H3 section title" },
  { type: "paragraph", hint: "Plain multi-line text, supports **bold** *italic* [links](url)" },
  { type: "two-column", hint: "Two text columns side by side" },
  { type: "list", hint: "Bulleted or numbered list" },
  { type: "quote", hint: "Pull-quote with optional attribution" },
  { type: "image", hint: "Image by URL + alt text (media library lands in Phase 5)" },
  { type: "cta", hint: "Call-to-action banner with a real http(s) button link" },
  { type: "spacer", hint: "Vertical space between sections" },
];

const STATUS_BADGE: Record<string, string> = {
  published: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  draft: "bg-amber-50 text-amber-700 ring-amber-600/20",
  scheduled: "bg-sky-50 text-sky-700 ring-sky-600/20",
  trashed: "bg-neutral-100 text-neutral-500 ring-neutral-400/30",
};

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours()
  )}:${p(d.getUTCMinutes())} UTC`;
}

/** ISO instant -> value for <input type="datetime-local"> in UTC. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(
    d.getUTCHours()
  )}:${p(d.getUTCMinutes())}`;
}

export interface PageBuilderProps {
  blog: { id: number; name: string; slug: string };
  role: string;
  page: PageRow | null;
  revisions: PageRevisionRow[];
}

type Busy = null | "save" | "publish" | "unpublish" | "schedule" | "trash" | "restore" | "create";

export function PageBuilder({ blog, role, page, revisions }: PageBuilderProps) {
  const navigate = useNavigate();
  const parsed = useMemo(() => parseBlocks(page?.content ?? ""), [page?.content]);

  const [title, setTitle] = useState(page?.title ?? "");
  const [excerpt, setExcerpt] = useState(parsed.meta.excerpt ?? "");
  const [slug, setSlug] = useState(page?.slug ?? "");
  const [blocks, setBlocks] = useState<Block[]>(parsed.blocks);
  const [status, setStatus] = useState<PageStatus>(page?.status ?? "draft");
  const [scheduledAt, setScheduledAt] = useState(toLocalInput(page?.scheduled_at));
  const [publishedAt, setPublishedAt] = useState(page?.published_at ?? null);
  const [storedScheduledAt, setStoredScheduledAt] = useState(page?.scheduled_at ?? null);
  const [updatedAt, setUpdatedAt] = useState(page?.updated_at ?? null);
  const [revisionList, setRevisionList] = useState<PageRevisionRow[]>(revisions);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [loadedRevision, setLoadedRevision] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [sidebarTab, setSidebarTab] = useState<"publishing" | "revisions">("publishing");

  const currentRevision = revisionList[0]?.revision_number ?? null;
  const isNewPage = page === null;

  function touch() {
    setDirty(true);
    setLoadedRevision(null);
  }

  // ---- Block operations ---------------------------------------------------
  function addBlock(type: PageBlockType) {
    const block = createBlock(type);
    setBlocks((prev) => {
      const at = activeIndex === null ? prev.length : Math.min(activeIndex + 1, prev.length);
      const next = [...prev.slice(0, at), block, ...prev.slice(at)];
      setActiveIndex(at);
      return next;
    });
    touch();
  }

  function updateBlock(index: number, updater: (b: Block) => Block) {
    setBlocks((prev) => prev.map((b, i) => (i === index ? updater(b) : b)));
    touch();
  }

  function moveBlock(index: number, dir: -1 | 1) {
    setBlocks((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      setActiveIndex(target);
      return next;
    });
    touch();
  }

  function moveTo(index: number, target: number) {
    if (target < 0 || target >= blocks.length) return;
    setBlocks((prev) => {
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
    touch();
  }

  function removeBlock(index: number) {
    setBlocks((prev) => prev.filter((_, i) => i !== index));
    setActiveIndex(null);
    touch();
  }

  // ---- Persistence --------------------------------------------------------
  async function createDraft() {
    setBusy("create");
    setNotice(null);
    const res = await createNewPageAction({
      data: { blogId: blog.id, title: title.trim() || "Untitled page" },
    });
    setBusy(null);
    if (!res.ok || !res.data) {
      setNotice({ kind: "err", text: res.error ?? "The page could not be created." });
      return;
    }
    navigate({
      to: "/blogs/$blogId/pages/$pageId",
      params: { blogId: String(blog.id), pageId: String(res.data.id) },
    });
  }

  async function persist(nextStatus?: PageStatus, nextScheduledAt?: string | null) {
    if (!page) return null;
    const res = await savePageAction({
      data: {
        blogId: blog.id,
        pageId: page.id,
        title: title.trim() || "Untitled page",
        content: serializeBlocks(blocks, { excerpt }),
        slug: slug || undefined,
        status: nextStatus,
        scheduledAt: nextScheduledAt ?? null,
      },
    });
    if (!res.ok || !res.data) {
      setNotice({ kind: "err", text: res.error ?? "Save failed — nothing was written." });
      return null;
    }
    const saved = res.data.page;
    setTitle(saved.title);
    setSlug(saved.slug);
    setStatus(saved.status);
    setPublishedAt(saved.published_at);
    setStoredScheduledAt(saved.scheduled_at);
    setUpdatedAt(saved.updated_at);
    setScheduledAt(toLocalInput(saved.scheduled_at));
    setRevisionList(res.data.revisions);
    setDirty(false);
    return { page: saved, revision: res.data.revisionNumber };
  }

  async function onSaveDraft() {
    setBusy("save");
    setNotice(null);
    const saved = await persist();
    setBusy(null);
    if (saved) {
      setNotice({
        kind: "ok",
        text: `Saved to the database as revision #${saved.revision} (status ${saved.page.status}).`,
      });
    }
  }

  async function onPublish() {
    setBusy("publish");
    setNotice(null);
    const saved = await persist("published");
    setBusy(null);
    if (saved) {
      setNotice({
        kind: "ok",
        text: `Published — revision #${saved.revision}; status “${saved.page.status}”, published_at ${fmt(
          saved.page.published_at
        )}. Public URL rendering ships in Phase 5.`,
      });
    }
  }

  async function onUnpublish() {
    setBusy("unpublish");
    setNotice(null);
    if (!page) return;
    const res = await setPageStatusAction({
      data: { blogId: blog.id, pageId: page.id, status: "draft" },
    });
    setBusy(null);
    if (!res.ok || !res.data) {
      setNotice({ kind: "err", text: res.error ?? "Unpublish failed — nothing was written." });
      return;
    }
    setStatus(res.data.page.status);
    setPublishedAt(res.data.page.published_at);
    setUpdatedAt(res.data.page.updated_at);
    setRevisionList(res.data.revisions);
    setNotice({ kind: "ok", text: "Moved back to draft — published_at cleared in the database." });
  }

  async function onSchedule() {
    if (!scheduledAt) {
      setNotice({ kind: "err", text: "Pick a date and time first." });
      return;
    }
    setBusy("schedule");
    setNotice(null);
    // datetime-local has no zone; it is read as UTC so the stored value is stable.
    const iso = new Date(`${scheduledAt}:00Z`).toISOString();
    const saved = await persist("scheduled", iso);
    setBusy(null);
    if (saved) {
      setNotice({
        kind: "ok",
        text: `Scheduled for ${fmt(saved.page.scheduled_at)} (stored as scheduled_at). The engine that acts on it ships in Phase 5.`,
      });
    }
  }

  async function onTrash() {
    setBusy("trash");
    setNotice(null);
    const saved = await persist("trashed");
    setBusy(null);
    if (saved) setNotice({ kind: "ok", text: "Moved to trash — restore it any time." });
  }

  async function onRestore() {
    setBusy("restore");
    setNotice(null);
    const saved = await persist("draft");
    setBusy(null);
    if (saved) setNotice({ kind: "ok", text: "Restored to draft." });
  }

  function loadRevision(rev: PageRevisionRow) {
    const loaded = parseBlocks(rev.content);
    setTitle(rev.title);
    setBlocks(loaded.blocks);
    setExcerpt(loaded.meta.excerpt ?? "");
    setLoadedRevision(rev.revision_number);
    setDirty(true);
    setNotice({
      kind: "info",
      text: `Revision #${rev.revision_number} loaded into the editor (memory only — the database still holds revision #${currentRevision ?? 1}). Choose “Save draft” to store it as a new revision.`,
    });
  }

  return (
    <main className="min-h-dvh bg-neutral-50">
      <header className="sticky top-0 z-20 border-b border-neutral-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={() =>
                navigate({ to: "/blogs/$blogId/pages", params: { blogId: String(blog.id) } })
              }
              className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
            >
              ← Pages
            </button>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-neutral-900">{blog.name}</p>
              <p className="truncate font-mono text-[11px] text-neutral-500">
                /{blog.slug}
                {page ? `/${slug || page.slug}` : " (new page)"}
              </p>
            </div>
            {page && (
              <span
                className={
                  "rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset " +
                  (STATUS_BADGE[status] ?? "bg-neutral-100 text-neutral-600 ring-neutral-400/30")
                }
              >
                {status}
              </span>
            )}
            {dirty && (
              <span className="rounded-full bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-700 ring-1 ring-inset ring-orange-500/20">
                unsaved changes
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowPreview((v) => !v)}
              className={
                "rounded-md px-3 py-1.5 text-sm font-medium " +
                (showPreview
                  ? "bg-neutral-900 text-white"
                  : "border border-neutral-300 text-neutral-700 hover:bg-neutral-50")
              }
            >
              {showPreview ? "Editing" : "Preview"}
            </button>
            {isNewPage ? (
              <button
                onClick={createDraft}
                disabled={busy !== null}
                className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
              >
                {busy === "create" ? "Creating…" : "Create page draft"}
              </button>
            ) : (
              <>
                <button
                  onClick={onSaveDraft}
                  disabled={busy !== null}
                  className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-60"
                >
                  {busy === "save" ? "Saving…" : "Save draft"}
                </button>
                {status === "published" ? (
                  <button
                    onClick={onUnpublish}
                    disabled={busy !== null}
                    className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-60"
                  >
                    {busy === "unpublish" ? "Working…" : "Unpublish"}
                  </button>
                ) : (
                  <button
                    onClick={onPublish}
                    disabled={busy !== null}
                    className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
                  >
                    {busy === "publish" ? "Publishing…" : "Publish"}
                  </button>
                )}
                {status === "trashed" ? (
                  <button
                    onClick={onRestore}
                    disabled={busy !== null}
                    className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-60"
                  >
                    {busy === "restore" ? "Working…" : "Restore"}
                  </button>
                ) : (
                  <button
                    onClick={onTrash}
                    disabled={busy !== null}
                    className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
                  >
                    {busy === "trash" ? "Working…" : "Trash"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        {notice && (
          <div
            className={
              "border-t px-5 py-2 text-sm " +
              (notice.kind === "ok"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : notice.kind === "err"
                  ? "border-red-200 bg-red-50 text-red-800"
                  : "border-sky-200 bg-sky-50 text-sky-800")
            }
          >
            <div className="mx-auto flex max-w-7xl items-start justify-between gap-4">
              <span>{notice.text}</span>
              <button onClick={() => setNotice(null)} className="shrink-0 text-xs underline">
                dismiss
              </button>
            </div>
          </div>
        )}
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-5 py-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* ---- Main column ------------------------------------------------ */}
        <div className="space-y-4">
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              touch();
            }}
            placeholder="Page title"
            className="w-full rounded-lg border border-neutral-200 bg-white px-4 py-3 text-2xl font-bold tracking-tight text-neutral-900 placeholder:font-normal placeholder:text-neutral-400 focus:border-emerald-500 focus:outline-none"
          />

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-500">
            <span>
              {page
                ? `Page #${page.id} · revision #${currentRevision ?? 1} · updated ${fmt(updatedAt)}`
                : "Not created yet — “Create page draft” writes the row."}
            </span>
            <span>
              slug:{" "}
              <span className="font-mono text-neutral-700">
                /{blog.slug}/{slug || "(auto from title)"}
              </span>
            </span>
          </div>

          {showPreview ? (
            <section className="rounded-lg border border-neutral-200 bg-white px-6 py-6">
              <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-neutral-400">
                Preview — rendered by the same component the public page will use
              </p>
              <h1 className="mb-4 text-3xl font-bold tracking-tight text-neutral-900">
                {title || "Untitled page"}
              </h1>
              <RenderBlocks blocks={blocks} mode="preview" />
            </section>
          ) : (
            <section className="space-y-3">
              {blocks.length === 0 && (
                <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center">
                  <p className="text-sm font-medium text-neutral-700">No blocks yet</p>
                  <p className="mt-1 text-sm text-neutral-500">
                    Add your first block from the palette on the right — hero, text, columns, CTA
                    or spacer.
                  </p>
                </div>
              )}
              {blocks.map((block, index) => (
                <BlockCard
                  key={block.id}
                  block={block}
                  index={index}
                  total={blocks.length}
                  active={activeIndex === index}
                  onActivate={() => setActiveIndex(index)}
                  onChange={(updater) => updateBlock(index, updater)}
                  onMove={(dir) => moveBlock(index, dir)}
                  onMoveTo={(target) => moveTo(index, target)}
                  onDelete={() => removeBlock(index)}
                />
              ))}
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-neutral-300 bg-white px-3 py-2">
                <span className="text-xs font-medium text-neutral-500">Add block:</span>
                {BLOCK_BUTTONS.map((b) => (
                  <button
                    key={b.type}
                    title={b.hint}
                    onClick={() => addBlock(b.type)}
                    className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:border-emerald-400 hover:bg-emerald-50"
                  >
                    {BLOCK_LABELS[b.type]}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* ---- Sidebar ---------------------------------------------------- */}
        <aside className="space-y-4">
          <div className="rounded-lg border border-neutral-200 bg-white">
            <div className="flex border-b border-neutral-200 text-sm">
              <button
                onClick={() => setSidebarTab("publishing")}
                className={
                  "flex-1 px-3 py-2 font-medium " +
                  (sidebarTab === "publishing"
                    ? "border-b-2 border-neutral-900 text-neutral-900"
                    : "text-neutral-500 hover:text-neutral-800")
                }
              >
                Publishing
              </button>
              <button
                onClick={() => setSidebarTab("revisions")}
                className={
                  "flex-1 px-3 py-2 font-medium " +
                  (sidebarTab === "revisions"
                    ? "border-b-2 border-neutral-900 text-neutral-900"
                    : "text-neutral-500 hover:text-neutral-800")
                }
              >
                Revisions ({revisionList.length})
              </button>
            </div>

            {sidebarTab === "publishing" ? (
              <div className="space-y-4 p-4">
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Add block
                  </label>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {BLOCK_BUTTONS.map((b) => (
                      <button
                        key={b.type}
                        title={b.hint}
                        onClick={() => addBlock(b.type)}
                        className="rounded-md border border-neutral-300 px-2 py-1.5 text-xs font-medium text-neutral-700 hover:border-emerald-400 hover:bg-emerald-50"
                      >
                        + {BLOCK_LABELS[b.type]}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] leading-4 text-neutral-500">
                    Inserts after the selected block, otherwise at the end.
                  </p>
                </div>

                <div>
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                      Excerpt
                    </label>
                    <button
                      onClick={() => {
                        const s = suggestExcerpt(blocks);
                        setExcerpt(s);
                        setDirty(true);
                      }}
                      className="text-[11px] text-emerald-700 underline"
                    >
                      from content
                    </button>
                  </div>
                  <textarea
                    value={excerpt}
                    onChange={(e) => {
                      setExcerpt(e.target.value);
                      setDirty(true);
                    }}
                    rows={3}
                    placeholder="Shown in listings and social previews"
                    className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm focus:border-emerald-500 focus:outline-none"
                  />
                  <p className="mt-1 text-[11px] text-neutral-500">
                    Stored in the page content envelope (<code>excerpt</code>) — the{" "}
                    <code>pages</code> table has no excerpt column.
                  </p>
                </div>

                <div>
                  <label className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Slug
                  </label>
                  <input
                    value={slug}
                    onChange={(e) => {
                      setSlug(e.target.value);
                      setDirty(true);
                    }}
                    placeholder="auto-from-title"
                    className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1.5 font-mono text-xs focus:border-emerald-500 focus:outline-none"
                  />
                  <p className="mt-1 text-[11px] text-neutral-500">
                    Uniqueness is enforced per blog in the database (UNIQUE(blog_id, slug)).
                  </p>
                </div>

                <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
                  <label className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Schedule
                  </label>
                  <input
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
                    className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-xs focus:border-emerald-500 focus:outline-none"
                  />
                  <p className="mt-1 text-[11px] text-neutral-500">Read as UTC.</p>
                  <button
                    onClick={onSchedule}
                    disabled={isNewPage || busy !== null}
                    className="mt-2 w-full rounded-md bg-sky-600 px-2 py-1.5 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
                  >
                    {busy === "schedule" ? "Scheduling…" : "Save & schedule"}
                  </button>
                  {status === "scheduled" && storedScheduledAt && (
                    <p className="mt-2 text-[11px] text-sky-700">Stored: {fmt(storedScheduledAt)}</p>
                  )}
                </div>

                <dl className="space-y-1 border-t border-neutral-200 pt-3 text-xs text-neutral-600">
                  <Row label="Status" value={status} />
                  <Row label="Published" value={fmt(publishedAt)} />
                  <Row label="Updated" value={fmt(updatedAt)} />
                  <Row label="Blocks" value={String(blocks.length)} />
                  <Row label="Your role" value={role} />
                </dl>
              </div>
            ) : (
              <div className="max-h-[65vh] space-y-2 overflow-y-auto p-3">
                {revisionList.length === 0 ? (
                  <p className="p-2 text-sm text-neutral-500">This page has no revisions yet.</p>
                ) : (
                  revisionList.map((rev) => (
                    <button
                      key={rev.id}
                      onClick={() => loadRevision(rev)}
                      className={
                        "w-full rounded-md border px-2.5 py-2 text-left text-xs " +
                        (loadedRevision === rev.revision_number
                          ? "border-sky-400 bg-sky-50"
                          : "border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50")
                      }
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-neutral-900">
                          Revision #{rev.revision_number}
                        </span>
                        {rev.revision_number === currentRevision && (
                          <span className="rounded-full bg-neutral-900 px-1.5 py-0.5 text-[10px] font-medium text-white">
                            current
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-neutral-600">{rev.title || "(untitled)"}</p>
                      <p className="mt-0.5 text-[11px] text-neutral-400">
                        {fmt(rev.created_at)} · by {rev.author_name ?? "unknown"}
                      </p>
                    </button>
                  ))
                )}
                <p className="px-1 pt-1 text-[11px] leading-4 text-neutral-500">
                  Loading a revision only fills the editor. Nothing is written until you save, and
                  that save appends a new revision.
                </p>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-neutral-200 bg-white p-4 text-xs text-neutral-500">
            <p className="font-semibold text-neutral-700">Block storage</p>
            <p className="mt-1">
              Blocks are stored as JSON in{" "}
              <code className="rounded bg-neutral-100 px-1">pages.content</code> — the same schema
              posts use, so one renderer serves both. Inline markup:{" "}
              <code className="rounded bg-neutral-100 px-1">**bold**</code>{" "}
              <code className="rounded bg-neutral-100 px-1">*italic*</code>{" "}
              <code className="rounded bg-neutral-100 px-1">[label](url)</code>
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-neutral-400">{label}</dt>
      <dd className="truncate font-medium capitalize text-neutral-700">{value}</dd>
    </div>
  );
}

interface BlockCardProps {
  block: Block;
  index: number;
  total: number;
  active: boolean;
  onActivate: () => void;
  onChange: (updater: (b: Block) => Block) => void;
  onMove: (dir: -1 | 1) => void;
  onMoveTo: (target: number) => void;
  onDelete: () => void;
}

function BlockCard({
  block,
  index,
  total,
  active,
  onActivate,
  onChange,
  onMove,
  onMoveTo,
  onDelete,
}: BlockCardProps) {
  const inputCls =
    "w-full rounded-md border border-neutral-200 px-2 py-1.5 focus:border-emerald-500 focus:outline-none";
  return (
    <article
      onFocus={onActivate}
      onMouseDown={onActivate}
      className={
        "rounded-lg border bg-white px-4 py-3 transition-shadow " +
        (active ? "border-emerald-400 shadow-sm" : "border-neutral-200 hover:border-neutral-300")
      }
    >
      <header className="mb-2 flex items-center justify-between gap-2">
        <span className="rounded bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-600">
          {index + 1} · {BLOCK_LABELS[block.type as PageBlockType] ?? block.type}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onMove(-1)}
            disabled={index === 0}
            title="Move up"
            className="rounded border border-neutral-200 px-1.5 py-0.5 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-30"
          >
            ↑
          </button>
          <button
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            title="Move down"
            className="rounded border border-neutral-200 px-1.5 py-0.5 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-30"
          >
            ↓
          </button>
          <select
            title="Move to position"
            value={index}
            onChange={(e) => onMoveTo(Number(e.target.value))}
            className="rounded border border-neutral-200 px-1 py-0.5 text-[11px] text-neutral-600"
          >
            {Array.from({ length: total }, (_, i) => (
              <option key={i} value={i}>
                #{i + 1}
              </option>
            ))}
          </select>
          <button
            onClick={onDelete}
            title="Delete block"
            className="rounded border border-red-200 px-1.5 py-0.5 text-xs text-red-600 hover:bg-red-50"
          >
            ✕
          </button>
        </div>
      </header>

      {block.type === "hero" && (
        <div className="space-y-1.5">
          <input
            value={block.data.headline}
            onChange={(e) =>
              onChange((b) =>
                b.type === "hero" ? { ...b, data: { ...b.data, headline: e.target.value } } : b
              )
            }
            placeholder="Hero headline"
            className={inputCls + " text-xl font-bold"}
          />
          <textarea
            value={block.data.subtext}
            onChange={(e) =>
              onChange((b) =>
                b.type === "hero" ? { ...b, data: { ...b.data, subtext: e.target.value } } : b
              )
            }
            rows={2}
            placeholder="Supporting subtext"
            className={inputCls + " text-sm"}
          />
          <div className="flex items-center gap-2 text-xs text-neutral-600">
            <label className="flex items-center gap-1">
              background
              <input
                type="color"
                value={/^#[0-9a-f]{6}$/i.test(block.data.bg) ? block.data.bg : "#f5f5f5"}
                onChange={(e) =>
                  onChange((b) =>
                    b.type === "hero" ? { ...b, data: { ...b.data, bg: e.target.value } } : b
                  )
                }
                className="h-6 w-10 rounded border border-neutral-300"
              />
            </label>
            <span className="font-mono text-[11px] text-neutral-500">{block.data.bg}</span>
          </div>
        </div>
      )}

      {block.type === "two-column" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <textarea
            value={block.data.left}
            onChange={(e) =>
              onChange((b) =>
                b.type === "two-column" ? { ...b, data: { ...b.data, left: e.target.value } } : b
              )
            }
            rows={4}
            placeholder="Left column"
            className={inputCls + " text-sm"}
          />
          <textarea
            value={block.data.right}
            onChange={(e) =>
              onChange((b) =>
                b.type === "two-column" ? { ...b, data: { ...b.data, right: e.target.value } } : b
              )
            }
            rows={4}
            placeholder="Right column"
            className={inputCls + " text-sm"}
          />
        </div>
      )}

      {block.type === "cta" && (
        <div className="space-y-1.5">
          <input
            value={block.data.title}
            onChange={(e) =>
              onChange((b) => (b.type === "cta" ? { ...b, data: { ...b.data, title: e.target.value } } : b))
            }
            placeholder="CTA title"
            className={inputCls + " text-lg font-semibold"}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              value={block.data.buttonLabel}
              onChange={(e) =>
                onChange((b) =>
                  b.type === "cta" ? { ...b, data: { ...b.data, buttonLabel: e.target.value } } : b
                )
              }
              placeholder="Button label"
              className={inputCls + " text-sm"}
            />
            <input
              value={block.data.url}
              onChange={(e) =>
                onChange((b) => (b.type === "cta" ? { ...b, data: { ...b.data, url: e.target.value } } : b))
              }
              placeholder="https://example.com/signup"
              className={inputCls + " font-mono text-xs"}
            />
          </div>
          {block.data.url.trim() !== "" && !/^https?:\/\//i.test(block.data.url.trim()) && (
            <p className="text-[11px] text-red-700">
              The button URL must start with http:// or https:// — until it does, no button is
              rendered (nothing is invented).
            </p>
          )}
        </div>
      )}

      {block.type === "spacer" && (
        <div className="flex items-center gap-3 text-xs text-neutral-600">
          <input
            type="range"
            min={16}
            max={240}
            step={8}
            value={block.data.height}
            onChange={(e) =>
              onChange((b) =>
                b.type === "spacer" ? { ...b, data: { ...b.data, height: Number(e.target.value) } } : b
              )
            }
            className="flex-1"
          />
          <span className="w-16 text-right font-mono">{block.data.height}px</span>
        </div>
      )}

      {block.type === "paragraph" && (
        <textarea
          value={block.data.text}
          onChange={(e) =>
            onChange((b) => (b.type === "paragraph" ? { ...b, data: { text: e.target.value } } : b))
          }
          rows={3}
          placeholder="Write a paragraph. Use **bold**, *italic*, [label](https://url)."
          className={inputCls + " resize-y text-[15px] leading-7"}
        />
      )}

      {block.type === "heading" && (
        <div className="flex gap-2">
          <select
            value={block.data.level}
            onChange={(e) =>
              onChange((b) =>
                b.type === "heading"
                  ? { ...b, data: { ...b.data, level: Number(e.target.value) === 3 ? 3 : 2 } }
                  : b
              )
            }
            className="rounded-md border border-neutral-300 px-2 py-1.5 text-xs"
          >
            <option value={2}>H2</option>
            <option value={3}>H3</option>
          </select>
          <input
            value={block.data.text}
            onChange={(e) =>
              onChange((b) =>
                b.type === "heading" ? { ...b, data: { ...b.data, text: e.target.value } } : b
              )
            }
            placeholder="Section heading"
            className={inputCls + " flex-1 text-lg font-semibold"}
          />
        </div>
      )}

      {block.type === "list" && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs text-neutral-600">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={!block.data.ordered}
                onChange={() =>
                  onChange((b) => (b.type === "list" ? { ...b, data: { ...b.data, ordered: false } } : b))
                }
              />
              bulleted
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={block.data.ordered === true}
                onChange={() =>
                  onChange((b) => (b.type === "list" ? { ...b, data: { ...b.data, ordered: true } } : b))
                }
              />
              numbered
            </label>
          </div>
          {block.data.items.map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-4 text-right text-xs text-neutral-400">{i + 1}.</span>
              <input
                value={item}
                onChange={(e) =>
                  onChange((b) => {
                    if (b.type !== "list") return b;
                    const items = [...b.data.items];
                    items[i] = e.target.value;
                    return { ...b, data: { ...b.data, items } };
                  })
                }
                placeholder="List item"
                className={inputCls + " flex-1 text-sm"}
              />
              <button
                onClick={() =>
                  onChange((b) => {
                    if (b.type !== "list") return b;
                    const items = b.data.items.filter((_, j) => j !== i);
                    return { ...b, data: { ...b.data, items: items.length ? items : [""] } };
                  })
                }
                className="rounded border border-neutral-200 px-1.5 text-xs text-neutral-500 hover:bg-neutral-100"
                title="Remove item"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            onClick={() =>
              onChange((b) =>
                b.type === "list" ? { ...b, data: { ...b.data, items: [...b.data.items, ""] } } : b
              )
            }
            className="rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-700 hover:bg-neutral-50"
          >
            + item
          </button>
        </div>
      )}

      {block.type === "quote" && (
        <div className="space-y-1.5">
          <textarea
            value={block.data.text}
            onChange={(e) =>
              onChange((b) => (b.type === "quote" ? { ...b, data: { ...b.data, text: e.target.value } } : b))
            }
            rows={2}
            placeholder="Quoted text"
            className={inputCls + " text-[15px] italic"}
          />
          <input
            value={block.data.cite ?? ""}
            onChange={(e) =>
              onChange((b) => (b.type === "quote" ? { ...b, data: { ...b.data, cite: e.target.value } } : b))
            }
            placeholder="Attribution (optional)"
            className={inputCls + " text-xs"}
          />
        </div>
      )}

      {block.type === "image" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <input
              value={block.data.url}
              onChange={(e) =>
                onChange((b) => (b.type === "image" ? { ...b, data: { ...b.data, url: e.target.value } } : b))
              }
              placeholder="https://example.com/image.jpg"
              className={inputCls + " font-mono text-xs"}
            />
          </div>
          <input
            value={block.data.alt}
            onChange={(e) =>
              onChange((b) => (b.type === "image" ? { ...b, data: { ...b.data, alt: e.target.value } } : b))
            }
            placeholder="Alt text (required for accessibility)"
            className={inputCls + " text-xs"}
          />
          <input
            value={block.data.caption ?? ""}
            onChange={(e) =>
              onChange((b) => (b.type === "image" ? { ...b, data: { ...b.data, caption: e.target.value } } : b))
            }
            placeholder="Caption (optional)"
            className={inputCls + " text-xs"}
          />
          {block.data.url.trim() === "" && (
            <p className="sm:col-span-2 text-[11px] text-amber-700">
              No image URL yet — the preview and public page show this block as missing rather than
              inventing an image.
            </p>
          )}
        </div>
      )}
    </article>
  );
}

export default PageBuilder;
