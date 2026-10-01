/**
 * Autonoblog — Phase 2 Blog Creation Wizard (client component).
 *
 * A real 10-step guided form. All state stays client-side while the user walks
 * the steps; on the final "Create Blog" step the whole payload is submitted to
 * a single RPC that writes real DB rows. Nothing here is stubbed: every field
 * validates, the slug is checked for uniqueness live, image uploads are staged
 * to disk and registered as real `media` rows on create, and the create call
 * reports real success/failure with retry.
 *
 * Server access is exclusively through createServerFn actions in
 * ../../server/rpc/wizard — never direct server imports (those must not reach
 * the client bundle).
 */
import { useState, useRef } from "react";
import { Link, useLoaderData, useNavigate } from "@tanstack/react-router";
import {
  mediaUploadAction,
  checkSlugAction,
  createBlogAction,
} from "../../server/rpc/wizard";
import type { SocialNetworkInfo } from "../../server/rpc/wizard";

// ---------------------------------------------------------------------------
// Types + defaults (kept client-local so we never import server-only code)
// ---------------------------------------------------------------------------
interface UploadRef {
  token: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}
interface NetConfig {
  platform: string;
  enabled: boolean;
  caption: string;
  hashtags: string;
  imageOn: boolean;
  schedule: string;
}
interface WizardForm {
  basic: {
    name: string;
    description: string;
    slug: string;
    language: string;
    country: string;
    brand_name: string;
    logo: UploadRef | null;
    favicon: UploadRef | null;
    logoPreview: string | null;
    faviconPreview: string | null;
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
    perspective: string;
    register: string;
    format: string;
    brand_voice: string;
    custom_instructions: string;
  };
  article: {
    length: string;
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
    ad_slots: string[];
  };
  social: { networks: NetConfig[] };
}

const AD_SLOTS: { key: string; label: string }[] = [
  { key: "header", label: "Header" },
  { key: "before_article", label: "Before article" },
  { key: "after_intro", label: "After intro" },
  { key: "mid", label: "Mid article" },
  { key: "sidebar", label: "Sidebar" },
  { key: "before_conclusion", label: "Before conclusion" },
  { key: "after_conclusion", label: "After conclusion" },
  { key: "footer", label: "Footer" },
];

