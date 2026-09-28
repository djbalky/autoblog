/**
 * Autonoblog — server RPCs for the Phase 2 Blog Creation Wizard.
 */
import { createServerFn } from "@tanstack/react-start";
import { currentUser, requireUser } from "../auth-context";
import { ensureInitialized } from "../init";
import { uploadToStaging } from "../dal/media";
import type { UploadRef } from "../dal/media";
import {
  createBlogAndBackbone,
  validatePayload,
  slugExists,
  loadBlog,
  type WizardPayload,
} from "../dal/wizard";

export interface ActionResult<T = unknown> {
  ok: boolean;
  error?: string;
  data?: T;
}

// ---- Supported social networks + their real connection status -------------
// At wizard time there is no blog row yet, so there can be no social_accounts
// for it — every network is honestly NOT_CONNECTED. The status field is real:
// it comes back as a constant here because a brand-new blog can't be connected
// to anything yet. It is never hardcoded to "connected".
export interface SocialNetworkInfo {
  platform: string;
  label: string;
  status: "not_connected" | "connected" | "error";
}
const SOCIAL_NETWORKS: SocialNetworkInfo[] = [
  { platform: "twitter", label: "Twitter / X", status: "not_connected" },
  { platform: "facebook", label: "Facebook", status: "not_connected" },
  { platform: "linkedin", label: "LinkedIn", status: "not_connected" },
  { platform: "instagram", label: "Instagram", status: "not_connected" },
  { platform: "pinterest", label: "Pinterest", status: "not_connected" },
  { platform: "youtube", label: "YouTube", status: "not_connected" },
  { platform: "tiktok", label: "TikTok", status: "not_connected" },
  { platform: "reddit", label: "Reddit", status: "not_connected" },
  { platform: "medium", label: "Medium", status: "not_connected" },
  { platform: "gmb", label: "Google Business Profile", status: "not_connected" },
];

export const socialNetworksAction = createServerFn().handler(async () => {
  await ensureInitialized();
  await requireUser();
  return SOCIAL_NETWORKS;
});

// ---- Media upload (stage for later registration) --------------------------
interface UploadInput {
  base64: string;
  fileName: string;
}
const asUpload = (d: unknown) => d as UploadInput;
export const mediaUploadAction = createServerFn({ method: "POST" })
  .validator(asUpload)
  .handler(async ({ data }): Promise<ActionResult<UploadRef>> => {
    await ensureInitialized();
    await requireUser();
    try {
      const ref = await uploadToStaging(data.base64, data.fileName);
      return { ok: true, data: ref };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

// ---- Slug availability (for live slug checking in step 1) -----------------
interface SlugInput {
  slug: string;
}
const asSlug = (d: unknown) => d as SlugInput;
export const checkSlugAction = createServerFn({ method: "POST" })
  .validator(asSlug)
  .handler(
    async ({ data }): Promise<{ available: boolean; slug: string }> => {
      await ensureInitialized();
      await currentUser(); // non-blocking: slug check is not sensitive
      const slug = (data.slug ?? "").trim().toLowerCase();
      return { available: !(await slugExists(slug)), slug };
    }
  );

// ---- Post-create landing page ----------------------------------------------
interface BlogIdInput {
  blogId: number;
}
const asBlogId = (d: unknown) => d as BlogIdInput;
export const loadBlogLandingAction = createServerFn()
  .validator(asBlogId)
  .handler(async ({ data }) => {
    await ensureInitialized();
    const user = await currentUser(); // nullable on purpose — route redirects
    const blog = await loadBlog(Number(data.blogId));
    return { user, blog };
  });

// ---- Create Blog -----------------------------------------------------------
const asWizard = (d: unknown) => d as WizardPayload;
export const createBlogAction = createServerFn({ method: "POST" })
  .validator(asWizard)
  .handler(async ({ data }): Promise<ActionResult<Record<string, unknown>>> => {
    await ensureInitialized();
    const user = await requireUser();
    const invalid = validatePayload(data);
    if (invalid) return { ok: false, error: invalid };
    try {
      const result = await createBlogAndBackbone(data, user.id);
      return { ok: true, data: { result } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
