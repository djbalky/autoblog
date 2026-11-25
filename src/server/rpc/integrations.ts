/**
 * Autonoblog — server RPCs for the Connections hub (Phase 6b-prep).
 *
 * The operator pastes provider credentials here instead of editing server env
 * vars. Everything is real:
 *  - Save encrypts the secret (AES-256-GCM) and writes an activity row.
 *  - Test connection makes the vendor's own HTTP call and stores its answer.
 *  - Disconnect deletes the row.
 * A provider with no verification endpoint is reported as "saved, not verified"
 * — never as connected.
 *
 * Secrets never leave the server: the payload carries `••••1234` and a boolean.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireUser } from "../auth-context";
import { ensureInitialized } from "../init";
import { getBlog, type BlogRow } from "../dal/blogs";
import { getBlogMembership } from "../dal/posts";
import { logActivity } from "../dal/activity";
import {
  deleteConnection,
  getConnection,
  getDecryptedSecret,
  listConnections,
  recordTestResult,
  saveConnection,
  type ConnectionScope,
  type IntegrationRecord,
} from "../dal/integrations";
import {
  GROUP_LABELS,
  GROUP_ORDER,
  PROVIDERS,
  getProvider,
  validateValues,
  type ProviderDef,
  type ProviderGroup,
  type TestOutcome,
} from "../integrations/registry";
import { encryptionKeySource, type KeySource } from "../integrations/crypto";
import {
  resolveModelProviderState,
  type ModelProviderState,
} from "../ai/modelProvider";
import { ROLE_PERMISSIONS, type RoleName } from "../roles";

export interface ActionResult<T = unknown> {
  ok: boolean;
  error?: string;
  forbidden?: boolean;
  data?: T;
}

const NOT_MEMBER = "You are not a member of this blog.";

/** Does this blog role carry the `integration.manage` permission? */
export function canManageIntegrations(role: string): boolean {
  const perms = ROLE_PERMISSIONS[role as RoleName];
  if (!perms) return false;
  return perms.includes("*") || perms.includes("integration.manage");
}

export type CardStatus =
  | "connected"
  | "unverified"
  | "error"
  | "env"
  | "not_configured";

export const CARD_STATUS_LABELS: Record<CardStatus, string> = {
  connected: "Connected",
  unverified: "Saved, not verified",
  error: "Error",
  env: "Available from environment",
  not_configured: "Not configured",
};

export interface ConnectionFieldState {
  key: string;
  label: string;
  placeholder: string;
  secret: boolean;
  required: boolean;
  /** Non-secret fields only — a secret value is never serialized. */
  value: string;
}

export interface ConnectionCardState {
  provider: string;
  label: string;
  group: ProviderGroup;
  groupLabel: string;
  fields: ConnectionFieldState[];
  status: CardStatus;
  statusLabel: string;
  /** `••••1234` when a secret is stored, otherwise "". */
  hint: string;
  hasSecret: boolean;
  testable: boolean;
  note: string;
  /** Environment fallback: which env var supplies this provider, if any. */
  envVar: string | null;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string;
  connectedAt: string | null;
}

export interface ConnectionGroupState {
  group: ProviderGroup;
  label: string;
  cards: ConnectionCardState[];
}

export interface ConnectionsPageData {
  forbidden: boolean;
  scopeKind: "workspace" | "blog";
  blog: Pick<BlogRow, "id" | "name" | "slug"> | null;
  role: string | null;
  canManage: boolean;
  groups: ConnectionGroupState[];
  /** Where the encryption key comes from (never the key itself). */
  encryptionSource: KeySource;
  /** The text-model state that the Automation/Jobs banners read. */
  provider: ModelProviderState;
}

function envVarFor(def: ProviderDef): string | null {
  const map = def.envVars ?? {};
  for (const names of Object.values(map)) {
    for (const name of names) {
      const value = process.env[name];
      if (typeof value === "string" && value.trim()) return name;
    }
  }
  return null;
}

