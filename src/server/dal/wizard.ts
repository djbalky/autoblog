/**
 * Autonoblog — DAL: Blog Creation Wizard (Phase 2).
 *
 * The wizard collects 10 steps of configuration client-side, then submits a
 * single `WizardPayload` to the "Create Blog" RPC. This module turns that
 * payload into REAL database rows: the blog, its settings (including every
 * step's config captured in the `blog_settings.config` column), the owner
 * membership, taxonomy (categories/tags), seeded default pages, a primary
 * menu with items, monetization rows (when enabled) and an activity log.
 *
 * It never invents data: values only appear if the user supplied them.
 */
import { nowIso, run, get, all } from "../store";
import { slugify, type BlogRow } from "./blogs";
import { logActivity } from "./activity";
import {
  registerStagedMediaForBlog,
  type UploadRef,
  type MediaRow,
} from "./media";

// ---- Step types -----------------------------------------------------------
export interface WizardUploadRef extends UploadRef {
  alt?: string;
}

export interface WizardPayload {
  basic: {
    name: string;
    description: string;
    /** raw slug the user configured (already slugified+validated client-side) */
    slug: string;
    language: string;
    country: string;
    brand_name: string;
    logo?: WizardUploadRef | null;
    favicon?: WizardUploadRef | null;
  };
  niche: {
    main_niche: string;
    sub_niches: string[];
    main_topics: string[];
    topics_to_avoid: string[];
    target_audience: string;
    audience_interests: string[];
    user_intent: string;
    geo_targeting: string;
  };
  writing: {
    style: string;
    tone: string;
    formality: string;
    personality: string;
    vocab_level: string;
    perspective: string; // first | third
    register: string; // professional | casual
    format: string;
    brand_voice: string;
    custom_instructions: string;
  };
  article: {
    length: string; // short|medium|long|very_long|custom
    custom_word_count: number;
    detail_level: string;
    num_sections: number;
    num_headings: number;
    num_examples: number;
    faqs: boolean;
    tables: boolean;
    lists: boolean;
    pros_cons: boolean;
    statistics: boolean;
    sources: boolean;
    references: boolean;
    expert_quotes: boolean;
  };
  seo: {
    primary_keywords: string[];
    secondary_keywords: string[];
    search_intent: string;
    seo_title: string;
    meta_description: string;
    url_slug_style: string;
    h1h2h3_guidance: string;
    internal_linking: boolean;
    external_references: boolean;
    schema_faqs: boolean;
    schema_article: boolean;
    canonical: boolean;
    open_graph: boolean;
    social_metadata: boolean;
    image_alt_text_guidance: string;
  };
  frequency: {
    posts_per_day: number;
    posts_per_week: number;
    publishing_times: string[];
    timezone: string;
    auto_publish: boolean;
    require_approval: boolean;
  };
  media: {
    ai_images: boolean;
    uploads: boolean;
    external_sources: boolean;
    featured_image_default: string;
    inline_images: boolean;
    captions: boolean;
    alt_text: string;
    video_embeds: boolean;
    youtube: boolean;
    uploaded_videos: boolean;
    video_position: string;
  };
  monetization: {
    enable_adsense: boolean;
    custom_ad_code: boolean;
    affiliate_blocks: boolean;
    banners: boolean;
    sponsored_sections: boolean;
    cta_blocks: boolean;
    ad_slots: string[]; // enabled slot keys
  };
  social: {
    networks: {
      platform: string;
      enabled: boolean; // auto-share on this network
      caption: string;
      hashtags: string;
      image_on: boolean;
      schedule: string;
    }[];
  };
}

// Re-export so server callers keep one import path; the map itself lives in a
// client-safe module (src/lib/adSlots.ts) so UI components can share it.
export { AD_SLOT_LABELS } from "../../lib/adSlots";

export interface CreateBlogResult {
  blog: { id: number; slug: string; name: string };
  logoMedia: MediaRow | null;
  faviconMedia: MediaRow | null;
  pageCount: number;
  categoryCount: number;
  tagCount: number;
  menuItemCount: number;
  adCount: number;
}

// ---- Validation -----------------------------------------------------------
export function validatePayload(p: WizardPayload): string | null {
  if (!p?.basic?.name || !p.basic.name.trim()) {
    return "Blog name is required.";
  }
  if (!p.basic.slug || !p.basic.slug.trim()) {
    return "Blog URL slug is required.";
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.basic.slug)) {
    return "Slug may only contain lowercase letters, numbers and single hyphens.";
  }
  if (!p.basic.language) return "Language is required.";
  if (!p.basic.brand_name || !p.basic.brand_name.trim()) {
    return "Author / brand name is required.";
  }
  if (!p.niche?.main_niche || !p.niche.main_niche.trim()) {
    return "Main niche is required (step 2).";
  }
  const ppd = Number(p.frequency?.posts_per_day);
  if (!Number.isFinite(ppd) || ppd < 1 || ppd > 50) {
    return "Posts per day must be between 1 and 50 (step 6).";
  }
  if (p.article?.length === "custom" && (!p.article.custom_word_count || p.article.custom_word_count < 300)) {
    return "Custom word count must be at least 300 words.";
  }
  return null;
}

