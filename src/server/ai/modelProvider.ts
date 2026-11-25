/**
 * Autonoblog — the ONE model-provider integration point (Phase 6a + 6b-prep).
 *
 * Every agent in the pipeline (research, writer, editor, SEO, …) needs a text
 * LLM. This module answers, honestly and in one place:
 *
 *     is a text model provider available, WHERE does its key come from, and if
 *     not, which env var (or Connections card) is missing?
 *
 * Resolution order (Phase 6b-prep): the Connections screen is authoritative —
 *   1. a blog-scoped connection saved for this blog,
 *   2. a workspace-scoped connection saved by the blog's owner,
 *   3. the matching environment variable (GROQ_API_KEY, …).
 * The DB is read on every call, so connecting a provider in the UI takes effect
 * on the next scheduler tick without a restart.
 *
 * Nothing in the app may claim an agent ran unless this module reports
 * `configured: true`. No key is ever returned to the browser: `resolveModelKey`
 * is server-only and its `apiKey` field must not cross a server-function
 * boundary.
 */
import {
  getDecryptedSecret,
  getBlogOwnerId,
  listConnectionsForProviders,
  type ConnectionScope,
} from "../dal/integrations";
import {
  getProvider,
  TEXT_MODEL_PROVIDER_IDS,
} from "../integrations/registry";

/** The env vars that can satisfy the text-model requirement, in priority order. */
export const MODEL_PROVIDER_CANDIDATES: { envVar: string; provider: string }[] = [
  { envVar: "GROQ_API_KEY", provider: "Groq" },
  { envVar: "GEMINI_API_KEY", provider: "Google Gemini" },
  { envVar: "ONOMEO_API_KEY", provider: "onomeo" },
  { envVar: "OPENAI_API_KEY", provider: "OpenAI" },
  { envVar: "ANTHROPIC_API_KEY", provider: "Anthropic" },
];

/** The env var the UI names when nothing is configured (the recommended one). */
export const PRIMARY_MODEL_ENV_VAR = MODEL_PROVIDER_CANDIDATES[0].envVar;

export type ModelProviderSource = "database" | "environment" | null;

export interface ModelProviderState {
  /** True only when a key is really available (saved in Connections or in env). */
  configured: boolean;
  /** Which provider satisfied it ("Groq", …), null when none did. */
  provider: string | null;
  /** The provider registry id ("groq", …), null when none did. */
  providerId: string | null;
  /** Where the key came from — drives the banner wording. */
  source: ModelProviderSource;
  /** Human sentence for the source, e.g. "workspace connection saved in Connections". */
  sourceLabel: string;
  /** The env var that satisfied it (environment source only), else null. */
  envVar: string | null;
  /** The env var the UI tells the operator to set (always a real name). */
  requiredEnvVar: string;
  /** Every env var that would work, so the UI can list the alternatives. */
  candidates: string[];
  /** One honest sentence, ready to show verbatim in the UI. */
  message: string;
}

export interface ModelKeyResolution {
  ok: boolean;
  /** Server-only: never send this to the browser. */
  apiKey: string | null;
  providerId: string | null;
  providerLabel: string | null;
  source: ModelProviderSource;
  sourceLabel: string;
  reason: string;
}

function readEnv(name: string): string {
  const env =
    typeof process !== "undefined" && process ? process.env : undefined;
  const value = env ? env[name] : undefined;
  return typeof value === "string" ? value.trim() : "";
}

/** The env var that supplies a given registry provider's key, if any. */
function envVarForProvider(providerId: string): string | null {
  const def = getProvider(providerId);
  const names = def?.envVars?.api_key ?? [];
  for (const name of names) {
    if (readEnv(name)) return name;
  }
  return null;
}

function notConfiguredState(): ModelProviderState {
  return {
    configured: false,
    provider: null,
    providerId: null,
    source: null,
    sourceLabel: "not configured",
    envVar: null,
    requiredEnvVar: PRIMARY_MODEL_ENV_VAR,
    candidates: MODEL_PROVIDER_CANDIDATES.map((c) => c.envVar),
    message: `AI provider not configured — no text model key is available. Connect one on the Connections screen (AI text models), or set ${PRIMARY_MODEL_ENV_VAR} in the environment. Until then no agent can run and no job can progress.`,
  };
}

/**
 * Resolve the text-model key, reading the Connections rows first and the
 * environment second. `blogId` narrows the search to that blog's connections
 * plus its owner's workspace connections.
 */
