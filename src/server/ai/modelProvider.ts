/**
 * Autonoblog — the ONE model-provider integration point (Phase 6a).
 *
 * Every agent in the pipeline (research, writer, editor, SEO, …) needs a text
 * LLM. There is no key in this environment yet, so this module exists to answer
 * one question honestly, in one place:
 *
 *     is a text model provider configured, and if not, which env var is missing?
 *
 * Nothing in the app may claim an agent ran unless `getModelProviderState()`
 * reports `configured: true`. Phase 6b replaces the inside of `callModel()` with
 * a real HTTP call to the configured provider — the rest of the system already
 * talks to the model only through this module, so no other file has to change.
 *
 * This module deliberately performs NO network call and imports nothing, so it
 * is safe to evaluate on the server at any time (route loader, worker tick).
 */

/** The env vars that can satisfy the text-model requirement, in priority order. */
export const MODEL_PROVIDER_CANDIDATES: { envVar: string; provider: string }[] = [
  { envVar: "GROQ_API_KEY", provider: "Groq" },
  { envVar: "GEMINI_API_KEY", provider: "Google Gemini" },
  { envVar: "ONOMEO_API_KEY", provider: "onomeo" },
  { envVar: "OPENAI_API_KEY", provider: "OpenAI" },
];

/** The env var the UI names when nothing is configured (the recommended one). */
export const PRIMARY_MODEL_ENV_VAR = MODEL_PROVIDER_CANDIDATES[0].envVar;

export interface ModelProviderState {
  /** True only when one of the candidate keys is really present and non-empty. */
  configured: boolean;
  /** Which provider satisfied it ("Groq", …), null when none did. */
  provider: string | null;
  /** The env var that satisfied it, null when none did. */
  envVar: string | null;
  /** The env var the UI tells the operator to set (always a real name). */
  requiredEnvVar: string;
  /** Every env var that would work, so the UI can list the alternatives. */
  candidates: string[];
  /** One honest sentence, ready to show verbatim in the UI. */
  message: string;
}

function readEnv(name: string): string {
  const env =
    typeof process !== "undefined" && process ? process.env : undefined;
  const value = env ? env[name] : undefined;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read the environment and report the truth. Called by the automation screen,
 * the jobs screens and the worker tick — always the same answer for one process.
 */
export function getModelProviderState(): ModelProviderState {
  for (const candidate of MODEL_PROVIDER_CANDIDATES) {
    if (readEnv(candidate.envVar)) {
      return {
        configured: true,
        provider: candidate.provider,
        envVar: candidate.envVar,
        requiredEnvVar: PRIMARY_MODEL_ENV_VAR,
        candidates: MODEL_PROVIDER_CANDIDATES.map((c) => c.envVar),
        message: `AI provider configured (${candidate.provider}, via ${candidate.envVar}).`,
      };
    }
  }
  return {
    configured: false,
    provider: null,
    envVar: null,
    requiredEnvVar: PRIMARY_MODEL_ENV_VAR,
    candidates: MODEL_PROVIDER_CANDIDATES.map((c) => c.envVar),
    message: `AI provider not configured — no text model key is present. Set ${PRIMARY_MODEL_ENV_VAR} (or ${MODEL_PROVIDER_CANDIDATES.slice(1)
      .map((c) => c.envVar)
      .join(", ")}) in the environment and restart the site. Until then no agent can run and no job can progress.`,
  };
}

/** The reason string the worker and the UI use when a model is required. */
export function notConfiguredReason(): string {
  return `AI provider not configured (${PRIMARY_MODEL_ENV_VAR} missing) — jobs cannot run yet.`;
}

export type ModelCallResult =
  | { ok: true; text: string; provider: string }
  | { ok: false; notConfigured: true; reason: string };

/**
 * The single place a text completion will be requested from (Phase 6b).
 * Today it never pretends: with no provider it returns `notConfigured` and the
 * caller must show that to the user instead of inventing an agent result.
 */
export async function callModel(_prompt: string): Promise<ModelCallResult> {
  const state = getModelProviderState();
  if (!state.configured) {
    return { ok: false, notConfigured: true, reason: state.message };
  }
  // Phase 6b lands the real HTTP call here (provider + key are known above).
  return {
    ok: false,
    notConfigured: true,
    reason: `A provider key is present (${state.provider}), but the agent runner ships in Phase 6b — no model call is implemented yet, so nothing was generated.`,
  };
}
