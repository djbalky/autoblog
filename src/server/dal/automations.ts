/**
 * Autonoblog — DAL: per-blog automation configuration (Phase 6a).
 *
 * ONE row per blog in `blog_automations`, created on the first save. Until a
 * blog has been saved, `getAutomationConfig()` returns the documented defaults
 * with `persisted: false`, so the screen can say "these are defaults, nothing
 * has been saved yet" instead of pretending a row exists.
 *
 * Nothing here runs an agent or creates content. The scheduler reads this table
 * (see tickAutomation in src/server/scheduler.ts) and only enqueues when the
 * blog is enabled AND a text-model provider is configured.
 */
import { all, get, run, nowIso } from "../store";

export const APPROVAL_MODES = ["manual", "automatic"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Every social network the distribution phase (7) can connect. */
export const SOCIAL_NETWORKS = [
  "x",
  "facebook",
  "instagram",
  "linkedin",
  "pinterest",
  "telegram",
  "tiktok",
] as const;

export interface AutomationConfig {
  enabled: boolean;
  postsPerDay: number;
  /** "HH:MM" local-to-UTC times of day the automation should publish. */
  publishTimes: string[];
  topics: string[];
  language: string;
  tone: string;
  targetAudience: string;
  minWordCount: number;
  seoRequireMeta: boolean;
  seoRequireInternalLinks: boolean;
  seoKeywords: string;
  approvalMode: ApprovalMode;
  socialNetworks: string[];
}

export interface AutomationConfigRow extends AutomationConfig {
  blogId: number;
  /** True only when a real `blog_automations` row backs these values. */
  persisted: boolean;
  /** The instant the automation last enqueued a job, null when never. */
  lastEnqueuedAt: string | null;
  updatedAt: string | null;
}

export const DEFAULT_AUTOMATION: AutomationConfig = {
  enabled: false,
  postsPerDay: 2,
  publishTimes: ["09:00", "17:00"],
  topics: [],
  language: "en",
  tone: "informative",
  targetAudience: "",
  minWordCount: 1200,
  seoRequireMeta: true,
  seoRequireInternalLinks: true,
  seoKeywords: "",
  approvalMode: "manual",
  socialNetworks: [],
};

function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toStr(v: unknown): string {
  return v == null ? "" : String(v);
}

/** JSON-in-TEXT columns: never throw on a malformed value, fall back to []. */
function parseList(value: unknown): string[] {
  const raw = toStr(value).trim();
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item)).filter((item) => item.trim() !== "");
  } catch {
    return [];
  }
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTime(value: string): boolean {
  return HHMM.test(value.trim());
}

/** Minutes since midnight for a validated "HH:MM" (UTC, matching the storage). */
export function timeToMinutes(value: string): number {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
}

function normalizeTimes(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!isValidTime(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.sort();
}

function normalizeTopics(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim().replace(/\s+/g, " ");
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value.slice(0, 200));
  }
  return out;
}

function mapRow(row: Record<string, unknown>): AutomationConfigRow {
  const times = normalizeTimes(parseList(row.publish_times));
  return {
    blogId: toNum(row.blog_id),
    enabled: toNum(row.enabled) === 1,
    postsPerDay: toNum(row.posts_per_day) || DEFAULT_AUTOMATION.postsPerDay,
    publishTimes: times.length > 0 ? times : [...DEFAULT_AUTOMATION.publishTimes],
    topics: normalizeTopics(parseList(row.topics)),
    language: toStr(row.language) || DEFAULT_AUTOMATION.language,
    tone: toStr(row.tone),
    targetAudience: toStr(row.target_audience),
    minWordCount: toNum(row.min_word_count),
    seoRequireMeta: toNum(row.seo_require_meta) === 1,
    seoRequireInternalLinks: toNum(row.seo_require_internal_links) === 1,
    seoKeywords: toStr(row.seo_keywords),
    approvalMode: (toStr(row.approval_mode) === "automatic"
      ? "automatic"
      : "manual") as ApprovalMode,
    socialNetworks: parseList(row.social_networks).filter((n) =>
      (SOCIAL_NETWORKS as readonly string[]).includes(n)
    ),
    persisted: true,
    lastEnqueuedAt: row.last_enqueued_at ? toStr(row.last_enqueued_at) : null,
    updatedAt: row.updated_at ? toStr(row.updated_at) : null,
  };
}

/** The saved config for a blog, or the defaults with `persisted: false`. */
export async function getAutomationConfig(
  blogId: number
): Promise<AutomationConfigRow> {
  const row = await get<Record<string, unknown>>(
    "SELECT * FROM blog_automations WHERE blog_id = ?",
    blogId
  );
  if (row) return mapRow(row);
  return {
    ...DEFAULT_AUTOMATION,
    publishTimes: [...DEFAULT_AUTOMATION.publishTimes],
    topics: [],
    socialNetworks: [],
    blogId,
    persisted: false,
    lastEnqueuedAt: null,
    updatedAt: null,
  };
}

export interface AutomationInput {
  enabled: boolean;
  postsPerDay: number;
  publishTimes: string[];
  topics: string[];
  language: string;
  tone: string;
  targetAudience: string;
  minWordCount: number;
  seoRequireMeta: boolean;
  seoRequireInternalLinks: boolean;
  seoKeywords: string;
  approvalMode: ApprovalMode;
  socialNetworks: string[];
}