export async function resolveModelKey(opts?: {
  blogId?: number | null;
  /** The signed-in user's workspace, for the workspace Connections screen. */
  workspaceUserId?: number | null;
}): Promise<ModelKeyResolution> {
  const blogId = Number(opts?.blogId ?? 0);
  const workspaceUserId = Number(opts?.workspaceUserId ?? 0);

  // 1. Blog-scoped connection, then 2. the workspace connection (of the blog's
  // owner, or of the signed-in user when no blog is in play).
  const scopes: { scope: ConnectionScope; label: string }[] = [];
  if (Number.isFinite(blogId) && blogId > 0) {
    scopes.push({
      scope: { kind: "blog", id: blogId },
      label: "saved for this blog in Connections",
    });
  }
  const ownerId =
    Number.isFinite(workspaceUserId) && workspaceUserId > 0
      ? workspaceUserId
      : Number.isFinite(blogId) && blogId > 0
        ? await getBlogOwnerId(blogId)
        : null;
  if (ownerId) {
    scopes.push({
      scope: { kind: "workspace", id: ownerId },
      label: "saved in the workspace Connections",
    });
  }

  for (const { scope, label } of scopes) {
    const rows = await listConnectionsForProviders(scope, TEXT_MODEL_PROVIDER_IDS);
    // Priority: registry order (groq, openai, anthropic, gemini).
    for (const providerId of TEXT_MODEL_PROVIDER_IDS) {
      const row = rows.find((r) => r.provider === providerId && r.hasSecret);
      if (!row) continue;
      const apiKey = await getDecryptedSecret(scope, providerId);
      if (!apiKey) continue;
      const def = getProvider(providerId);
      return {
        ok: true,
        apiKey,
        providerId,
        providerLabel: def?.label ?? providerId,
        source: "database",
        sourceLabel: label,
        reason: "",
      };
    }
  }

  // 3. Environment variable.
  for (const candidate of MODEL_PROVIDER_CANDIDATES) {
    const value = readEnv(candidate.envVar);
    if (!value) continue;
    const providerId =
      TEXT_MODEL_PROVIDER_IDS.find(
        (id) => (getProvider(id)?.envVars?.api_key ?? []).includes(candidate.envVar)
      ) ?? null;
    return {
      ok: true,
      apiKey: value,
      providerId,
      providerLabel: candidate.provider,
      source: "environment",
      sourceLabel: `${candidate.envVar} in the environment`,
      reason: "",
    };
  }

  const state = notConfiguredState();
  return {
    ok: false,
    apiKey: null,
    providerId: null,
    providerLabel: null,
    source: null,
    sourceLabel: "not configured",
    reason: state.message,
  };
}

/** The browser-safe provider state (no key), read fresh from DB + env. */
export async function resolveModelProviderState(opts?: {
  blogId?: number | null;
  workspaceUserId?: number | null;
}): Promise<ModelProviderState> {
  const resolved = await resolveModelKey(opts);
  if (!resolved.ok) return notConfiguredState();
  const envVar =
    resolved.source === "environment"
      ? MODEL_PROVIDER_CANDIDATES.find((c) =>
          readEnv(c.envVar)
        )?.envVar ?? null
      : null;
  const message =
    resolved.source === "database"
      ? `AI provider configured — ${resolved.providerLabel} key ${resolved.sourceLabel}.`
      : `AI provider configured — ${resolved.providerLabel} key from ${resolved.sourceLabel}.`;
  return {
    configured: true,
    provider: resolved.providerLabel,
    providerId: resolved.providerId,
    source: resolved.source,
    sourceLabel: resolved.sourceLabel,
    envVar,
    requiredEnvVar: PRIMARY_MODEL_ENV_VAR,
    candidates: MODEL_PROVIDER_CANDIDATES.map((c) => c.envVar),
    message,
  };
}

/** The reason string the worker and the UI use when a model is required. */
export function notConfiguredReason(): string {
  return `AI provider not configured — connect a text model on the Connections screen or set ${PRIMARY_MODEL_ENV_VAR}. Jobs cannot run yet.`;
}

export type ModelCallResult =
  | { ok: true; text: string; provider: string }
  | { ok: false; notConfigured: true; reason: string };

/**
 * The single place a text completion will be requested from (Phase 6b).
 * Today it never pretends: with no provider it returns `notConfigured`, and
 * with a provider it says the agent runner is not shipped yet — it never
 * fabricates a completion.
 */
export async function callModel(
  _prompt: string,
  opts?: { blogId?: number | null; workspaceUserId?: number | null }
): Promise<ModelCallResult> {
  const resolved = await resolveModelKey(opts);
  if (!resolved.ok) {
    return { ok: false, notConfigured: true, reason: resolved.reason };
  }
  return {
    ok: false,
    notConfigured: true,
    reason: `A ${resolved.providerLabel} key is available (${resolved.sourceLabel}), but the agent runner ships in Phase 6b — no model call is implemented yet, so nothing was generated.`,
  };
}

/** Is any text-model env var present? (Used by env-only health checks.) */
export function hasEnvModelKey(): boolean {
  return MODEL_PROVIDER_CANDIDATES.some((c) => readEnv(c.envVar) !== "");
}

/** Env var name for a registry provider, for the Connections UI. */
export function providerEnvVar(providerId: string): string | null {
  return envVarForProvider(providerId);
}
