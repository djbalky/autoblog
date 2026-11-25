/**
 * Autonoblog — the real provider registry (Phase 6b-prep).
 *
 * One entry per external connection the platform can hold. Each entry declares
 * the fields the operator pastes, which environment variables can satisfy them,
 * and — where the vendor has a cheap authenticated endpoint — a `test()` that
 * makes a REAL HTTP call and reports the vendor's own answer.
 *
 * Honesty rules baked into this file:
 *  - `test()` never invents success. A provider without a usable endpoint has no
 *    `test` at all, and the UI then says "saved, not verified" instead.
 *  - Secrets are scrubbed out of every message before it can reach the UI or a
 *    log (some vendors echo the credential inside error bodies/URLs).
 *  - Nothing here reads or writes the database; it only validates/test values.
 */
import { scrub } from "./crypto";

export type ProviderGroup = "ai_text" | "ai_media" | "monetization" | "social";

export const GROUP_LABELS: Record<ProviderGroup, string> = {
  ai_text: "AI text models",
  ai_media: "AI media generation",
  monetization: "Monetization",
  social: "Social networks",
};

export const GROUP_ORDER: ProviderGroup[] = [
  "ai_text",
  "ai_media",
  "monetization",
  "social",
];

export interface ProviderField {
  key: string;
  label: string;
  placeholder: string;
  /** Secret fields are encrypted at rest and only ever shown masked. */
  secret: boolean;
  required: boolean;
  /** Optional server-side format check; message is shown verbatim when it fails. */
  validate?: (value: string) => string | null;
}

export interface TestOutcome {
  /** True only when the vendor really accepted the credential. */
  ok: boolean;
  /** False when this provider has no way to verify (result is honest, not success). */
  verified: boolean;
  message: string;
}

export interface ProviderDef {
  id: string;
  label: string;
  group: ProviderGroup;
  fields: ProviderField[];
  /** field key -> env var names that can supply it (first match wins). */
  envVars?: Record<string, string[]>;
  /** True when `test` performs a real authenticated call. */
  testable: boolean;
  /** Honest sentence about what is missing / what a stored value will be used for. */
  note?: string;
  test?: (values: Record<string, string>) => Promise<TestOutcome>;
}

const TIMEOUT_MS = 12_000;

interface HttpResult {
  status: number;
  body: string;
}

/** One real HTTP request; never throws, never leaks the credential. */
async function httpJson(
  url: string,
  init: RequestInit,
  secret: string
): Promise<HttpResult | { status: 0; body: string }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.text().catch(() => "");
    return { status: res.status, body: scrub(body.slice(0, 400), secret) };
  } catch {
    // The thrown error may embed the URL (and with it a query-string key), so it
    // is deliberately not surfaced — only a neutral, honest sentence is.
    return { status: 0, body: "no response (network error or timeout)" };
  }
}

function trimBody(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "empty response body";
  return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat;
}

/** Build a test that treats any 2xx as accepted and anything else as rejected. */
function makeHttpTest(opts: {
  url: (values: Record<string, string>) => string;
  init?: (values: Record<string, string>) => RequestInit;
  secretField: string;
  okMessage: (values: Record<string, string>) => string;
  rejectLabel: string;
}): (values: Record<string, string>) => Promise<TestOutcome> {
  return async (values) => {
    const secret = values[opts.secretField] ?? "";
    const res = await httpJson(
      opts.url(values),
      opts.init ? opts.init(values) : { method: "GET" },
      secret
    );
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, verified: true, message: opts.okMessage(values) };
    }
    if (res.status === 0) {
      return {
        ok: false,
        verified: true,
        message: `${opts.rejectLabel}: ${res.body} — the request never reached the provider, so the credential could not be checked.`,
      };
    }
    return {
      ok: false,
      verified: true,
      message: `${opts.rejectLabel}: HTTP ${res.status} — ${trimBody(res.body)}`,
    };
  };
}

const API_KEY_FIELD: ProviderField = {
  key: "api_key",
  label: "API key",
  placeholder: "Paste the API key",
  secret: true,
  required: true,
};

const TOKEN_FIELD = (label = "Access token"): ProviderField => ({
  key: "access_token",
  label,
  placeholder: "Paste the token",
  secret: true,
  required: true,
});