/**
 * Validate + normalize what the settings screen submitted. Returns an error
 * string instead of writing something the pipeline could not act on.
 */
export function validateAutomationInput(
  raw: Partial<AutomationInput>
): { ok: true; value: AutomationInput } | { ok: false; error: string } {
  const postsPerDay = Math.round(Number(raw.postsPerDay ?? DEFAULT_AUTOMATION.postsPerDay));
  if (!Number.isFinite(postsPerDay) || postsPerDay < 1 || postsPerDay > 24) {
    return { ok: false, error: "Posts per day must be a whole number between 1 and 24." };
  }
  const times = normalizeTimes(Array.isArray(raw.publishTimes) ? raw.publishTimes : []);
  if (times.length === 0) {
    return { ok: false, error: "Add at least one publishing time in HH:MM (24-hour) form." };
  }
  if (times.length !== (raw.publishTimes ?? []).filter((t) => t.trim() !== "").length) {
    return {
      ok: false,
      error: "Every publishing time must be a valid HH:MM 24-hour time and unique.",
    };
  }
  if (times.length > postsPerDay) {
    return {
      ok: false,
      error: `You listed ${String(times.length)} publishing times but only ${String(
        postsPerDay
      )} post(s) per day — lower the times or raise posts per day.`,
    };
  }
  const minWordCount = Math.round(Number(raw.minWordCount ?? DEFAULT_AUTOMATION.minWordCount));
  if (!Number.isFinite(minWordCount) || minWordCount < 100 || minWordCount > 20000) {
    return { ok: false, error: "Minimum word count must be between 100 and 20000." };
  }
  const approvalMode: ApprovalMode =
    raw.approvalMode === "automatic" ? "automatic" : "manual";
  const social = (Array.isArray(raw.socialNetworks) ? raw.socialNetworks : []).filter((n) =>
    (SOCIAL_NETWORKS as readonly string[]).includes(n)
  );
  return {
    ok: true,
    value: {
      enabled: Boolean(raw.enabled),
      postsPerDay,
      publishTimes: times,
      topics: normalizeTopics(Array.isArray(raw.topics) ? raw.topics : []),
      language: (raw.language ?? DEFAULT_AUTOMATION.language).trim().slice(0, 20) || "en",
      tone: (raw.tone ?? "").trim().slice(0, 80),
      targetAudience: (raw.targetAudience ?? "").trim().slice(0, 200),
      minWordCount,
      seoRequireMeta: Boolean(raw.seoRequireMeta),
      seoRequireInternalLinks: Boolean(raw.seoRequireInternalLinks),
      seoKeywords: (raw.seoKeywords ?? "").trim().slice(0, 400),
      approvalMode,
      socialNetworks: social,
    },
  };
}

/** Upsert the blog's single config row and return what the database now holds. */
export async function saveAutomationConfig(
  blogId: number,
  input: AutomationInput
): Promise<AutomationConfigRow> {
  const now = nowIso();
  const existing = await get<{ id: unknown }>(
    "SELECT id FROM blog_automations WHERE blog_id = ?",
    blogId
  );
  const values = [
    input.enabled ? 1 : 0,
    input.postsPerDay,
    JSON.stringify(input.publishTimes),
    JSON.stringify(input.topics),
    input.language,
    input.tone,
    input.targetAudience,
    input.minWordCount,
    input.seoRequireMeta ? 1 : 0,
    input.seoRequireInternalLinks ? 1 : 0,
    input.seoKeywords,
    input.approvalMode,
    JSON.stringify(input.socialNetworks),
    now,
  ];
  if (existing) {
    await run(
      `UPDATE blog_automations
          SET enabled = ?, posts_per_day = ?, publish_times = ?, topics = ?,
              language = ?, tone = ?, target_audience = ?, min_word_count = ?,
              seo_require_meta = ?, seo_require_internal_links = ?, seo_keywords = ?,
              approval_mode = ?, social_networks = ?, updated_at = ?
        WHERE blog_id = ?`,
      ...values,
      blogId
    );
  } else {
    await run(
      `INSERT INTO blog_automations
         (enabled, posts_per_day, publish_times, topics, language, tone,
          target_audience, min_word_count, seo_require_meta,
          seo_require_internal_links, seo_keywords, approval_mode,
          social_networks, updated_at, blog_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...values,
      blogId,
      now
    );
  }
  return getAutomationConfig(blogId);
}

/** Record the instant the automation last enqueued a job for this blog. */
export async function markAutomationEnqueued(
  blogId: number,
  at: string = nowIso()
): Promise<void> {
  await run(
    "UPDATE blog_automations SET last_enqueued_at = ?, updated_at = ? WHERE blog_id = ?",
    at,
    at,
    blogId
  );
}

/** Enabled configs of blogs that are actually live (the worker's work list). */
export async function listEnabledAutomations(): Promise<AutomationConfigRow[]> {
  const rows = await all<Record<string, unknown>>(
    `SELECT a.*
       FROM blog_automations a
       JOIN blogs b ON b.id = a.blog_id
      WHERE a.enabled = 1 AND b.status = 'active'
      ORDER BY a.blog_id ASC`
  );
  return rows.map(mapRow);
}