// ---- Creation -------------------------------------------------------------
export async function createBlogAndBackbone(
  payload: WizardPayload,
  ownerId: number
): Promise<CreateBlogResult> {
  const err = validatePayload(payload);
  if (err) throw new Error(err);
  const now = nowIso();
  const name = payload.basic.name.trim();
  const slug = payload.basic.slug.trim();

  // Slug uniqueness is enforced at the DB level (UNIQUE on blogs.slug). If the
  // user's configured slug is already taken, append a short suffix so we never
  // fail with a fake result — but surface it in the returned slug.
  const taken = await get<{ id: number }>("SELECT id FROM blogs WHERE slug = ?", slug);
  const finalSlug = taken
    ? `${slug}-${Math.random().toString(36).slice(2, 8)}`
    : slug;

  // ---- 1. blogs row -------------------------------------------------------
  const blogInfo = await run(
    `INSERT INTO blogs
       (owner_id, name, slug, tagline, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    ownerId,
    name,
    finalSlug,
    payload.basic.brand_name,
    payload.basic.description ?? "",
    now,
    now
  );
  const blogId = blogInfo.lastInsertRowid;
  if (!blogId) throw new Error("Failed to create blog row.");

  // ---- 2. media (logo/favicon) — needs blog_id, do it before settings ----
  let logoMedia: MediaRow | null = null;
  let faviconMedia: MediaRow | null = null;
  if (payload.basic.logo) {
    logoMedia = await registerStagedMediaForBlog(
      blogId,
      ownerId,
      payload.basic.logo,
      `${name} logo`
    );
  }
  if (payload.basic.favicon) {
    faviconMedia = await registerStagedMediaForBlog(
      blogId,
      ownerId,
      payload.basic.favicon,
      `${name} favicon`
    );
  }

  // ---- 3. blog_settings row (dedicated columns + full JSON config) --------
  const settingsObj: Record<string, unknown> = {
    step1_basic: {
      name,
      description: payload.basic.description,
      slug: finalSlug,
      language: payload.basic.language,
      country: payload.basic.country,
      brand_name: payload.basic.brand_name,
      logo_media_id: logoMedia?.id ?? null,
      favicon_media_id: faviconMedia?.id ?? null,
      logo_url: logoMedia ? `/api/media/${logoMedia.id}` : null,
      favicon_url: faviconMedia ? `/api/media/${faviconMedia.id}` : null,
    },
    step2_niche: payload.niche,
    step3_writing: payload.writing,
    step4_article: payload.article,
    step5_seo: payload.seo,
    step6_frequency: {
      ...payload.frequency,
      auto_publish: !!payload.frequency.auto_publish,
      require_approval: !!payload.frequency.require_approval,
    },
    step7_media: payload.media,
    step8_monetization: payload.monetization,
    step9_social: payload.social,
  };
  await run(
    `INSERT INTO blog_settings
       (blog_id, language, timezone, posts_per_day, auto_publish, allow_comments, monetization_active, seo_title_template, config, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    blogId,
    payload.basic.language ?? "en",
    payload.frequency.timezone ?? "UTC",
    Number(payload.frequency.posts_per_day) || 2,
    payload.frequency.auto_publish ? 1 : 0,
    payload.monetization && payload.monetization.enable_adsense ? 1 : 0,
    payload.seo?.seo_title ?? "",
    JSON.stringify(settingsObj),
    now
  );

  // ---- 4. owner membership -------------------------------------------------
  await run(
    `INSERT OR IGNORE INTO blog_members (blog_id, user_id, role, created_at)
     VALUES (?, ?, 'owner', ?)`,
    blogId,
    ownerId,
    now
  );

  // ---- 5. categories (main niche + sub-niches) -----------------------------
  const catNames = uniqueNames([
    payload.niche.main_niche,
    ...(payload.niche.sub_niches ?? []),
  ]);
  for (const cat of catNames) {
    const catSlug = slugify(cat) || "general";
    await run(
      `INSERT OR IGNORE INTO categories (blog_id, name, slug, description, created_at)
       VALUES (?, ?, ?, '', ?)`,
      blogId,
      cat,
      catSlug,
      now
    );
  }

  // ---- 6. tags (main topics) ----------------------------------------------
  const tagNames = uniqueNames(payload.niche.main_topics ?? []);
  for (const tag of tagNames) {
    const tagSlug = slugify(tag) || "topic";
    await run(
      `INSERT OR IGNORE INTO tags (blog_id, name, slug, created_at)
       VALUES (?, ?, ?, ?)`,
      blogId,
      tag,
      tagSlug,
      now
    );
  }

  // ---- 7. seeded default pages ---------------------------------------------
  const defaultPages: { title: string; slug: string; content: string }[] = [
    { title: "Home", slug: "home", content: "Welcome to " + name + "." },
    { title: "About", slug: "about", content: "About " + name + "." },
    { title: "Contact", slug: "contact", content: "Contact " + name + "." },
    { title: "Privacy", slug: "privacy", content: "Privacy policy placeholder for " + name + "." },
  ];
  for (const p of defaultPages) {
    await run(
      `INSERT OR IGNORE INTO pages (blog_id, title, slug, content, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
      blogId,
      p.title,
      p.slug,
      p.content,
      now,
      now
    );
  }

  // ---- 8. primary menu + items (real navigation backbone) ------------------
  const menuInfo = await run(
    `INSERT INTO menus (blog_id, name, location, created_at)
     VALUES (?, ?, 'primary', ?)`,
    blogId,
    "Primary",
    now
  );
  const menuId = menuInfo.lastInsertRowid;
  const menuItems: { label: string; url: string }[] = [
    { label: "Home", url: "/" },
    { label: "About", url: "/about" },
    { label: "Contact", url: "/contact" },
    { label: "Privacy", url: "/privacy" },
  ];
  if (menuId) {
    let order = 0;
    for (const item of menuItems) {
      await run(
        `INSERT INTO menu_items (menu_id, parent_id, label, url, target, sort_order)
         VALUES (?, NULL, ?, ?, '', ?)`,
        menuId,
        item.label,
        item.url,
        order++
      );
    }
  }

  // ---- 9. monetization: ads + placements for enabled slots -----------------
  const money = payload.monetization;
  let adCount = 0;
  if (money) {
    const adsToCreate: { name: string; type: string }[] = [];
    if (money.enable_adsense) adsToCreate.push({ name: "AdSense", type: "adsense" });
    if (money.custom_ad_code) adsToCreate.push({ name: "Custom ad", type: "custom" });
    if (money.affiliate_blocks) adsToCreate.push({ name: "Affiliate blocks", type: "affiliate" });
    if (money.sponsored_sections) adsToCreate.push({ name: "Sponsored sections", type: "sponsored" });
    const enabledSlots = money.ad_slots ?? [];
    for (const ad of adsToCreate) {
      const adInfo = await run(
        `INSERT INTO ads (blog_id, name, type, code, status, created_at)
         VALUES (?, ?, ?, '', 'active', ?)`,
        blogId,
        ad.name,
        ad.type,
        now
      );
      adCount++;
      const adId = adInfo.lastInsertRowid;
      if (adId) {
        for (const slot of enabledSlots) {
          await run(
            `INSERT INTO ad_placements (blog_id, ad_id, location, entity_type, active, created_at)
             VALUES (?, ?, ?, 'global', 1, ?)`,
            blogId,
            adId,
            slot,
            now
          );
        }
      }
    }
  }

  // ---- 10. activity log ------------------------------------------------------
  await logActivity({
    userId: ownerId,
    blogId,
    action: "blog.create",
    entityType: "blog",
    entityId: blogId,
    detail: `Created blog "${name}" at /${finalSlug}`,
  });

  const pageCount = (await get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pages WHERE blog_id = ?",
    blogId
  ))?.n ?? 0;
  const categoryCount = (await get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM categories WHERE blog_id = ?",
    blogId
  ))?.n ?? 0;
  const tagCount = (await get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM tags WHERE blog_id = ?",
    blogId
  ))?.n ?? 0;
  const menuItemCount = menuId
    ? (await get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM menu_items WHERE menu_id = ?",
        menuId
      ))?.n ?? 0
    : 0;

  return {
    blog: { id: blogId, slug: finalSlug, name },
    logoMedia,
    faviconMedia,
    pageCount,
    categoryCount,
    tagCount,
    menuItemCount,
    adCount,
  };
}

function uniqueNames(values: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = (v ?? "").trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export async function slugExists(slug: string): Promise<boolean> {
  const row = await get<{ id: number }>("SELECT id FROM blogs WHERE slug = ?", slug);
  return !!row;
}

/** Load a blog by id (used by the post-create landing route). */
export async function loadBlog(id: number) {
  const blog = await get<BlogRow & { owner_id: number }>(
    "SELECT * FROM blogs WHERE id = ?",
    id
  );
  if (!blog) return null;
  const settings = await get<{
    config: string;
    language: string;
    timezone: string;
    posts_per_day: number;
    auto_publish: number;
    monetization_active: number;
    allow_comments: number;
  }>(
    "SELECT config, language, timezone, posts_per_day, auto_publish, monetization_active, allow_comments FROM blog_settings WHERE blog_id = ?",
    id
  );
  const pages = await all<{ id: number; title: string; slug: string }>(
    "SELECT id, title, slug FROM pages WHERE blog_id = ? ORDER BY id",
    id
  );
  return {
    ...blog,
    settings: settings ?? null,
    config: settings?.config ? safeParse(settings.config) : null,
    pages,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