export const PROVIDERS: ProviderDef[] = [
  // ---- AI text models -----------------------------------------------------
  {
    id: "groq",
    label: "Groq",
    group: "ai_text",
    fields: [API_KEY_FIELD],
    envVars: { api_key: ["GROQ_API_KEY"] },
    testable: true,
    test: makeHttpTest({
      url: () => "https://api.groq.com/openai/v1/models",
      init: (v) => ({
        method: "GET",
        headers: { Authorization: `Bearer ${v.api_key ?? ""}` },
      }),
      secretField: "api_key",
      okMessage: () => "Groq accepted the key (GET /openai/v1/models → 200).",
      rejectLabel: "Groq rejected the key",
    }),
  },
  {
    id: "openai",
    label: "OpenAI",
    group: "ai_text",
    fields: [API_KEY_FIELD],
    envVars: { api_key: ["OPENAI_API_KEY"] },
    testable: true,
    test: makeHttpTest({
      url: () => "https://api.openai.com/v1/models",
      init: (v) => ({
        method: "GET",
        headers: { Authorization: `Bearer ${v.api_key ?? ""}` },
      }),
      secretField: "api_key",
      okMessage: () => "OpenAI accepted the key (GET /v1/models → 200).",
      rejectLabel: "OpenAI rejected the key",
    }),
  },
  {
    id: "anthropic",
    label: "Anthropic",
    group: "ai_text",
    fields: [API_KEY_FIELD],
    envVars: { api_key: ["ANTHROPIC_API_KEY"] },
    testable: true,
    test: makeHttpTest({
      url: () => "https://api.anthropic.com/v1/models",
      init: (v) => ({
        method: "GET",
        headers: {
          "x-api-key": v.api_key ?? "",
          "anthropic-version": "2023-06-01",
        },
      }),
      secretField: "api_key",
      okMessage: () => "Anthropic accepted the key (GET /v1/models → 200).",
      rejectLabel: "Anthropic rejected the key",
    }),
  },
  {
    id: "gemini",
    label: "Google Gemini",
    group: "ai_text",
    fields: [API_KEY_FIELD],
    envVars: { api_key: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] },
    testable: true,
    test: makeHttpTest({
      url: (v) =>
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
          v.api_key ?? ""
        )}`,
      secretField: "api_key",
      okMessage: () => "Google Gemini accepted the key (GET /v1beta/models → 200).",
      rejectLabel: "Google Gemini rejected the key",
    }),
  },

  // ---- AI media -----------------------------------------------------------
  // These vendors have no cheap authenticated "who am I" endpoint, so there is
  // no test: a saved value is honestly reported as "saved, not verified".
  {
    id: "fal",
    label: "fal.ai",
    group: "ai_media",
    fields: [API_KEY_FIELD],
    envVars: { api_key: ["autonblogfalai", "FAL_KEY", "FAL_API_KEY"] },
    testable: false,
    note: "Image generation key. fal.ai exposes no free identity endpoint, so this connection is stored and used by the media agent, so the connection is saved, not verified.",
  },
  {
    id: "json2video",
    label: "JSON2Video",
    group: "ai_media",
    fields: [API_KEY_FIELD],
    envVars: { api_key: ["autonblogjson2video", "JSON2VIDEO_API_KEY"] },
    testable: false,
    note: "Video generation key. No free verification endpoint — stored for the media agent: saved, not verified.",
  },
  {
    id: "revid",
    label: "Revid.ai",
    group: "ai_media",
    fields: [API_KEY_FIELD],
    envVars: { api_key: ["revidapi", "REVID_API_KEY"] },
    testable: false,
    note: "Video generation key. No free verification endpoint — stored for the media agent: saved, not verified.",
  },
  {
    id: "laya",
    label: "Laya AI",
    group: "ai_media",
    fields: [API_KEY_FIELD],
    envVars: { api_key: ["autonbloglayaai", "LAYA_API_KEY"] },
    testable: false,
    note: "Video generation key. No free verification endpoint — stored for the media agent: saved, not verified.",
  },

  // ---- Monetization -------------------------------------------------------
  {
    id: "adsense",
    label: "Google AdSense",
    group: "monetization",
    fields: [
      {
        key: "publisher_id",
        label: "Publisher ID",
        placeholder: "pub-0000000000000000",
        secret: false,
        required: true,
        validate: (value) => {
          const v = value.trim();
          if (!v) return "A publisher ID is required (it looks like pub-1234567890123456).";
          if (!/^pub-\d{10,20}$/.test(v)) {
            return "That is not an AdSense publisher ID — it must look like pub- followed by 10–20 digits.";
          }
          return null;
        },
      },
    ],
    envVars: { publisher_id: ["ADSENSE_PUBLISHER_ID"] },
    testable: false,
    note: "Format is checked here only. AdSense has no key-only endpoint, so the ID is saved but not verified — Phase 8 verifies it through the ad-serving account link.",
  },

  // ---- Social -------------------------------------------------------------
  {
    id: "x",
    label: "X (Twitter)",
    group: "social",
    fields: [TOKEN_FIELD("OAuth 2.0 user access token")],
    testable: true,
    note: "Posting needs an X developer app with write permission; paste the user access token it issues. Phase 7 publishes with it.",
    test: makeHttpTest({
      url: () => "https://api.twitter.com/2/users/me",
      init: (v) => ({
        method: "GET",
        headers: { Authorization: `Bearer ${v.access_token ?? ""}` },
      }),
      secretField: "access_token",
      okMessage: () => "X accepted the token (GET /2/users/me → 200).",
      rejectLabel: "X rejected the token",
    }),
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    group: "social",
    fields: [TOKEN_FIELD("OAuth 2.0 access token")],
    testable: true,
    note: "Posting needs a LinkedIn app with the w_member_social scope; paste the access token it issues. Phase 7 publishes with it.",
    test: makeHttpTest({
      url: () => "https://api.linkedin.com/v2/me",
      init: (v) => ({
        method: "GET",
        headers: {
          Authorization: `Bearer ${v.access_token ?? ""}`,
          "X-Restli-Protocol-Version": "2.0.0",
        },
      }),
      secretField: "access_token",
      okMessage: () => "LinkedIn accepted the token (GET /v2/me → 200).",
      rejectLabel: "LinkedIn rejected the token",
    }),
  },
  {
    id: "facebook",
    label: "Facebook Page",
    group: "social",
    fields: [TOKEN_FIELD("Page access token")],
    testable: true,
    note: "Posting needs a Facebook app + a Page access token with pages_manage_posts. Phase 7 publishes with it.",
    test: makeHttpTest({
      url: (v) =>
        `https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${encodeURIComponent(
          v.access_token ?? ""
        )}`,
      secretField: "access_token",
      okMessage: () => "Facebook accepted the token (GET /v21.0/me → 200).",
      rejectLabel: "Facebook rejected the token",
    }),
  },
  {
    id: "instagram",
    label: "Instagram",
    group: "social",
    fields: [TOKEN_FIELD("Long-lived access token")],
    testable: true,
    note: "Publishing needs an Instagram Business account linked to a Facebook app. Phase 7 publishes with the stored token.",
    test: makeHttpTest({
      url: (v) =>
        `https://graph.instagram.com/v21.0/me?fields=id,username&access_token=${encodeURIComponent(
          v.access_token ?? ""
        )}`,
      secretField: "access_token",
      okMessage: () => "Instagram accepted the token (GET /v21.0/me → 200).",
      rejectLabel: "Instagram rejected the token",
    }),
  },
  {
    id: "threads",
    label: "Threads",
    group: "social",
    fields: [TOKEN_FIELD("Threads access token")],
    testable: true,
    note: "Posting needs a Threads app with the threads_content_publish scope. Phase 7 publishes with the stored token.",
    test: makeHttpTest({
      url: (v) =>
        `https://graph.threads.net/v1.0/me?fields=id,username&access_token=${encodeURIComponent(
          v.access_token ?? ""
        )}`,
      secretField: "access_token",
      okMessage: () => "Threads accepted the token (GET /v1.0/me → 200).",
      rejectLabel: "Threads rejected the token",
    }),
  },
  {
    id: "pinterest",
    label: "Pinterest",
    group: "social",
    fields: [TOKEN_FIELD("OAuth 2.0 access token")],
    testable: true,
    note: "Pinning needs a Pinterest app with pins:write. Phase 7 publishes with the stored token.",
    test: makeHttpTest({
      url: () => "https://api.pinterest.com/v5/user_account",
      init: (v) => ({
        method: "GET",
        headers: { Authorization: `Bearer ${v.access_token ?? ""}` },
      }),
      secretField: "access_token",
      okMessage: () => "Pinterest accepted the token (GET /v5/user_account → 200).",
      rejectLabel: "Pinterest rejected the token",
    }),
  },
  {
    id: "telegram",
    label: "Telegram",
    group: "social",
    fields: [
      {
        key: "bot_token",
        label: "Bot token",
        placeholder: "123456789:AA…",
        secret: true,
        required: true,
        validate: (value) => {
          const v = value.trim();
          if (!v) return "A bot token is required.";
          if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(v)) {
            return "That does not look like a Telegram bot token (it looks like 123456789:AA…).";
          }
          return null;
        },
      },
      {
        key: "channel",
        label: "Channel / chat (optional)",
        placeholder: "@my_channel or -1001234567890",
        secret: false,
        required: false,
      },
    ],
    testable: true,
    note: "Bot tokens come from @BotFather. Phase 7 posts to the channel with this bot.",
    test: makeHttpTest({
      url: (v) =>
        `https://api.telegram.org/bot${encodeURIComponent(v.bot_token ?? "")}/getMe`,
      secretField: "bot_token",
      okMessage: () => "Telegram accepted the bot token (getMe → 200).",
      rejectLabel: "Telegram rejected the bot token",
    }),
  },
];

/** Look a provider up by id (null when unknown — callers must not guess). */
export function getProvider(id: string): ProviderDef | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

/** Providers that can serve as the text model, in priority order. */
export const TEXT_MODEL_PROVIDER_IDS = ["groq", "openai", "anthropic", "gemini"];

/**
 * Validate the values the operator submitted for one provider. Returns either a
 * field-keyed error or the trimmed values (secrets untouched apart from trim).
 */
export function validateValues(
  provider: ProviderDef,
  values: Record<string, string>,
  opts: { secretAlreadyStored: boolean }
): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
  const cleaned: Record<string, string> = {};
  for (const field of provider.fields) {
    const raw = (values[field.key] ?? "").trim();
    if (!raw && field.secret && opts.secretAlreadyStored) continue;
    if (!raw) {
      if (field.required) {
        return { ok: false, error: `${provider.label}: ${field.label} is required.` };
      }
      cleaned[field.key] = "";
      continue;
    }
    if (field.validate) {
      const problem = field.validate(raw);
      if (problem) return { ok: false, error: problem };
    }
    cleaned[field.key] = raw;
  }
  return { ok: true, values: cleaned };
}