function cardFor(
  def: ProviderDef,
  row: IntegrationRecord | null
): ConnectionCardState {
  const envVar = envVarFor(def);
  let status: CardStatus;
  if (!row) {
    status = envVar ? "env" : "not_configured";
  } else if (row.hasSecret) {
    status =
      row.status === "connected"
        ? "connected"
        : row.status === "error"
          ? "error"
          : "unverified";
  } else if (row.status === "connected" || row.status === "error") {
    status = row.status;
  } else if (Object.values(row.config).some((v) => v.trim())) {
    // e.g. an AdSense publisher id: saved and format-checked, never verified.
    status = "unverified";
  } else {
    status = envVar ? "env" : "not_configured";
  }

  return {
    provider: def.id,
    label: def.label,
    group: def.group,
    groupLabel: GROUP_LABELS[def.group],
    fields: def.fields.map((field) => ({
      key: field.key,
      label: field.label,
      placeholder: field.placeholder,
      secret: field.secret,
      required: field.required,
      value: field.secret ? "" : (row?.config[field.key] ?? ""),
    })),
    status,
    statusLabel: CARD_STATUS_LABELS[status],
    hint: row?.secretHint ?? "",
    hasSecret: row?.hasSecret ?? false,
    testable: def.testable,
    note: def.note ?? "",
    envVar,
    lastTestedAt: row?.lastTestedAt ?? null,
    lastTestOk: row?.lastTestOk ?? null,
    lastTestMessage: row?.lastTestMessage ?? "",
    connectedAt: row?.connectedAt ?? null,
  };
}

function buildGroups(rows: IntegrationRecord[]): ConnectionGroupState[] {
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  return GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    cards: PROVIDERS.filter((def) => def.group === group).map((def) =>
      cardFor(def, byProvider.get(def.id) ?? null)
    ),
  }));
}

// ---- Load -----------------------------------------------------------------

interface ScopeInput {
  blogId?: number | null;
}
const asScope = (d: unknown) => d as ScopeInput;

interface ResolvedScope {
  forbidden: boolean;
  scope: ConnectionScope;
  blog: Pick<BlogRow, "id" | "name" | "slug"> | null;
  role: string | null;
  canManage: boolean;
  scopeKind: "workspace" | "blog";
}

/**
 * Resolve the caller's scope: workspace = the signed-in user's own connections
 * (always allowed); blog = membership + the integration.manage permission.
 */
async function resolveScope(
  userId: number,
  blogId: number | null | undefined
): Promise<ResolvedScope> {
  const wanted = Number(blogId ?? 0);
  if (!Number.isFinite(wanted) || wanted <= 0) {
    return {
      forbidden: false,
      scope: { kind: "workspace", id: userId },
      blog: null,
      role: null,
      canManage: true,
      scopeKind: "workspace",
    };
  }
  const blog = await getBlog(wanted);
  if (!blog) {
    return {
      forbidden: true,
      scope: { kind: "blog", id: wanted },
      blog: null,
      role: null,
      canManage: false,
      scopeKind: "blog",
    };
  }
  const membership = await getBlogMembership(wanted, userId);
  if (!membership) {
    return {
      forbidden: true,
      scope: { kind: "blog", id: wanted },
      blog: { id: blog.id, name: blog.name, slug: blog.slug },
      role: null,
      canManage: false,
      scopeKind: "blog",
    };
  }
  return {
    forbidden: false,
    scope: { kind: "blog", id: wanted },
    blog: { id: blog.id, name: blog.name, slug: blog.slug },
    role: membership.role,
    canManage: canManageIntegrations(membership.role),
    scopeKind: "blog",
  };
}

/** Resolve the text-model state for whichever scope the caller is editing. */
async function resolveProviderForScope(
  resolved: ResolvedScope,
  userId: number
): Promise<ModelProviderState> {
  return resolved.scopeKind === "blog"
    ? resolveModelProviderState({ blogId: resolved.scope.id })
    : resolveModelProviderState({ workspaceUserId: userId });
}

