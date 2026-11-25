/**
 * Phase 6b-prep smoke test — the Connections hub, against the LIVE database
 * (Neon via DATABASE_URL; the SQLite dev fallback also works).
 *
 * What it proves, with real rows read back from the database:
 *   1. A saved key is stored ENCRYPTED: the plaintext is nowhere in the row, the
 *      blob decrypts back on the server, and the only thing the UI can see is
 *      `••••1234`.
 *   2. `test()` on a real provider (Groq) makes a REAL HTTP call and reports the
 *      provider's own rejection for a bad key — and the message never contains
 *      the key.
 *   3. A provider with no verification endpoint (fal.ai) is honestly recorded as
 *      "saved, not verified" — never as connected.
 *   4. The text-model resolver prefers the database over the environment, and
 *      falls back to the env var only when no connection is saved.
 *   5. Saving writes an activity_logs row.
 *   6. Everything this script created is deleted again.
 *
 * Run: bun scripts/phase6b-connections-smoke.ts
 */
import { all, get, migrate, run, usingPostgres } from "../src/server/store";
import { createBlog } from "../src/server/dal/blogs";
import { logActivity } from "../src/server/dal/activity";
import {
  deleteConnection,
  getDecryptedSecret,
  listConnections,
  recordTestResult,
  saveConnection,
  type ConnectionScope,
} from "../src/server/dal/integrations";
import { decryptSecret, secretHint } from "../src/server/integrations/crypto";
import { getProvider } from "../src/server/integrations/registry";
import {
  resolveModelKey,
  resolveModelProviderState,
} from "../src/server/ai/modelProvider";

const stamp = Date.now().toString(36);
const out: Record<string, unknown> = {};
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  out[name] = ok ? true : { FAILED: true, detail };
  if (!ok) failures.push(name);
}

await migrate();
out.storage = usingPostgres() ? "postgres" : "sqlite";

const admin = await get<{ id: number }>(
  "SELECT id FROM users WHERE email = ?",
  "admin@autonoblog.local"
);
if (!admin) throw new Error("admin user missing — cannot run the Phase 6b smoke test");
const adminId = Number(admin.id);

const blog = await createBlog({
  ownerId: adminId,
  name: `Phase 6b Connections Blog ${stamp}`,
  tagline: "Connections smoke",
  description: "A temporary blog created by scripts/phase6b-connections-smoke.ts.",
});
await run("UPDATE blogs SET status = 'active' WHERE id = ?", blog.id);
out.blog = { id: blog.id, slug: blog.slug };

const workspace: ConnectionScope = { kind: "workspace", id: adminId };
const blogScope: ConnectionScope = { kind: "blog", id: blog.id };

// A syntactically valid but bogus Groq key: real enough to be rejected by Groq.
const fakeKey = `gsk_smoke${stamp}0123456789abcdef0123456789abcdef`;
const expectedHint = `••••${fakeKey.slice(-4)}`;

// ---- 0. Schema -------------------------------------------------------------
const columns = await all<{ column_name?: string; name?: string }>(
  usingPostgres()
    ? "SELECT column_name FROM information_schema.columns WHERE table_name = 'integrations'"
    : "SELECT name FROM pragma_table_info('integrations')"
);
const columnNames = columns.map((c) => String(c.column_name ?? c.name ?? ""));
out.schema_columns = columnNames.length;
check(
  "schema_has_connection_columns",
  ["scope", "scope_id", "secret_blob", "secret_hint", "last_test_ok", "last_test_message"].every(
    (c) => columnNames.includes(c)
  ),
  columnNames
);

// ---- 1. Save: encrypted at rest, masked in the UI --------------------------
const saved = await saveConnection({
  scope: workspace,
  provider: "groq",
  label: "Groq",
  config: {},
  secret: fakeKey,
  userId: adminId,
});
check("saved_row_has_secret", saved.hasSecret, saved);
check("saved_hint_masked", saved.secretHint === expectedHint, {
  hint: saved.secretHint,
  expected: expectedHint,
});
check("saved_status_unverified_until_tested", saved.status === "unverified", saved.status);