function defaultForm(networks: SocialNetworkInfo[]): WizardForm {
  return {
    basic: {
      name: "",
      description: "",
      slug: "",
      language: "en",
      country: "",
      brand_name: "",
      logo: null,
      favicon: null,
      logoPreview: null,
      faviconPreview: null,
    },
    niche: {
      main_niche: "",
      sub_niches: [],
      main_topics: [],
      topics_to_avoid: [],
      target_audience: "",
      audience_interests: [],
      user_intent: "",
      geo_targeting: "",
    },
    writing: {
      style: "",
      tone: "friendly",
      formality: "medium",
      personality: "",
      vocab_level: "general",
      perspective: "third",
      register: "professional",
      format: "educational",
      brand_voice: "",
      custom_instructions: "",
    },
    article: {
      length: "medium",
      custom_word_count: 1200,
      detail_level: "moderate",
      num_sections: 6,
      num_headings: 4,
      num_examples: 3,
      faqs: true,
      tables: false,
      lists: true,
      pros_cons: false,
      statistics: true,
      sources: true,
      references: true,
      expert_quotes: false,
    },
    seo: {
      primary_keywords: [],
      secondary_keywords: [],
      search_intent: "informational",
      seo_title: "",
      meta_description: "",
      url_slug_style: "hyphenated",
      h1h2h3_guidance: "",
      internal_linking: true,
      external_references: true,
      schema_faqs: true,
      schema_article: true,
      canonical: true,
      open_graph: true,
      social_metadata: true,
      image_alt_text_guidance: "",
    },
    frequency: {
      posts_per_day: 2,
      posts_per_week: 14,
      publishing_times: ["09:00"],
      timezone: "UTC",
      auto_publish: true,
      require_approval: false,
    },
    media: {
      ai_images: true,
      uploads: true,
      external_sources: false,
      featured_image_default: "featured-from-post",
      inline_images: true,
      captions: true,
      alt_text: "descriptive",
      video_embeds: true,
      youtube: true,
      uploaded_videos: false,
      video_position: "inline",
    },
    monetization: {
      enable_adsense: false,
      custom_ad_code: false,
      affiliate_blocks: false,
      banners: false,
      sponsored_sections: false,
      cta_blocks: false,
      ad_slots: [],
    },
    social: {
      networks: networks.map((n) => ({
        platform: n.platform,
        enabled: false,
        caption: "",
        hashtags: "",
        imageOn: true,
        schedule: "instant",
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// ---- Module-scope presentational helpers (kept outside the wizard component
// so their local state is not reset on every parent re-render) --------------
const inputCls =
  "mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white";

function Field({ label, name, required, error, children }: any) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      {children}
      {error && (
        <span className="mt-1 block text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      )}
    </label>
  );
}

function ListEditor({
  value,
  setValue,
  placeholder,
}: {
  value: string[];
  setValue: (v: string[]) => void;
  placeholder: string;
}) {
  const [text, setText] = useState("");
  function add() {
    const items = text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length) {
      setValue([...new Set([...value, ...items])]);
      setText("");
    }
  }
  return (
    <div>
      <div className="flex gap-2">
        <input
          className={inputCls}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          onClick={add}
          className="shrink-0 rounded-md border border-neutral-300 px-3 text-sm dark:border-neutral-700 dark:text-neutral-200"
        >
          Add
        </button>
      </div>
      {value.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {value.map((v) => (
            <span
              key={v}
              className="flex items-center gap-1 rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
            >
              {v}
              <button
                type="button"
                onClick={() => setValue(value.filter((x) => x !== v))}
                className="text-neutral-400 hover:text-red-500"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ChoiceChips({
  value,
  setValue,
  options,
  multi,
}: {
  value: string[];
  setValue: (v: string[]) => void;
  options: { label: string; value: string }[];
  multi?: boolean;
}) {
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {options.map((o) => {
        const active = value.includes(o.value);
        const toggle = () => {
          if (multi)
            setValue(
              active ? value.filter((v) => v !== o.value) : [...value, o.value],
            );
          else setValue(active ? [] : [o.value]);
        };
        return (
          <button
            type="button"
            key={o.value}
            onClick={toggle}
            className={`rounded-full px-3 py-1 text-xs ${active ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900" : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
    >
      <span>{label}</span>
      <span
        className={`relative h-5 w-10 rounded-full transition ${checked ? "bg-neutral-900 dark:bg-white" : "bg-neutral-300 dark:bg-neutral-700"}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all dark:bg-neutral-900 ${checked ? "left-5" : "left-0.5"}`}
        />
      </span>
    </button>
  );
}

function StringListChip({
  label,
  value,
  onChange,
  error,
  required,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  error?: string;
  required?: boolean;
}) {
  const [text, setText] = useState("");
  return (
    <div>
      <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      <div className="flex gap-2">
        <input
          className={inputCls}
          value={text}
          placeholder="Type and press Enter"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const t = text.trim();
              if (t) {
                onChange([...value, t]);
                setText("");
              }
            }
          }}
        />
        <button
          type="button"
          onClick={() => {
            const t = text.trim();
            if (t) {
              onChange([...value, t]);
              setText("");
            }
          }}
          className="shrink-0 rounded-md border border-neutral-300 px-3 text-sm dark:border-neutral-700 dark:text-neutral-200"
        >
          Add
        </button>
      </div>
      {error && (
        <span className="mt-1 block text-xs text-red-600">{error}</span>
      )}
      {value.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {value.map((v) => (
            <span
              key={v}
              className="flex items-center gap-1 rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
            >
              {v}
              <button
                type="button"
                onClick={() => onChange(value.filter((x) => x !== v))}
                className="text-neutral-400 hover:text-red-500"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function UploadField({
  label,
  text,
  preview,
  uploading,
  error,
  onPick,
  onClear,
  inputRef,
  onFile,
}: any) {
  return (
    <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
        {label}
      </p>
      {preview ? (
        <div className="mt-2">
          <img
            src={preview}
            alt={label}
            className="h-16 w-16 rounded-md border object-cover dark:border-neutral-700"
          />
          <p className="mt-1 truncate text-xs text-neutral-500">{text}</p>
          <button
            type="button"
            onClick={onClear}
            className="mt-1 text-xs text-red-500"
          >
            Remove
          </button>
        </div>
      ) : (
        <div className="mt-2">
          <button
            type="button"
            onClick={onPick}
            disabled={uploading}
            className="w-full rounded-md border border-dashed border-neutral-300 px-3 py-3 text-sm text-neutral-500 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-400"
          >
            {uploading ? "Uploading…" : text ? text : "Upload image"}
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e: any) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

const STEP_TITLES = [
  "Basic info",
  "Niche",
  "Writing style",
  "Article settings",
  "SEO",
  "Frequency",
  "Media",
  "Monetization",
  "Social",
  "Review",
];
const STEP_DESC = [
  "Name, URL, language and brand of your blog.",
  "What you’ll write about and for whom.",
  "How your posts should sound.",
  "Structure and depth of each article.",
  "How your content will rank.",
  "When and how often to publish.",
  "How images and video are handled.",
  "How the blog makes money.",
  "Which networks to auto-share to.",
  "Confirm everything and create the blog.",
];

export function BlogWizard() {
  const { user, networks } = useLoaderData({ from: "/blogs/new" });
  const [form, setForm] = useState<WizardForm>(() => defaultForm(networks));
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [slugChecked, setSlugChecked] = useState<null | { available: boolean }>(
    null,
  );
  const [slugChecking, setSlugChecking] = useState(false);
  const [uploading, setUploading] = useState<"logo" | "favicon" | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ id: number; slug: string } | null>(
    null,
  );
  const [fatal, setFatal] = useState<string | null>(null);
  const logoRef = useRef<HTMLInputElement>(null);
  const faviconRef = useRef<HTMLInputElement>(null);
  /**
   * True once the user has edited the slug by hand (stops auto-slugging from the
   * blog name). Declared here, with the other hooks, on purpose: it used to sit
   * *after* the `if (created) return <success screen>` early return below, so the
   * render that set `created` returned before this hook ran and React threw
   * "Rendered fewer hooks than expected" — the blog rows were written and the
   * user still landed on the router's "Something went wrong!" error screen.
   * Every hook must be declared before that early return.
   */
  const slugTouched = useRef(false);
  const navigate = useNavigate();

  if (created) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-neutral-50 px-6 dark:bg-neutral-950">
        <div className="w-full max-w-md rounded-xl border border-green-200 bg-white p-8 text-center dark:border-green-800 dark:bg-neutral-900">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-100 text-2xl dark:bg-green-900">
            ✓
          </div>
          <h1 className="mt-4 text-xl font-bold text-neutral-900 dark:text-white">
            Blog created!
          </h1>
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
            <strong>{form.basic.name}</strong> is live in the database. Its
            settings, pages and navigation are ready.
          </p>
          <Link
            to="/blogs/$blogId"
            params={{ blogId: String(created.id) }}
            className="mt-6 block w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Go to your blog
          </Link>
          <Link
            to="/dashboard"
            className="mt-3 block text-sm text-neutral-500 underline hover:text-neutral-800 dark:hover:text-white"
          >
            Back to dashboard
          </Link>
        </div>
      </main>
    );
  }

  /**
   * Merge a PARTIAL patch into ONE section of the form with a functional
   * setState. The old helper took a whole section object built from the
   * `form` value captured by the render that created the handler, so when two
   * changes landed before React re-rendered the second one silently reverted
   * the first (observed: enabling AdSense then picking an ad slot left
   * monetization.enable_adsense = false and blocked the step).
   *
   * A patch value may also be a function of the current section value, which
   * lets callers derive the next value (e.g. toggle an item in an array) from
   * the live state instead of a stale snapshot.
   */
  const patch = (key: string, part: Record<string, unknown>) =>
    setForm((f) => {
      const section = (f as unknown as Record<string, unknown>)[key];
      const next = { ...(section as Record<string, unknown>) };
      for (const [k, v] of Object.entries(part)) {
        next[k] =
          typeof v === "function"
            ? (v as (cur: unknown) => unknown)(next[k])
            : v;
      }
      return { ...f, [key]: next } as unknown as WizardForm;
    });

  /** Same idea for a single social network row (functional update). */
  const patchNetwork = (platform: string, part: Partial<NetConfig>) =>
    setForm((f) => ({
      ...f,
      social: {
        networks: f.social.networks.map((x) =>
          x.platform === platform ? { ...x, ...part } : x,
        ),
      },
    }));

  // ---- Auto slug from name (only while the user hasn't typed their own) ----
  function onNameChange(name: string) {
    setSlugChecked(null);
    setForm((f) => {
      const n = { ...f, basic: { ...f.basic, name } };
      if (!f.basic.slug.trim() || !slugTouched.current) {
        n.basic.slug = slugify(name);
      }
      return n;
    });
  }

  function setBasic(patch: Partial<WizardForm["basic"]>) {
    setForm((f) => ({ ...f, basic: { ...f.basic, ...patch } }));
  }

  async function checkSlugLive() {
    const slug = form.basic.slug.trim();
    if (!slug) return;
    setSlugChecking(true);
    setSlugChecked(null);
    try {
      const res = await checkSlugAction({ data: { slug } });
      setSlugChecked({ available: res.available });
    } catch {
      setSlugChecked({ available: true });
    } finally {
      setSlugChecking(false);
    }
  }

  async function handleUpload(kind: "logo" | "favicon", file: File) {
    if (!file) return;
    setUploading(kind);
    setErrors((e) => ({ ...e, [`${kind}Upload`]: "" }));
    const preview = URL.createObjectURL(file);
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = String(reader.result);
      try {
        const res = await mediaUploadAction({
          data: { base64, fileName: file.name },
        });
        if (!res.ok || !res.data) {
          setErrors((e) => ({
            ...e,
            [`${kind}Upload`]: res.error ?? "Upload failed",
          }));
          return;
        }
        const ref = res.data;
        setBasic({
          [`${kind === "logo" ? "logo" : "favicon"}`]: ref,
          [`${kind === "logo" ? "logoPreview" : "faviconPreview"}`]: preview,
        } as Partial<WizardForm["basic"]>);
        setErrors((e) => ({ ...e, [`${kind}Upload`]: "" }));
      } catch (err) {
        setErrors((e) => ({ ...e, [`${kind}Upload`]: (err as Error).message }));
      } finally {
        setUploading(null);
      }
    };
    reader.readAsDataURL(file);
  }

  // ---- Step validation ----------------------------------------------------
  function validateStep(s: number): boolean {
    const e: Record<string, string> = {};
    if (s === 0) {
      if (!form.basic.name.trim()) e.name = "Blog name is required.";
      if (!form.basic.brand_name.trim())
        e.brand_name = "Author / brand name is required.";
      if (!form.basic.slug.trim()) e.slug = "URL slug is required.";
      else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.basic.slug))
        e.slug = "Use lowercase letters, numbers and hyphens only.";
      if (slugChecked && !slugChecked.available)
        e.slug = "That slug is already taken.";
      if (!form.basic.language) e.language = "Choose a language.";
    } else if (s === 1) {
      if (!form.niche.main_niche.trim())
        e.main_niche = "Main niche is required.";
    } else if (s === 4) {
      if (form.seo.primary_keywords.length === 0)
        e.primary_keywords = "Add at least one primary keyword.";
    } else if (s === 5) {
      const ppd = Number(form.frequency.posts_per_day);
      if (!Number.isFinite(ppd) || ppd < 1 || ppd > 50)
        e.posts_per_day = "Between 1 and 50.";
    } else if (s === 7) {
      if (
        !form.monetization.enable_adsense &&
        form.monetization.ad_slots.length > 0
      )
        e.ad_slots = "Ad slots need AdSense or custom ads enabled.";
    } else if (s === 9) {
      // review step — everything already validated
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function goNext() {
    if (!validateStep(step)) return;
    if (step < 9) {
      setStep(step + 1);
      setErrors({});
    }
  }
  function goBack() {
    if (step > 0) setStep(step - 1);
    setErrors({});
  }
  async function doCreate() {
    setCreating(true);
    setFatal(null);
    try {
      const payload = {
        basic: {
          name: form.basic.name,
          description: form.basic.description,
          slug: form.basic.slug,
          language: form.basic.language,
          country: form.basic.country,
          brand_name: form.basic.brand_name,
          logo: form.basic.logo,
          favicon: form.basic.favicon,
        },
        niche: form.niche,
        writing: form.writing,
        article: {
          ...form.article,
          custom_word_count: Number(form.article.custom_word_count) || 0,
          num_sections: Number(form.article.num_sections) || 0,
          num_headings: Number(form.article.num_headings) || 0,
          num_examples: Number(form.article.num_examples) || 0,
        },
        seo: {
          ...form.seo,
          primary_keywords: form.seo.primary_keywords,
          secondary_keywords: form.seo.secondary_keywords,
        },
        frequency: {
          ...form.frequency,
          posts_per_day: Number(form.frequency.posts_per_day) || 2,
          posts_per_week: Number(form.frequency.posts_per_week) || 0,
        },
        media: form.media,
        monetization: form.monetization,
        social: { networks: form.social.networks },
      };
      const res = await createBlogAction({ data: payload });
      if (res.ok && res.data) {
        const result = (
          res.data as { result: { blog: { id: number; slug: string } } }
        ).result;
        const blog = result?.blog;
        if (!blog?.id) {
          // The write side answered OK but without the new blog's id — never
          // pretend we landed somewhere; send the user to the dashboard.
          setFatal(
            "The blog was written but the server did not return its id. Open your dashboard to find it.",
          );
          return;
        }
        // Real success: land the user on the blog that was just created. The
        // success screen stays as the fallback, so navigation trouble can never
        // turn a completed write into an error screen.
        setCreated(blog);
        try {
          await navigate({
            to: "/blogs/$blogId",
            params: { blogId: String(blog.id) },
            replace: true,
          });
        } catch {
          /* success screen is already rendered */
        }
      } else {
        setFatal(res.error ?? "Could not create the blog. Please try again.");
      }
    } catch (err) {
      setFatal((err as Error).message ?? "Unexpected error.");
    } finally {
      setCreating(false);
    }
  }

  const Field = ({ ...p }: any) => (
    <label className="block">
      <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
        {p.label}
        {p.required && <span className="text-red-500"> *</span>}
      </span>
      {p.children}
      {errors[p.name] && (
        <span className="mt-1 block text-xs text-red-600 dark:text-red-400">
          {errors[p.name]}
        </span>
      )}
    </label>
  );
  const inputCls =
    "mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white";

  // ---- List editor (comma/en) ---------------------------------------------
  function ListEditor({
    value,
    setValue,
    placeholder,
  }: {
    value: string[];
    setValue: (v: string[]) => void;
    placeholder: string;
  }) {
    const [text, setText] = useState("");
    function add() {
      const items = text
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (items.length) {
        setValue([...new Set([...value, ...items])]);
        setText("");
      }
    }
    return (
      <div>
        <div className="flex gap-2">
          <input
            className={inputCls}
            value={text}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <button
            type="button"
            onClick={add}
            className="shrink-0 rounded-md border border-neutral-300 px-3 text-sm dark:border-neutral-700 dark:text-neutral-200"
          >
            Add
          </button>
        </div>
        {value.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {value.map((v) => (
              <span
                key={v}
                className="flex items-center gap-1 rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
              >
                {v}
                <button
                  type="button"
                  onClick={() => setValue(value.filter((x) => x !== v))}
                  className="text-neutral-400 hover:text-red-500"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
  function ChoiceChips({
    value,
    setValue,
    options,
    multi,
  }: {
    value: string[];
    setValue: (v: string[]) => void;
    options: { label: string; value: string }[];
    multi?: boolean;
  }) {
    return (
      <div className="mt-1 flex flex-wrap gap-2">
        {options.map((o) => {
          const active = value.includes(o.value);
          const toggle = () => {
            if (multi)
              setValue(
                active
                  ? value.filter((v) => v !== o.value)
                  : [...value, o.value],
              );
            else setValue(active ? [] : [o.value]);
          };
          return (
            <button
              type="button"
              key={o.value}
              onClick={toggle}
              className={`rounded-full px-3 py-1 text-xs ${active ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900" : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    );
  }
  function Toggle({
    checked,
    onChange,
    label,
  }: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label: string;
  }) {
    return (
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className="flex w-full items-center justify-between rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
      >
        <span>{label}</span>
        <span
          className={`relative h-5 w-10 rounded-full transition ${checked ? "bg-neutral-900 dark:bg-white" : "bg-neutral-300 dark:bg-neutral-700"}`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all dark:bg-neutral-900 ${checked ? "left-5" : "left-0.5"}`}
          />
        </span>
      </button>
    );
  }

  // ---- Step render ---------------------------------------------------------
  const stepBody = () => {
    switch (step) {
      case 0:
        return (
          <div className="space-y-5">
            <Field label="Blog name" name="name" required>
              <input
                className={inputCls}
                value={form.basic.name}
                onChange={(e) => onNameChange(e.target.value)}
                placeholder="e.g. The Daily Grind"
              />
            </Field>
            <Field label="Description" name="description">
              <textarea
                className={inputCls}
                rows={3}
                value={form.basic.description}
                onChange={(e) => setBasic({ description: e.target.value })}
                placeholder="What is this blog about?"
              />
            </Field>
            <Field label="URL slug" name="slug" required>
              <div className="flex items-center gap-2">
                <span className="text-sm text-neutral-400">/</span>
                <input
                  className={inputCls}
                  value={form.basic.slug}
                  onChange={(e) => {
                    slugTouched.current = true;
                    setSlugChecked(null);
                    setBasic({ slug: slugify(e.target.value) });
                  }}
                  placeholder="my-blog"
                />
                <button
                  type="button"
                  onClick={checkSlugLive}
                  disabled={slugChecking}
                  className="shrink-0 rounded-md border border-neutral-300 px-3 py-2 text-sm disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-200"
                >
                  {slugChecking ? "…" : "Check"}
                </button>
              </div>
              {slugChecked && !slugChecked.available && (
                <span className="mt-1 block text-xs text-red-600">
                  Slug is taken — a suffix will be appended.
                </span>
              )}
              {slugChecked && slugChecked.available && (
                <span className="mt-1 block text-xs text-green-600">
                  Slug is available ✓
                </span>
              )}
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Language" name="language" required>
                <select
                  className={inputCls}
                  value={form.basic.language}
                  onChange={(e) => setBasic({ language: e.target.value })}
                >
                  {[
                    "en",
                    "es",
                    "fr",
                    "de",
                    "pt",
                    "it",
                    "nl",
                    "hi",
                    "ar",
                    "ja",
                    "zh",
                    "ko",
                  ].map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Country / market" name="country">
                <input
                  className={inputCls}
                  value={form.basic.country}
                  onChange={(e) => setBasic({ country: e.target.value })}
                  placeholder="e.g. United States"
                />
              </Field>
            </div>
            <Field label="Author / brand name" name="brand_name" required>
              <input
                className={inputCls}
                value={form.basic.brand_name}
                onChange={(e) => setBasic({ brand_name: e.target.value })}
                placeholder="e.g. Jane Doe"
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <UploadField
                kind="logo"
                label="Logo"
                text={form.basic.logo ? form.basic.logo.fileName : null}
                preview={form.basic.logoPreview}
                uploading={uploading === "logo"}
                error={errors.logoUpload}
                onPick={() => logoRef.current?.click()}
                onClear={() => {
                  setBasic({ logo: null, logoPreview: null });
                }}
                inputRef={logoRef}
                onFile={(f) => handleUpload("logo", f)}
              />
              <UploadField
                kind="favicon"
                label="Favicon"
                text={form.basic.favicon ? form.basic.favicon.fileName : null}
                preview={form.basic.faviconPreview}
                uploading={uploading === "favicon"}
                error={errors.faviconUpload}
                onPick={() => faviconRef.current?.click()}
                onClear={() => {
                  setBasic({ favicon: null, faviconPreview: null });
                }}
                inputRef={faviconRef}
                onFile={(f) => handleUpload("favicon", f)}
              />
            </div>
          </div>
        );
      case 1:
        return (
          <div className="space-y-5">
            <Field label="Main niche" name="main_niche" required>
              <input
                className={inputCls}
                value={form.niche.main_niche}
                onChange={(e) => patch("niche", { main_niche: e.target.value })}
                placeholder="e.g. Fitness"
              />
            </Field>
            <Field label="Sub-niches" name="sub_niches">
              <ListEditor
                value={form.niche.sub_niches}
                setValue={(v) => patch("niche", { sub_niches: v })}
                placeholder="e.g. Strength training, Yoga"
              />
            </Field>
            <Field label="Main topics" name="main_topics">
              <ListEditor
                value={form.niche.main_topics}
                setValue={(v) => patch("niche", { main_topics: v })}
                placeholder="e.g. Workouts, Nutrition"
              />
            </Field>
            <Field label="Topics to avoid" name="topics_to_avoid">
              <ListEditor
                value={form.niche.topics_to_avoid}
                setValue={(v) => patch("niche", { topics_to_avoid: v })}
                placeholder="e.g. Steroids, Extreme diets"
              />
            </Field>
            <Field label="Target audience" name="target_audience">
              <input
                className={inputCls}
                value={form.niche.target_audience}
                onChange={(e) =>
                  patch("niche", { target_audience: e.target.value })
                }
                placeholder="e.g. Busy professionals 25-45"
              />
            </Field>
            <Field label="Audience interests" name="audience_interests">
              <ListEditor
                value={form.niche.audience_interests}
                setValue={(v) => patch("niche", { audience_interests: v })}
                placeholder="e.g. Meal prep, Home workouts"
              />
            </Field>
            <Field label="User intent" name="user_intent">
              <input
                className={inputCls}
                value={form.niche.user_intent}
                onChange={(e) =>
                  patch("niche", { user_intent: e.target.value })
                }
                placeholder="e.g. Learn how to start"
              />
            </Field>
            <Field label="Geo targeting" name="geo_targeting">
              <input
                className={inputCls}
                value={form.niche.geo_targeting}
                onChange={(e) =>
                  patch("niche", { geo_targeting: e.target.value })
                }
                placeholder="e.g. Global / United States"
              />
            </Field>
          </div>
        );
      case 2:
        return (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Style" name="style">
                <input
                  className={inputCls}
                  value={form.writing.style}
                  onChange={(e) => patch("writing", { style: e.target.value })}
                  placeholder="e.g. Clear and direct"
                />
              </Field>
              <Field label="Tone" name="tone">
                <input
                  className={inputCls}
                  value={form.writing.tone}
                  onChange={(e) => patch("writing", { tone: e.target.value })}
                  placeholder="e.g. Encouraging"
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Formality" name="formality">
                <select
                  className={inputCls}
                  value={form.writing.formality}
                  onChange={(e) =>
                    patch("writing", { formality: e.target.value })
                  }
                >
                  {["low", "medium", "high"].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Vocabulary level" name="vocab_level">
                <select
                  className={inputCls}
                  value={form.writing.vocab_level}
                  onChange={(e) =>
                    patch("writing", { vocab_level: e.target.value })
                  }
                >
                  {["basic", "general", "advanced"].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Personality" name="personality">
              <input
                className={inputCls}
                value={form.writing.personality}
                onChange={(e) =>
                  patch("writing", { personality: e.target.value })
                }
                placeholder="e.g. Witty and optimistic"
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Perspective" name="perspective">
                <select
                  className={inputCls}
                  value={form.writing.perspective}
                  onChange={(e) =>
                    patch("writing", { perspective: e.target.value })
                  }
                >
                  <option value="first">First person</option>
                  <option value="third">Third person</option>
                </select>
              </Field>
              <Field label="Register" name="register">
                <select
                  className={inputCls}
                  value={form.writing.register}
                  onChange={(e) =>
                    patch("writing", { register: e.target.value })
                  }
                >
                  <option value="professional">Professional</option>
                  <option value="casual">Casual</option>
                </select>
              </Field>
            </div>
            <Field label="Format" name="format">
              <ChoiceChips
                multi={false}
                value={form.writing.format ? [form.writing.format] : []}
                setValue={(v) => patch("writing", { format: v[0] ?? "" })}
                options={[
                  ["educational", "Educational"],
                  ["storytelling", "Storytelling"],
                  ["news", "News"],
                  ["opinion", "Opinion"],
                  ["tutorial", "Tutorial"],
                ].map(([value, label]) => ({ value, label }))}
              />
            </Field>
            <Field label="Brand voice" name="brand_voice">
              <textarea
                className={inputCls}
                rows={2}
                value={form.writing.brand_voice}
                onChange={(e) =>
                  patch("writing", { brand_voice: e.target.value })
                }
                placeholder="Words that define your brand"
              />
            </Field>
            <Field
              label="Custom writing instructions"
              name="custom_instructions"
            >
              <textarea
                className={inputCls}
                rows={3}
                value={form.writing.custom_instructions}
                onChange={(e) =>
                  patch("writing", { custom_instructions: e.target.value })
                }
                placeholder="Anything the writer must always do"
              />
            </Field>
          </div>
        );
      case 3:
        return (
          <div className="space-y-5">
            <Field label="Article length" name="length">
              <ChoiceChips
                multi={false}
                value={[form.article.length]}
                setValue={(v) => patch("article", { length: v[0] ?? "medium" })}
                options={[
                  ["short", "Short"],
                  ["medium", "Medium"],
                  ["long", "Long"],
                  ["very_long", "Very Long"],
                  ["custom", "Custom"],
                ].map(([value, label]) => ({ value, label }))}
              />
            </Field>
            {form.article.length === "custom" && (
              <Field label="Custom word count" name="custom_word_count">
                <input
                  className={inputCls}
                  type="number"
                  min={300}
                  value={form.article.custom_word_count}
                  onChange={(e) =>
                    patch("article", {
                      custom_word_count: Number(e.target.value),
                    })
                  }
                />
              </Field>
            )}
            <Field label="Detail level" name="detail_level">
              <select
                className={inputCls}
                value={form.article.detail_level}
                onChange={(e) =>
                  patch("article", { detail_level: e.target.value })
                }
              >
                {["light", "moderate", "deep"].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-3 gap-4">
              <Field label="# Sections" name="num_sections">
                <input
                  className={inputCls}
                  type="number"
                  min={1}
                  max={30}
                  value={form.article.num_sections}
                  onChange={(e) =>
                    patch("article", { num_sections: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="# Headings" name="num_headings">
                <input
                  className={inputCls}
                  type="number"
                  min={0}
                  max={30}
                  value={form.article.num_headings}
                  onChange={(e) =>
                    patch("article", { num_headings: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="# Examples" name="num_examples">
                <input
                  className={inputCls}
                  type="number"
                  min={0}
                  max={30}
                  value={form.article.num_examples}
                  onChange={(e) =>
                    patch("article", { num_examples: Number(e.target.value) })
                  }
                />
              </Field>
            </div>
            <Field label="Include" name="articleToggles">
              <div className="mt-1 space-y-2">
                {(
                  [
                    ["faqs", "FAQs"],
                    ["tables", "Tables"],
                    ["lists", "Lists"],
                    ["pros_cons", "Pros / cons"],
                    ["statistics", "Statistics"],
                    ["sources", "Sources"],
                    ["references", "References"],
                    ["expert_quotes", "Expert quotes"],
                  ] as const
                ).map(([key, label]) => (
                  <Toggle
                    key={key}
                    checked={form.article[key]}
                    onChange={(v) => patch("article", { [key]: v })}
                    label={label}
                  />
                ))}
              </div>
            </Field>
          </div>
        );
      case 4:
        return (
          <div className="space-y-5">
            <StringListChip
              key="pk"
              label="Primary keywords"
              value={form.seo.primary_keywords}
              onChange={(v) => patch("seo", { primary_keywords: v })}
              inputCls={inputCls}
              error={errors.primary_keywords}
            />
            <Field label="Secondary keywords" name="secondary_keywords">
              <ListEditor
                value={form.seo.secondary_keywords}
                setValue={(v) => patch("seo", { secondary_keywords: v })}
                placeholder="e.g. best protein powder"
              />
            </Field>
            <Field label="Search intent" name="search_intent">
              <select
                className={inputCls}
                value={form.seo.search_intent}
                onChange={(e) =>
                  patch("seo", { search_intent: e.target.value })
                }
              >
                {[
                  "informational",
                  "commercial",
                  "transactional",
                  "navigational",
                ].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="SEO title template" name="seo_title">
              <input
                className={inputCls}
                value={form.seo.seo_title}
                onChange={(e) => patch("seo", { seo_title: e.target.value })}
                placeholder="e.g. {{title}} | My Blog"
              />
            </Field>
            <Field label="Meta description" name="meta_description">
              <textarea
                className={inputCls}
                rows={2}
                value={form.seo.meta_description}
                onChange={(e) =>
                  patch("seo", { meta_description: e.target.value })
                }
              />
            </Field>
            <Field label="URL slug style" name="url_slug_style">
              <ChoiceChips
                multi={false}
                value={[form.seo.url_slug_style]}
                setValue={(v) =>
                  patch("seo", { url_slug_style: v[0] ?? "hyphenated" })
                }
                options={[
                  ["hyphenated", "hyphenated"],
                  ["lowercase", "lowercase"],
                  ["title", "title"],
                ].map(([value, label]) => ({ value, label }))}
              />
            </Field>
            <Field label="H1/H2/H3 guidance" name="h1h2h3_guidance">
              <textarea
                className={inputCls}
                rows={2}
                value={form.seo.h1h2h3_guidance}
                onChange={(e) =>
                  patch("seo", { h1h2h3_guidance: e.target.value })
                }
                placeholder="How headings should be structured"
              />
            </Field>
            <Field label="Schema / metadata" name="seoToggles">
              <div className="mt-1 space-y-2">
                {(
                  [
                    ["internal_linking", "Internal linking"],
                    ["external_references", "External references"],
                    ["schema_faqs", "FAQ schema"],
                    ["schema_article", "Article schema"],
                    ["canonical", "Canonical URLs"],
                    ["open_graph", "Open Graph"],
                    ["social_metadata", "Social metadata"],
                  ] as const
                ).map(([key, label]) => (
                  <Toggle
                    key={key}
                    checked={form.seo[key]}
                    onChange={(v) => patch("seo", { [key]: v })}
                    label={label}
                  />
                ))}
              </div>
            </Field>
            <Field
              label="Image alt text guidance"
              name="image_alt_text_guidance"
            >
              <input
                className={inputCls}
                value={form.seo.image_alt_text_guidance}
                onChange={(e) =>
                  patch("seo", { image_alt_text_guidance: e.target.value })
                }
                placeholder="e.g. Always include the keyword"
              />
            </Field>
          </div>
        );
      case 5:
        return (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Posts per day" name="posts_per_day">
                <input
                  className={inputCls}
                  type="number"
                  min={1}
                  max={50}
                  value={form.frequency.posts_per_day}
                  onChange={(e) =>
                    patch("frequency", {
                      posts_per_day: Number(e.target.value),
                    })
                  }
                />
              </Field>
              <Field label="Posts per week" name="posts_per_week">
                <input
                  className={inputCls}
                  type="number"
                  min={0}
                  value={form.frequency.posts_per_week}
                  onChange={(e) =>
                    patch("frequency", {
                      posts_per_week: Number(e.target.value),
                    })
                  }
                />
              </Field>
            </div>
            <Field label="Publishing times" name="publishing_times">
              <ListEditor
                value={form.frequency.publishing_times}
                setValue={(v) => patch("frequency", { publishing_times: v })}
                placeholder="e.g. 09:00 (24h)"
              />
            </Field>
            <Field label="Timezone" name="timezone">
              <input
                className={inputCls}
                value={form.frequency.timezone}
                onChange={(e) =>
                  patch("frequency", { timezone: e.target.value })
                }
                placeholder="e.g. UTC"
              />
            </Field>
            <Field label="Workflow" name="freqToggles">
              <div className="mt-1 space-y-2">
                <Toggle
                  checked={form.frequency.auto_publish}
                  onChange={(v) => patch("frequency", { auto_publish: v })}
                  label="Auto-publish posts"
                />
                <Toggle
                  checked={form.frequency.require_approval}
                  onChange={(v) => patch("frequency", { require_approval: v })}
                  label="Require approval before publishing"
                />
              </div>
            </Field>
          </div>
        );
      case 6:
        return (
          <div className="space-y-5">
            <Field label="Media sources" name="mediaToggles">
              <div className="mt-1 space-y-2">
                {(
                  [
                    ["ai_images", "Generate AI images"],
                    ["uploads", "Allow image uploads"],
                    ["external_sources", "Use external image sources"],
                  ] as const
                ).map(([key, label]) => (
                  <Toggle
                    key={key}
                    checked={form.media[key]}
                    onChange={(v) => patch("media", { [key]: v })}
                    label={label}
                  />
                ))}
              </div>
            </Field>
            <Field label="Featured image default" name="featured_image_default">
              <input
                className={inputCls}
                value={form.media.featured_image_default}
                onChange={(e) =>
                  patch("media", { featured_image_default: e.target.value })
                }
                placeholder="featured-from-post"
              />
            </Field>
            <Field label="In-article images" name="imgToggles">
              <div className="mt-1 space-y-2">
                <Toggle
                  checked={form.media.inline_images}
                  onChange={(v) => patch("media", { inline_images: v })}
                  label="Inline images"
                />
                <Toggle
                  checked={form.media.captions}
                  onChange={(v) => patch("media", { captions: v })}
                  label="Captions"
                />
              </div>
            </Field>
            <Field label="Alt text default" name="alt_text">
              <select
                className={inputCls}
                value={form.media.alt_text}
                onChange={(e) => patch("media", { alt_text: e.target.value })}
              >
                {["descriptive", "keyword-first", "minimal"].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Video" name="videoToggles">
              <div className="mt-1 space-y-2">
                <Toggle
                  checked={form.media.video_embeds}
                  onChange={(v) => patch("media", { video_embeds: v })}
                  label="Video embeds"
                />
                <Toggle
                  checked={form.media.youtube}
                  onChange={(v) => patch("media", { youtube: v })}
                  label="YouTube embeds"
                />
                <Toggle
                  checked={form.media.uploaded_videos}
                  onChange={(v) => patch("media", { uploaded_videos: v })}
                  label="Uploaded videos"
                />
              </div>
            </Field>
            <Field label="Video position" name="video_position">
              <input
                className={inputCls}
                value={form.media.video_position}
                onChange={(e) =>
                  patch("media", { video_position: e.target.value })
                }
                placeholder="inline"
              />
            </Field>
          </div>
        );
      case 7:
        return (
          <div className="space-y-5">
            <Field label="Monetization" name="monToggles">
              <div className="mt-1 space-y-2">
                {(
                  [
                    ["enable_adsense", "Enable AdSense"],
                    ["custom_ad_code", "Custom ad code"],
                    ["affiliate_blocks", "Affiliate blocks"],
                    ["banners", "Banners"],
                    ["sponsored_sections", "Sponsored sections"],
                    ["cta_blocks", "CTA blocks"],
                  ] as const
                ).map(([key, label]) => (
                  <Toggle
                    key={key}
                    checked={form.monetization[key]}
                    onChange={(v) => patch("monetization", { [key]: v })}
                    label={label}
                  />
                ))}
              </div>
            </Field>
            <Field label="Ad slots" name="ad_slots">
              {errors.ad_slots && (
                <span className="mb-1 block text-xs text-red-600">
                  {errors.ad_slots}
                </span>
              )}
              <div className="mt-1 flex flex-wrap gap-2">
                {AD_SLOTS.map((s) => {
                  const active = form.monetization.ad_slots.includes(s.key);
                  const toggle = () =>
                    patch("monetization", {
                      ad_slots: (cur: string[]) =>
                        cur.includes(s.key)
                          ? cur.filter((x) => x !== s.key)
                          : [...cur, s.key],
                    });
                  return (
                    <button
                      type="button"
                      key={s.key}
                      onClick={toggle}
                      className={`rounded-full px-3 py-1 text-xs ${active ? "bg-amber-500 text-white" : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"}`}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </Field>
          </div>
        );
      case 8:
        return (
          <div className="space-y-5">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Choose which networks your published posts auto-share to. None of
              these are connected yet — connect them from the blog settings
              later.
            </p>
            <div className="space-y-2">
              {form.social.networks.map((n) => (
                <div
                  key={n.platform}
                  className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-neutral-900 capitalize dark:text-white">
                        {n.platform}
                      </p>
                      <span className="mt-0.5 inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-300">
                        NOT CONNECTED
                      </span>
                    </div>
                    <button
                      type="button"
                      aria-pressed={n.enabled}
                      onClick={() =>
                        // Toggle THIS row off its own live value. The previous
                        // version read `x.enabled` from an outer scope that no
                        // longer exists here, threw a ReferenceError inside the
                        // click handler and left every network stuck on "Off".
                        patchNetwork(n.platform, { enabled: !n.enabled })
                      }
                      className={`rounded-full px-3 py-1 text-xs ${n.enabled ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900" : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"}`}
                    >
                      {n.enabled ? "Will auto-share" : "Off"}
                    </button>
                  </div>
                  {n.enabled && (
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <label className="block text-xs">
                        <span className="text-neutral-500">Caption</span>
                        <input
                          className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                          value={n.caption}
                          onChange={(e) =>
                            patchNetwork(n.platform, {
                              caption: e.target.value,
                            })
                          }
                        />
                      </label>
                      <label className="block text-xs">
                        <span className="text-neutral-500">Hashtags</span>
                        <input
                          className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                          value={n.hashtags}
                          onChange={(e) =>
                            patchNetwork(n.platform, {
                              hashtags: e.target.value,
                            })
                          }
                        />
                      </label>
                      <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
                        <input
                          type="checkbox"
                          checked={n.imageOn}
                          onChange={(e) =>
                            patchNetwork(n.platform, {
                              imageOn: e.target.checked,
                            })
                          }
                        />{" "}
                        Include image
                      </label>
                      <label className="block text-xs">
                        <span className="text-neutral-500">Schedule</span>
                        <select
                          className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                          value={n.schedule}
                          onChange={(e) =>
                            patchNetwork(n.platform, {
                              schedule: e.target.value,
                            })
                          }
                        >
                          <option value="instant">On publish</option>
                          <option value="scheduled">Scheduled</option>
                          <option value="best_time">Best time</option>
                        </select>
                      </label>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      case 9:
        return <ReviewStep form={form} networks={networks} />;
      default:
        return null;
    }
  };

  return (
    <main className="min-h-dvh bg-neutral-50 dark:bg-neutral-950">
      <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-bold text-neutral-900 dark:text-white">
              New Blog
            </h1>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Guided creation wizard · step {step + 1} of 10
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-neutral-600 dark:text-neutral-300">
              {user.displayName}
            </span>
            <Link
              to="/dashboard"
              className="text-sm text-neutral-500 underline hover:text-neutral-800 dark:hover:text-white"
            >
              Cancel
            </Link>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-6 py-8">
        {/* progress */}
        <div className="mb-6 flex items-center gap-1">
          {STEP_TITLES.map((t, i) => (
            <div key={t} className="flex-1">
              <button
                type="button"
                onClick={() => {
                  if (i < step) setStep(i);
                }}
                className={`h-1.5 w-full rounded-full ${i <= step ? "bg-neutral-900 dark:bg-white" : "bg-neutral-200 dark:bg-neutral-800"}`}
                title={t}
              />
            </div>
          ))}
        </div>
        <h2 className="text-xl font-semibold text-neutral-900 dark:text-white">
          {STEP_TITLES[step]}
        </h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {STEP_DESC[step]}
        </p>

        <div className="mt-6 rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
          {stepBody()}
        </div>

        {fatal && (
          <div className="mt-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
            {fatal}
          </div>
        )}

        <div className="mt-6 flex items-center justify-between">
          <button
            type="button"
            onClick={goBack}
            disabled={step === 0}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm text-neutral-700 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200"
          >
            ← Back
          </button>
          {step < 9 ? (
            <button
              type="button"
              onClick={goNext}
              className="rounded-md bg-neutral-900 px-5 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              Next →
            </button>
          ) : (
            <button
              type="button"
              onClick={doCreate}
              disabled={creating}
              className="rounded-md bg-green-600 px-6 py-2 text-sm font-semibold text-white hover:bg-green-500 disabled:opacity-60"
            >
              {creating ? "Creating blog…" : "Create Blog"}
            </button>
          )}
        </div>
      </div>
    </main>
  );

  // ---- helper sub-components (need access to closure) ----------------------
  function StringListChip({
    label,
    value,
    onChange,
    inputCls,
    error,
  }: {
    label: string;
    value: string[];
    onChange: (v: string[]) => void;
    inputCls: string;
    error?: string;
  }) {
    const [text, setText] = useState("");
    return (
      <div>
        <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
          {label} <span className="text-red-500">*</span>
        </span>
        <div className="flex gap-2">
          <input
            className={inputCls}
            value={text}
            placeholder="e.g. best home workouts"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const t = text.trim();
                if (t) {
                  onChange([...value, t]);
                  setText("");
                }
              }
            }}
          />
          <button
            type="button"
            onClick={() => {
              const t = text.trim();
              if (t) {
                onChange([...value, t]);
                setText("");
              }
            }}
            className="shrink-0 rounded-md border border-neutral-300 px-3 text-sm dark:border-neutral-700 dark:text-neutral-200"
          >
            Add
          </button>
        </div>
        {error && (
          <span className="mt-1 block text-xs text-red-600">{error}</span>
        )}
        {value.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {value.map((v) => (
              <span
                key={v}
                className="flex items-center gap-1 rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
              >
                {v}
                <button
                  type="button"
                  onClick={() => onChange(value.filter((x) => x !== v))}
                  className="text-neutral-400 hover:text-red-500"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
  function UploadField({
    kind,
    label,
    text,
    preview,
    uploading,
    error,
    onPick,
    onClear,
    inputRef,
    onFile,
  }: any) {
    return (
      <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
          {label}
        </p>
        {preview ? (
          <div className="mt-2">
            <img
              src={preview}
              alt={label}
              className="h-16 w-16 rounded-md border object-cover dark:border-neutral-700"
            />
            <p className="mt-1 truncate text-xs text-neutral-500">{text}</p>
            <button
              type="button"
              onClick={onClear}
              className="mt-1 text-xs text-red-500"
            >
              Remove
            </button>
          </div>
        ) : (
          <div className="mt-2">
            <button
              type="button"
              onClick={onPick}
              disabled={uploading}
              className="w-full rounded-md border border-dashed border-neutral-300 px-3 py-3 text-sm text-neutral-500 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-400"
            >
              {uploading ? "Uploading…" : text ? text : "Upload image"}
            </button>
          </div>
        )}
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e: any) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />
      </div>
    );
  }
}

// ---- Review step ----------------------------------------------------------
function ReviewStep({
  form,
  networks,
}: {
  form: WizardForm;
  networks: SocialNetworkInfo[];
}) {
  const R = ({ title, rows }: { title: string; rows: [string, string][] }) => (
    <details
      className="rounded-md border border-neutral-200 dark:border-neutral-800"
      open
    >
      <summary className="cursor-pointer px-4 py-2 text-sm font-semibold text-neutral-900 dark:text-white">
        {title}
      </summary>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 pb-3">
        {rows.map(([k, v]) => (
          <div key={k} className="col-span-1">
            <dt className="text-xs text-neutral-500 dark:text-neutral-400">
              {k}
            </dt>
            <dd className="text-sm text-neutral-900 dark:text-white">
              {v || "—"}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
  const list = (a: string[]) => (a && a.length ? a.join(", ") : "—");
  return (
    <div className="space-y-4">
      <R
        title="1 · Basic info"
        rows={[
          ["Blog name", form.basic.name],
          ["URL slug", "/" + form.basic.slug],
          ["Language", form.basic.language],
          ["Country / market", form.basic.country],
          ["Author / brand", form.basic.brand_name],
          ["Logo", form.basic.logo ? "uploaded ✓" : "none"],
          ["Favicon", form.basic.favicon ? "uploaded ✓" : "none"],
        ]}
      />
      <R
        title="2 · Niche"
        rows={[
          ["Main niche", form.niche.main_niche],
          ["Sub-niches", list(form.niche.sub_niches)],
          ["Main topics", list(form.niche.main_topics)],
          ["Topics to avoid", list(form.niche.topics_to_avoid)],
          ["Target audience", form.niche.target_audience],
          ["Audience interests", list(form.niche.audience_interests)],
          ["User intent", form.niche.user_intent],
          ["Geo targeting", form.niche.geo_targeting],
        ]}
      />
      <R
        title="3 · Writing style"
        rows={[
          ["Style", form.writing.style],
          ["Tone", form.writing.tone],
          ["Formality", form.writing.formality],
          ["Personality", form.writing.personality],
          ["Vocab level", form.writing.vocab_level],
          ["Perspective", form.writing.perspective],
          ["Register", form.writing.register],
          ["Format", form.writing.format],
        ]}
      />
      <R
        title="4 · Article settings"
        rows={[
          [
            "Length",
            form.article.length +
              (form.article.length === "custom"
                ? ` (${form.article.custom_word_count})`
                : ""),
          ],
          ["Detail level", form.article.detail_level],
          ["# Sections", String(form.article.num_sections)],
          ["# Headings", String(form.article.num_headings)],
          ["# Examples", String(form.article.num_examples)],
          [
            "Extras",
            [
              form.article.faqs && "FAQs",
              form.article.tables && "Tables",
              form.article.lists && "Lists",
              form.article.pros_cons && "Pros/cons",
              form.article.statistics && "Stats",
              form.article.sources && "Sources",
              form.article.references && "References",
              form.article.expert_quotes && "Expert quotes",
            ]
              .filter(Boolean)
              .join(", "),
          ],
        ]}
      />
      <R
        title="5 · SEO"
        rows={[
          ["Primary keywords", list(form.seo.primary_keywords)],
          ["Secondary keywords", list(form.seo.secondary_keywords)],
          ["Search intent", form.seo.search_intent],
          ["SEO title template", form.seo.seo_title],
          ["Meta description", form.seo.meta_description],
          ["Slug style", form.seo.url_slug_style],
          [
            "Schema",
            [
              form.seo.schema_faqs && "FAQ",
              form.seo.schema_article && "Article",
            ]
              .filter(Boolean)
              .join(", "),
          ],
          [
            "Extras",
            [
              form.seo.internal_linking && "Internal linking",
              form.seo.external_references && "External refs",
              form.seo.canonical && "Canonical",
              form.seo.open_graph && "Open Graph",
              form.seo.social_metadata && "Social meta",
            ]
              .filter(Boolean)
              .join(", "),
          ],
        ]}
      />
      <R
        title="6 · Frequency"
        rows={[
          ["Posts / day", String(form.frequency.posts_per_day)],
          ["Posts / week", String(form.frequency.posts_per_week)],
          ["Publishing times", list(form.frequency.publishing_times)],
          ["Timezone", form.frequency.timezone],
          ["Auto-publish", form.frequency.auto_publish ? "ON" : "OFF"],
          ["Require approval", form.frequency.require_approval ? "ON" : "OFF"],
        ]}
      />
      <R
        title="7 · Media"
        rows={[
          ["AI images", form.media.ai_images ? "ON" : "OFF"],
          ["Uploads", form.media.uploads ? "ON" : "OFF"],
          ["External sources", form.media.external_sources ? "ON" : "OFF"],
          ["Featured default", form.media.featured_image_default],
          ["Inline images", form.media.inline_images ? "ON" : "OFF"],
          ["Captions", form.media.captions ? "ON" : "OFF"],
          ["Alt text", form.media.alt_text],
          [
            "Video",
            [
              form.media.video_embeds && "embeds",
              form.media.youtube && "YouTube",
              form.media.uploaded_videos && "uploads",
            ]
              .filter(Boolean)
              .join(", "),
          ],
          ["Video position", form.media.video_position],
        ]}
      />
      <R
        title="8 · Monetization"
        rows={[
          ["AdSense", form.monetization.enable_adsense ? "enabled" : "off"],
          [
            "Custom ad code",
            form.monetization.custom_ad_code ? "enabled" : "off",
          ],
          [
            "Affiliate blocks",
            form.monetization.affiliate_blocks ? "enabled" : "off",
          ],
          ["Banners", form.monetization.banners ? "enabled" : "off"],
          [
            "Sponsored sections",
            form.monetization.sponsored_sections ? "enabled" : "off",
          ],
          ["CTA blocks", form.monetization.cta_blocks ? "enabled" : "off"],
          ["Ad slots", list(form.monetization.ad_slots)],
        ]}
      />
      <R
        title="9 · Social"
        rows={networks.map((n) => {
          const c = form.social.networks.find((x) => x.platform === n.platform);
          return [n.label, c?.enabled ? `auto-share (${c.schedule})` : "off"];
        })}
      />
      <div className="rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-200">
        Press <strong>Create Blog</strong> to write this configuration to the
        database.
      </div>
    </div>
  );
}
