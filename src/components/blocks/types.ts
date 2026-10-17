/**
 * Autonoblog — the block schema shared by the editor, the preview renderer and
 * (Phase 5) the public site renderer.
 *
 * A post's `content` column stores JSON:
 *
 *   { "version": 1, "blocks": [ { "id": "b1", "type": "paragraph", "data": { "text": "…" } } ] }
 *
 * Blocks are ordered; `id` only exists to keep React keys stable while editing
 * (the DB does not care about it). Anything that is NOT this JSON — e.g. a row
 * written before the editor existed — is parsed as one paragraph of plain text,
 * so no saved content is ever silently thrown away.
 */

export type BlockType = "paragraph" | "heading" | "list" | "quote" | "image";

export interface ParagraphBlock {
  id: string;
  type: "paragraph";
  data: { text: string };
}
export interface HeadingBlock {
  id: string;
  type: "heading";
  data: { level: 2 | 3; text: string };
}
export interface ListBlock {
  id: string;
  type: "list";
  data: { items: string[]; ordered?: boolean };
}
export interface QuoteBlock {
  id: string;
  type: "quote";
  data: { text: string; cite?: string };
}
export interface ImageBlock {
  id: string;
  type: "image";
  data: { url: string; alt: string; caption?: string };
}

export type Block =
  | ParagraphBlock
  | HeadingBlock
  | ListBlock
  | QuoteBlock
  | ImageBlock;

export const BLOCK_VERSION = 1;

let seq = 0;
/** Client-side block identity for React keys / reordering. */
export function newBlockId(): string {
  seq += 1;
  return `b${Date.now().toString(36)}${seq.toString(36)}`;
}

export function createBlock(type: BlockType): Block {
  const id = newBlockId();
  switch (type) {
    case "heading":
      return { id, type, data: { level: 2, text: "" } };
    case "list":
      return { id, type, data: { items: [""] } };
    case "quote":
      return { id, type, data: { text: "", cite: "" } };
    case "image":
      return { id, type, data: { url: "", alt: "", caption: "" } };
    case "paragraph":
    default:
      return { id, type: "paragraph", data: { text: "" } };
  }
}

/** Normalise one unknown JSON object into a Block, or null if unusable. */
function coerceBlock(raw: unknown, index: number): Block | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = String(r.type ?? "");
  const data = (r.data ?? {}) as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id ? r.id : `legacy-${index}`;
  switch (type) {
    case "paragraph":
      return { id, type, data: { text: String(data.text ?? "") } };
    case "heading": {
      const level = Number(data.level) === 3 ? 3 : 2;
      return { id, type, data: { level, text: String(data.text ?? "") } };
    }
    case "list": {
      const items = Array.isArray(data.items)
        ? data.items.map((i) => String(i ?? ""))
        : [];
      return {
        id,
        type,
        data: { items: items.length ? items : [""], ordered: data.ordered === true },
      };
    }
    case "quote":
      return {
        id,
        type,
        data: { text: String(data.text ?? ""), cite: String(data.cite ?? "") },
      };
    case "image":
      return {
        id,
        type,
        data: {
          url: String(data.url ?? ""),
          alt: String(data.alt ?? ""),
          caption: String(data.caption ?? ""),
        },
      };
    default:
      return null;
  }
}

export interface ParsedContent {
  blocks: Block[];
  /** True when the stored text was not block JSON and is being shown as text. */
  legacyText: boolean;
}

/** Parse the `posts.content` column into blocks (never throws). */
export function parseBlocks(content: string | null | undefined): ParsedContent {
  const text = (content ?? "").trim();
  if (!text) return { blocks: [], legacyText: false };
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const rawBlocks = Array.isArray(parsed)
        ? parsed
        : ((parsed as { blocks?: unknown }).blocks as unknown[]) ?? [];
      if (Array.isArray(rawBlocks)) {
        const blocks = rawBlocks
          .map((b, i) => coerceBlock(b, i))
          .filter((b): b is Block => b !== null);
        if (blocks.length > 0 || rawBlocks.length === 0) {
          return { blocks, legacyText: false };
        }
      }
    } catch {
      // fall through — treated as plain text below
    }
  }
  return {
    blocks: [{ id: "legacy-0", type: "paragraph", data: { text } }],
    legacyText: true,
  };
}

/** Serialise blocks for storage in `posts.content`. */
export function serializeBlocks(blocks: Block[]): string {
  return JSON.stringify({
    version: BLOCK_VERSION,
    blocks: blocks.map((b) => ({ id: b.id, type: b.type, data: b.data })),
  });
}

/** Plain-text extraction, used for auto-excerpts and list previews. */
export function blocksToText(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "paragraph" || b.type === "quote" || b.type === "heading") {
      parts.push(b.data.text);
    } else if (b.type === "list") {
      parts.push(b.data.items.join(" "));
    } else if (b.type === "image") {
      if (b.data.alt) parts.push(b.data.alt);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Strip inline markup (**bold**, *italic*, [text](url), `code`) to plain text. */
export function stripInlineMarkup(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

/** A one-line excerpt suggestion from the first real text in the post. */
export function suggestExcerpt(blocks: Block[], max = 200): string {
  const text = stripInlineMarkup(blocksToText(blocks));
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