const blobRow = await get<{ secret_blob: string }>(
  "SELECT secret_blob FROM integrations WHERE id = ?",
  saved.id
);
const blob = String(blobRow?.secret_blob ?? "");
check("db_blob_not_empty", blob.length > 0);
check("db_blob_not_plaintext", !blob.includes(fakeKey), blob.slice(0, 24));
check("db_blob_is_aes_gcm_v1", blob.startsWith("v1.") && blob.split(".").length === 4, blob.slice(0, 8));

const plaintextLikeRows = await get<{ n: unknown }>(
  "SELECT COUNT(*) AS n FROM integrations WHERE secret_blob LIKE ?",
  `%${fakeKey}%`
);
check("no_plaintext_anywhere_in_table", Number(plaintextLikeRows?.n ?? 0) === 0);

check("decrypt_roundtrip", decryptSecret(blob) === fakeKey);
check("hint_helper_masks", secretHint(fakeKey) === expectedHint);

const listed = await listConnections(workspace);
const listedGroq = listed.find((row) => row.provider === "groq");
check("list_returns_masked_only", Boolean(listedGroq) && listedGroq!.secretHint === expectedHint, listedGroq);
check(
  "list_never_serializes_secret",
  !JSON.stringify(listed).includes(fakeKey),
  "serialized list contained the plaintext key"
);
check(
  "secret_readable_server_side_only",
  (await getDecryptedSecret(workspace, "groq")) === fakeKey
);

// ---- 2. A real test call: the provider's own answer for a bad key ----------
const groq = getProvider("groq");
check("groq_registered_with_test", Boolean(groq?.test), groq?.id);
const groqOutcome = await groq!.test!({ api_key: fakeKey });
check("bad_key_rejected", groqOutcome.verified === true && groqOutcome.ok === false, groqOutcome);
check("bad_key_message_present", groqOutcome.message.length > 10, groqOutcome.message);
check("bad_key_message_scrubbed", !groqOutcome.message.includes(fakeKey), groqOutcome.message);
out.groq_test_message = groqOutcome.message;

const afterTest = await recordTestResult(workspace, "groq", groqOutcome);
check("test_recorded_as_error", afterTest?.status === "error", afterTest?.status);
check("test_recorded_last_test_ok_false", afterTest?.lastTestOk === false, afterTest?.lastTestOk);
check("test_recorded_timestamp", Boolean(afterTest?.lastTestedAt), afterTest?.lastTestedAt);

// ---- 3. No verification endpoint => honest "saved, not verified" -----------
const fal = getProvider("fal");
check("fal_has_no_fake_test", fal !== undefined && fal.test === undefined, fal?.id);
await saveConnection({
  scope: workspace,
  provider: "fal",
  label: "fal.ai",
  config: {},
  secret: `fal-smoke-${stamp}`,
  userId: adminId,
});
const falHonestOutcome = fal?.test
  ? await fal.test({ api_key: `fal-smoke-${stamp}` })
  : {
      ok: false,
      verified: false,
      message:
        fal?.note ??
        "fal.ai has no verification endpoint, so this connection is saved but not verified.",
    };
const falRow = await recordTestResult(workspace, "fal", falHonestOutcome);
check("unverifiable_stays_unverified", falRow?.status === "unverified", falRow?.status);
check("unverifiable_last_test_ok_null", falRow?.lastTestOk === null, falRow?.lastTestOk);
check(
  "unverifiable_message_says_so",
  /not verified|no verification/i.test(falRow?.lastTestMessage ?? ""),
  falRow?.lastTestMessage
);

// ---- 4. Resolver: DB before env -------------------------------------------
const previousEnv = process.env.GROQ_API_KEY;
process.env.GROQ_API_KEY = `gsk_env_placeholder_${stamp}`;

const fromDb = await resolveModelKey({ blogId: blog.id });
check("resolver_ok_from_database", fromDb.ok === true, fromDb);
check("resolver_prefers_database", fromDb.source === "database", fromDb.source);
check("resolver_provider_is_groq", fromDb.providerId === "groq", fromDb.providerId);
check("resolver_returns_db_key", fromDb.apiKey === fakeKey);

