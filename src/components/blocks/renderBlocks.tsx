/**
 * Autonoblog — block renderer.
 *
 * ONE renderer for editor preview (now) and the public article page (Phase 5).
 * It renders the stored blocks to semantic HTML with prose-style typography, so
 * what the author previews is what the published page renders.
 *
 * Inline markup inside text (paragraph / heading / quote / list items):
 *   **bold**   *italic*   `code`   [label](https://url)
 * Links only accept http(s) or root-relative hrefs — anything else renders as
 * plain text, never as a live link.
 */
import type { ReactNode } from "react";
import type { Block } from "./types";

const SAFE_HREF = /^(https?:\/\/|\/|#|mailto:)/i;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Tokenise on **bold**, *italic*, `code`, [label](url) in one pass.
  const re =
    /(\*\*[^*]+\*\*)|(\*[^*]+\*)|(`[^`]+`)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith("**")) {
      out.push(
        <strong key={key} className="font-semibold">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("`")) {
      out.push(
        <code
          key={key}
          className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[0.9em] text-neutral-800"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const label = mm?.[1] ?? "";
      const href = mm?.[2] ?? "";
      out.push(
        SAFE_HREF.test(href) ? (
          <a
            key={key}
            href={href}
            className="font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:decoration-emerald-600"
            rel="noopener noreferrer"
            {...(href.startsWith("http") ? { target: "_blank" } : {})}
          >
            {label}
          </a>
        ) : (
          <span key={key}>{label}</span>
        )
      );
    } else {
      out.push(
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Multi-line paragraph text -> preserves intentional line breaks. */
function withBreaks(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/\n+/).flatMap((line, idx) => {
    const nodes = renderInline(line, `${keyPrefix}-l${idx}`);
    if (idx === 0) return nodes;
    return [<br key={`${keyPrefix}-br${idx}`} />, ...nodes];
  });
}

export interface RenderBlocksProps {
  blocks: Block[];
  /**
   * "preview" (default) shows honest placeholders for incomplete blocks, e.g. an
   * image block with no URL yet. "public" omits anything that cannot be shown.
   */
  mode?: "preview" | "public";
  className?: string;
}

export function RenderBlocks({ blocks, mode = "preview", className }: RenderBlocksProps) {
  if (blocks.length === 0) {
    return (
      <p className="text-sm italic text-neutral-400">
        {mode === "preview"
          ? "This post has no blocks yet — add one in the editor and it will render here."
          : ""}
      </p>
    );
  }
  return (
    <div className={className ?? "space-y-4 text-[15px] leading-7 text-neutral-800"}>
      {blocks.map((block, index) => (
        <BlockView key={block.id ?? index} block={block} mode={mode} index={index} />
      ))}
    </div>
  );
}

function BlockView({
  block,
  mode,
  index,
}: {
  block: Block;
  mode: "preview" | "public";
  index: number;
}) {
  const k = `b${index}`;
  switch (block.type) {
    case "heading": {
      const text = block.data.text.trim();
      if (!text) return mode === "preview" ? <EmptyHeading /> : null;
      return block.data.level === 3 ? (
        <h3 className="mt-2 text-lg font-semibold tracking-tight text-neutral-900">
          {renderInline(text, k)}
        </h3>
      ) : (
        <h2 className="mt-2 text-2xl font-bold tracking-tight text-neutral-900">
          {renderInline(text, k)}
        </h2>
      );
    }
    case "list": {
      const items = block.data.items.filter((it) => it.trim() !== "");
      if (items.length === 0) {
        return mode === "preview" ? (
          <p className="text-sm italic text-neutral-400">Empty list block</p>
        ) : null;
      }
      const ListTag = block.data.ordered ? "ol" : "ul";
      return (
        <ListTag
          className={
            block.data.ordered
              ? "ml-6 list-decimal space-y-1"
              : "ml-6 list-disc space-y-1"
          }
        >
          {items.map((item, i) => (
            <li key={`${k}-i${i}`} className="pl-1">
              {renderInline(item, `${k}-i${i}`)}
            </li>
          ))}
        </ListTag>
      );
    }
    case "quote": {
      const text = block.data.text.trim();
      if (!text) {
        return mode === "preview" ? (
          <p className="text-sm italic text-neutral-400">Empty quote block</p>
        ) : null;
      }
      return (
        <blockquote className="border-l-4 border-emerald-300 bg-emerald-50/40 py-2 pl-4 text-[15px] italic text-neutral-700">
          {withBreaks(text, k)}
          {block.data.cite ? (
            <footer className="mt-1 text-sm not-italic text-neutral-500">
              — {block.data.cite}
            </footer>
          ) : null}
        </blockquote>
      );
    }
    case "image": {
      const url = block.data.url.trim();
      if (!SAFE_HREF.test(url) || url === "/" || url === "#") {
        if (mode === "public") return null;
        return (
          <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
            <p className="font-medium">Image block — no image URL set</p>
            <p className="mt-1 text-xs">
              Pick an image from this blog&apos;s media library, or paste an external URL, in the
              editor. Until then nothing is rendered.
            </p>
          </div>
        );
      }
      return (
        <figure className="space-y-2">
          <img
            src={url}
            alt={block.data.alt || ""}
            loading="lazy"
            className="w-full rounded-lg border border-neutral-200 object-cover"
          />
          {(block.data.caption || block.data.alt) && (
            <figcaption className="text-center text-xs text-neutral-500">
              {block.data.caption || block.data.alt}
            </figcaption>
          )}
        </figure>
      );
    }
    case "hero": {
      const headline = block.data.headline.trim();
      const subtext = block.data.subtext.trim();
      if (!headline && !subtext) {
        return mode === "preview" ? (
          <p className="text-sm italic text-neutral-400">Empty hero block</p>
        ) : null;
      }
      const bg = /^#[0-9a-f]{3,8}$/i.test(block.data.bg) ? block.data.bg : "#f5f5f5";
      return (
        <section
          className="rounded-xl border border-neutral-200 px-6 py-10 text-center"
          style={{ backgroundColor: bg }}
        >
          {headline ? (
            <h1 className="text-3xl font-bold tracking-tight text-neutral-900">
              {renderInline(headline, k)}
            </h1>
          ) : null}
          {subtext ? (
            <p className="mx-auto mt-3 max-w-2xl text-base text-neutral-700">
              {withBreaks(subtext, `${k}-sub`)}
            </p>
          ) : null}
        </section>
      );
    }
    case "two-column": {
      const left = block.data.left.trim();
      const right = block.data.right.trim();
      if (!left && !right) {
        return mode === "preview" ? (
          <p className="text-sm italic text-neutral-400">Empty two-column block</p>
        ) : null;
      }
      return (
        <div className="grid gap-6 sm:grid-cols-2">
          <div>{withBreaks(left, `${k}-l`)}</div>
          <div>{withBreaks(right, `${k}-r`)}</div>
        </div>
      );
    }
    case "cta": {
      const title = block.data.title.trim();
      const label = block.data.buttonLabel.trim();
      const url = block.data.url.trim();
      const linkable = SAFE_HREF.test(url) && url !== "/" && url !== "#";
      if (!title && !(linkable && label)) {
        return mode === "preview" ? (
          <p className="text-sm italic text-neutral-400">
            Empty CTA block{url && !linkable ? " — button URL must start with http(s)://" : ""}
          </p>
        ) : null;
      }
      return (
        <section className="rounded-xl border border-emerald-200 bg-emerald-50 px-6 py-8 text-center">
          {title ? (
            <h2 className="text-2xl font-bold tracking-tight text-emerald-900">
              {renderInline(title, k)}
            </h2>
          ) : null}
          {linkable && label ? (
            <a
              href={url}
              target={url.startsWith("http") ? "_blank" : undefined}
              rel="noopener noreferrer"
              className="mt-4 inline-block rounded-md bg-emerald-600 px-5 py-2.5 font-medium text-white hover:bg-emerald-700"
            >
              {label}
            </a>
          ) : mode === "preview" ? (
            <p className="mt-3 text-xs text-emerald-800">
              {label ? "Button URL missing" : "Button label missing"} — nothing is rendered until
              the CTA has both a label and a real http(s) URL.
            </p>
          ) : null}
        </section>
      );
    }
    case "spacer": {
      const height = Number(block.data.height);
      const px = Number.isFinite(height) && height > 0 ? Math.min(height, 400) : 48;
      return <div aria-hidden="true" style={{ height: `${px}px` }} />;
    }
    case "paragraph":
    default: {
      const text = block.data.text;
      if (!text.trim()) {
        return mode === "preview" ? (
          <p className="text-sm italic text-neutral-400">Empty paragraph</p>
        ) : null;
      }
      return <p>{withBreaks(text, k)}</p>;
    }
  }
}

function EmptyHeading() {
  return <p className="text-sm italic text-neutral-400">Empty heading</p>;
}

export default RenderBlocks;