export const connectionsLoadAction = createServerFn()
  .validator(asScope)
  .handler(async ({ data }): Promise<ConnectionsPageData> => {
    await ensureInitialized();
    const user = await requireUser();
    const resolved = await resolveScope(user.id, data?.blogId);
    const provider = await resolveProviderForScope(resolved, user.id);
    if (resolved.forbidden) {
      return {
        forbidden: true,
        scopeKind: resolved.scopeKind,
        blog: resolved.blog,
        role: null,
        canManage: false,
        groups: [],
        encryptionSource: encryptionKeySource(),
        provider,
      };
    }
    const rows = await listConnections(resolved.scope);
    return {
      forbidden: false,
      scopeKind: resolved.scopeKind,
      blog: resolved.blog,
      role: resolved.role,
      canManage: resolved.canManage,
      groups: buildGroups(rows),
      encryptionSource: encryptionKeySource(),
      provider,
    };
  });

// ---- Save -----------------------------------------------------------------

interface SaveInput {
  blogId?: number | null;
  provider: string;
  values: Record<string, string>;
}
const asSave = (d: unknown) => d as SaveInput;

export interface ConnectionMutationResult {
  card: ConnectionCardState;
  /** Refreshed text-model state so banners can update without a reload. */
  provider: ModelProviderState;
}

export const saveConnectionAction = createServerFn({ method: "POST" })
  .validator(asSave)
  .handler(
    async ({ data }): Promise<ActionResult<ConnectionMutationResult>> => {
      await ensureInitialized();
      const user = await requireUser();
      const resolved = await resolveScope(user.id, data?.blogId);
      if (resolved.forbidden) {
        return { ok: false, forbidden: true, error: NOT_MEMBER };
      }
      if (!resolved.canManage) {
        return {
          ok: false,
          forbidden: true,
          error: `Your role (${resolved.role}) cannot change connections — that needs the integration.manage permission (owner or administrator).`,
        };
      }
      const def = getProvider(String(data?.provider ?? ""));
      if (!def) return { ok: false, error: "Unknown provider." };

      const existingSecret = await getDecryptedSecret(resolved.scope, def.id);
      const validated = validateValues(def, data?.values ?? {}, {
        secretAlreadyStored: existingSecret !== null,
      });
      if (!validated.ok) return { ok: false, error: validated.error };

      const config: Record<string, string> = {};
      let secret: string | null = null;
      for (const field of def.fields) {
        const value = validated.values[field.key] ?? "";
        if (field.secret) {
          if (value) secret = value;
        } else {
          config[field.key] = value;
        }
      }

      const saved = await saveConnection({
        scope: resolved.scope,
        provider: def.id,
        label: def.label,
        config,
        secret,
        userId: user.id,
      });

      await logActivity({
        userId: user.id,
        blogId: resolved.scope.kind === "blog" ? resolved.scope.id : null,
        action: "integration.saved",
        entityType: "integration",
        entityId: saved.id,
        detail: `${def.id} saved in the ${resolved.scope.kind} scope${
          saved.hasSecret ? ` (secret ${saved.secretHint})` : ""
        } — status ${saved.status}.`,
      });

      return {
        ok: true,
        data: {
          card: cardFor(def, saved),
          provider: await resolveProviderForScope(resolved, user.id),
        },
      };
    }
  );

// ---- Test -----------------------------------------------------------------

interface TestInput {
  blogId?: number | null;
  provider: string;
}
const asTest = (d: unknown) => d as TestInput;

export interface ConnectionTestResult extends ConnectionMutationResult {
  /** True only when the vendor really accepted the credential. */
  verified: boolean;
  ok: boolean;
  message: string;
}