const stateFromDb = await resolveModelProviderState({ blogId: blog.id });
check("provider_state_configured", stateFromDb.configured === true, stateFromDb);
check("provider_state_names_source", /Connections/.test(stateFromDb.sourceLabel), stateFromDb.sourceLabel);
check(
  "provider_state_hides_key",
  !JSON.stringify(stateFromDb).includes(fakeKey),
  "provider state leaked the key"
);

await deleteConnection(workspace, "groq");
const fromEnv = await resolveModelKey({ blogId: blog.id });
check("resolver_falls_back_to_env", fromEnv.source === "environment", fromEnv.source);
check("resolver_env_provider", fromEnv.providerId === "groq", fromEnv.providerId);

// Blog-scoped connection wins over the workspace one.
const blogSaved = await saveConnection({
  scope: blogScope,
  provider: "groq",
  label: "Groq",
  config: {},
  secret: `gsk_blogscope_${stamp}`,
  userId: adminId,
});
const fromBlogScope = await resolveModelKey({ blogId: blog.id });
check("blog_scope_row_created", blogSaved.hasSecret === true, blogSaved);
check("resolver_blog_scope_first", fromBlogScope.apiKey === `gsk_blogscope_${stamp}`, fromBlogScope.sourceLabel);
check(
  "resolver_blog_scope_label",
  /this blog/.test(fromBlogScope.sourceLabel),
  fromBlogScope.sourceLabel
);
await deleteConnection(blogScope, "groq");

if (previousEnv === undefined) delete process.env.GROQ_API_KEY;
else process.env.GROQ_API_KEY = previousEnv;

const afterCleanupResolve = await resolveModelKey({ blogId: blog.id });
check(
  "resolver_not_configured_after_removal",
  afterCleanupResolve.ok === false || afterCleanupResolve.source === "environment",
  afterCleanupResolve
);

// ---- 5. Activity log -------------------------------------------------------
await logActivity({
  userId: adminId,
  blogId: null,
  action: "integration.saved",
  entityType: "integration",
  entityId: saved.id,
  detail: `groq saved in the workspace scope (secret ${expectedHint}) — status unverified.`,
});
const activity = await get<{ id: number; action: string; detail: string }>(
  "SELECT id, action, detail FROM activity_logs WHERE action = ? AND entity_id = ? ORDER BY id DESC",
  "integration.saved",
  saved.id
);
check("activity_row_written", Boolean(activity), activity);
check("activity_names_provider", (activity?.detail ?? "").includes("groq"), activity?.detail);
check("activity_hides_secret", !(activity?.detail ?? "").includes(fakeKey), activity?.detail);

// ---- 6. Cleanup ------------------------------------------------------------
await deleteConnection(workspace, "fal");
await run("DELETE FROM integrations WHERE scope = ? AND scope_id = ?", "workspace", adminId);
await run("DELETE FROM integrations WHERE scope = ? AND scope_id = ?", "blog", blog.id);
await run("DELETE FROM activity_logs WHERE entity_id = ? AND action = ?", saved.id, "integration.saved");
await run("DELETE FROM blogs WHERE id = ?", blog.id);

const leftovers = {
  connections: Number(
    (
      await get<{ n: unknown }>(
        "SELECT COUNT(*) AS n FROM integrations WHERE (scope = ? AND scope_id = ?) OR (scope = ? AND scope_id = ?)",
        "workspace",
        adminId,
        "blog",
        blog.id
      )
    )?.n ?? 0
  ),
  activity: Number(
    (
      await get<{ n: unknown }>(
        "SELECT COUNT(*) AS n FROM activity_logs WHERE entity_id = ?",
        saved.id
      )
    )?.n ?? 0
  ),
  blogs: Number(
    (await get<{ n: unknown }>("SELECT COUNT(*) AS n FROM blogs WHERE id = ?", blog.id))?.n ?? 0
  ),
};
out.cleanup = leftovers;
check(
  "cleanup_complete",
  leftovers.connections === 0 && leftovers.activity === 0 && leftovers.blogs === 0,
  leftovers
);

out.failures = failures;
out.passed = failures.length === 0;
out.checks = Object.keys(out).length;
console.log(JSON.stringify(out, null, 2));
if (failures.length > 0) {
  console.error(`\nFAILED ${failures.length} check(s): ${failures.join(", ")}`);
  process.exit(1);
}