export const testConnectionAction = createServerFn({ method: "POST" })
  .validator(asTest)
  .handler(async ({ data }): Promise<ActionResult<ConnectionTestResult>> => {
    await ensureInitialized();
    const user = await requireUser();
    const resolved = await resolveScope(user.id, data?.blogId);
    if (resolved.forbidden) {
      return { ok: false, forbidden: true, error: NOT_MEMBER };
    }
    if (!resolved.canManage) {
      return {
        ok: false,
        forbidden: true,
        error: `Your role (${resolved.role}) cannot test connections — that needs the integration.manage permission (owner or administrator).`,
      };
    }
    const def = getProvider(String(data?.provider ?? ""));
    if (!def) return { ok: false, error: "Unknown provider." };

    const row = await getConnection(resolved.scope, def.id);
    if (!row) {
      return {
        ok: false,
        error: `Save a credential for ${def.label} first — there is nothing to test yet.`,
      };
    }

    // Assemble the values the test needs; the secret never leaves the server.
    const secret = await getDecryptedSecret(resolved.scope, def.id);
    const values: Record<string, string> = {};
    for (const field of def.fields) {
      values[field.key] = field.secret
        ? (secret ?? "")
        : (row.config[field.key] ?? "");
    }
    const missing = def.fields.find(
      (field) => field.required && !(values[field.key] ?? "").trim()
    );
    if (missing) {
      return {
        ok: false,
        error: `${def.label}: ${missing.label} is not saved, so the connection cannot be tested.`,
      };
    }

    let outcome: TestOutcome;
    if (def.test) {
      outcome = await def.test(values);
    } else {
      outcome = {
        ok: false,
        verified: false,
        message:
          def.note ??
          `${def.label} has no verification endpoint, so this connection is saved but not verified.`,
      };
    }

    const updated = await recordTestResult(resolved.scope, def.id, outcome);

    await logActivity({
      userId: user.id,
      blogId: resolved.scope.kind === "blog" ? resolved.scope.id : null,
      action: "integration.tested",
      entityType: "integration",
      entityId: row.id,
      detail: `${def.id} test: ${
        outcome.verified ? (outcome.ok ? "accepted by the provider" : "rejected by the provider") : "not verifiable"
      } — ${outcome.message}`.slice(0, 500),
    });

    return {
      ok: true,
      data: {
        card: cardFor(def, updated ?? row),
        provider: await resolveProviderForScope(resolved, user.id),
        verified: outcome.verified,
        ok: outcome.ok,
        message: outcome.message,
      },
    };
  });

// ---- Disconnect -----------------------------------------------------------

interface DisconnectInput {
  blogId?: number | null;
  provider: string;
}
const asDisconnect = (d: unknown) => d as DisconnectInput;

export const disconnectConnectionAction = createServerFn({ method: "POST" })
  .validator(asDisconnect)
  .handler(
    async ({ data }): Promise<ActionResult<ConnectionMutationResult>> => {
      await ensureInitialized();
      const user = await requireUser();
      const resolved = await resolveScope(user.id, data?.blogId);
      if (resolved.forbidden) {
        return { ok: false, forbidden: true, error: NOT_MEMBER };
      }
      if (!resolved.canManage) {
        return {
          ok: false,
          forbidden: true,
          error: `Your role (${resolved.role}) cannot remove connections — that needs the integration.manage permission (owner or administrator).`,
        };
      }
      const def = getProvider(String(data?.provider ?? ""));
      if (!def) return { ok: false, error: "Unknown provider." };

      const row = await getConnection(resolved.scope, def.id);
      const removed = await deleteConnection(resolved.scope, def.id);
      if (!removed || !row) {
        return { ok: false, error: `${def.label} has no saved connection to remove.` };
      }

      await logActivity({
        userId: user.id,
        blogId: resolved.scope.kind === "blog" ? resolved.scope.id : null,
        action: "integration.disconnected",
        entityType: "integration",
        entityId: row.id,
        detail: `${def.id} removed from the ${resolved.scope.kind} scope.`,
      });

      return {
        ok: true,
        data: {
          card: cardFor(def, null),
          provider: await resolveProviderForScope(resolved, user.id),
        },
      };
    }
  );
